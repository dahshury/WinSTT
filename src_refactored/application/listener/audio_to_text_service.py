from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING, Protocol

from src_refactored.infrastructure.adapters.logging_adapter import PythonLoggingAdapter
from src_refactored.infrastructure.audio.pyaudio_service import (
    PyAudioRecorder,  # reuse recorder facade
)
from src_refactored.infrastructure.audio.sounddevice_sound_player_adapter import (
    SoundDeviceSoundPlayerAdapter,
)
from src_refactored.infrastructure.common.threading_service import ThreadingService
from src_refactored.infrastructure.common.time_service import TimeService
from src_refactored.infrastructure.system_integration.keyboard_hook_adapter import (
    KeyboardHookAdapter,
)
from src_refactored.infrastructure.system_integration.pynput_keyboard_adapter import (
    PynputKeyboardAdapter,
)
from src_refactored.infrastructure.system_integration.pyperclip_adapter import PyperclipAdapter

if TYPE_CHECKING:
    from collections.abc import Callable

    from src_refactored.application.listener.audio_to_text_config import AudioToTextConfig


class VADProtocol(Protocol):
    def has_speech(self, wav_like) -> bool: ...


class TranscriberProtocol(Protocol):
    def transcribe(self, wav_like) -> str: ...


class AudioToTextService:
    """Hexagonal service orchestrating hotkey capture, record, VAD, transcribe, paste."""

    def __init__(
        self,
        config: AudioToTextConfig,
        transcriber: TranscriberProtocol,
        vad: VADProtocol,
        logger: PythonLoggingAdapter | None = None,
        keyboard: KeyboardHookAdapter | None = None,
        on_transcription_complete: Callable[[str], None] | None = None,
    ) -> None:
        self._config = config
        self._transcriber = transcriber
        self._vad = vad
        self._logger = (logger or PythonLoggingAdapter()).setup_logger()

        self._recorder = PyAudioRecorder(chunk=256, channels=config.channels, rate=config.rate)
        self._sound = SoundDeviceSoundPlayerAdapter()
        self._threads = ThreadingService()
        self._time = TimeService()
        self._kb = keyboard or KeyboardHookAdapter()
        self._key_sim = PynputKeyboardAdapter()
        self._clipboard = PyperclipAdapter()
        self._on_complete = on_transcription_complete

        self._is_recording = False
        self._start_time = 0.0
        self._transcription_thread = None

    def initialize_hotkey(self) -> None:
        self._kb.start()
        self._kb.unregister_hotkey("att_hotkey")

        def _pressed(_):
            if not self._is_recording:
                self.start_recording()

        def _released(_):
            if self._is_recording:
                self.stop_recording()

        if not self._kb.register_hotkey("att_hotkey", self._config.rec_key, _pressed, _released):
            self._logger.warning("Invalid hotkey: %s", self._config.rec_key)
        # Pre-warm recorder and start sound to minimize first-use latency
        try:
            # Prime PyAudio's backend with a no-op open/close in background
            def _prime_recorder() -> None:
                try:
                    # Open and immediately close a tiny stream to prime driver
                    self._recorder.start()
                except Exception:
                    pass
                finally:
                    with contextlib.suppress(Exception):
                        self._recorder.stop()

            self._threads.start_daemon(_prime_recorder)

            if self._config.start_sound_file:
                self._sound.ensure_initialized()
                if self._sound.load(self._config.start_sound_file):
                    self._sound.prepare()
        except Exception:
            self._logger.debug("Pre-warm of start sound failed", exc_info=True)

    def start_recording(self) -> None:
        self._is_recording = True
        self._start_time = self._time.now_seconds()
        try:
            # Play the start sound immediately, then start the recorder (which may block briefly)
            if self._config.start_sound_file:
                self._sound.ensure_initialized()
                if self._sound.load(self._config.start_sound_file):
                    self._sound.prepare()
                    self._threads.start_daemon(self._sound.play)
            # Start recording after triggering the beep to avoid perceived latency
            self._recorder.start()
        except Exception:
            self._is_recording = False
            self._logger.exception("Cannot start recording")

    def stop_recording(self) -> None:
        self._recorder.stop()
        self._is_recording = False
        duration = self._time.now_seconds() - self._start_time
        if duration < self._config.minimum_duration_seconds:
            self._logger.warning(
                "Recording too short (%.2fs). Minimum is %ss",
                duration,
                self._config.minimum_duration_seconds,
            )
            return

        try:
            wav_bytes = self._recorder.get_wav_bytes()
            self._transcription_thread = self._threads.start_daemon(self._transcribe_and_paste, wav_bytes)
        except Exception:
            self._logger.exception("Transcription error")

    def _transcribe_and_paste(self, wav_bytes: bytes) -> None:
        from src_refactored.infrastructure.common.bytes_io_adapter import BytesIOAdapter
        buf = BytesIOAdapter().from_bytes(wav_bytes)
        if not self._vad.has_speech(buf):
            self._logger.warning("No speech detected in the recording.")
            # Notify completion so UI clears transcribing state
            try:
                if self._on_complete:
                    # Send a non-empty but benign message so UI clears
                    self._on_complete("Ready for transcription")
            except Exception:
                self._logger.debug("Retry after init failed", exc_info=True)
            return
        buf.seek(0)
        text = self._transcriber.transcribe(buf)
        if text is None:
            text = ""
        if "Service not initialized" in text:
            # Attempt one retry after initializing service lazily via adapter
            try:
                buf.seek(0)
                text = self._transcriber.transcribe(buf) or ""
            except Exception:
                pass
        # Normalize text like legacy
        normalized = (text or "").replace("New paragraph.", "\n\n").strip()
        if not normalized:
            self._logger.warning("Empty transcription text; skipping paste")
            try:
                if self._on_complete:
                    self._on_complete("Ready for transcription")
            except Exception:
                self._logger.debug("Completion callback failed (empty text)", exc_info=True)
            return
        # Copy and paste with a tiny delay to allow clipboard to update
        copied = self._clipboard.copy_text(normalized)
        if not copied:
            self._logger.warning("Clipboard copy failed; paste will likely fail")
        import time as _t
        _t.sleep(0.08)
        self._key_sim.send_paste()
        # Notify completion to allow UI to clear "Transcribing..." state
        try:
            if self._on_complete:
                self._on_complete(text)
        except Exception:
            # Swallow callback errors to not affect core flow
            self._logger.debug("Completion callback failed", exc_info=True)

    def shutdown(self) -> None:
        try:
            self._recorder.close()
            self._sound.shutdown()
            self._kb.shutdown()
            self._threads.join(self._transcription_thread, timeout=1.0)
        except Exception:
            self._logger.exception("Shutdown error")


