from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING, Protocol

from src.infrastructure.adapters.logging_adapter import PythonLoggingAdapter
from src.infrastructure.audio.pyaudio_service import (
    PyAudioRecorder,  # reuse recorder facade
)
from src.infrastructure.audio.sounddevice_sound_player_adapter import (
    SoundDeviceSoundPlayerAdapter,
)
from src.infrastructure.common.threading_service import ThreadingService
from src.infrastructure.common.time_service import TimeService
from src.infrastructure.system_integration.keyboard_hook_adapter import (
    KeyboardHookAdapter,
)
from src.infrastructure.system_integration.pynput_keyboard_adapter import (
    PynputKeyboardAdapter,
)
from src.infrastructure.system_integration.pyperclip_adapter import PyperclipAdapter

if TYPE_CHECKING:
    from collections.abc import Callable

    from src.application.listener.audio_to_text_config import AudioToTextConfig


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
        # Forward recorder errors as clean log messages (no tracebacks)
        with contextlib.suppress(Exception):
            self._recorder.set_error_callback(self._handle_recorder_error)
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

    @property
    def is_recording(self) -> bool:
        """Public read-only recording state for adapters/controllers."""
        return self._is_recording

    def _handle_recorder_error(self, message: str) -> None:
        """Handle recorder-level errors without printing tracebacks to console."""
        try:
            if not message:
                return
            # Show only a friendly message for missing device cases
            if (
                "No recording device detected" in message
                or "Invalid input device" in message
                or "no default output device" in message
            ):
                self._logger.warning("No recording device detected. Please connect a microphone.")
            else:
                self._logger.error(message)
        except Exception:
            # Never raise from logging
            pass

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
                    # Suppress user-facing errors during prewarm to avoid duplicate warnings
                    with contextlib.suppress(Exception):
                        self._recorder.set_error_callback(lambda _m: None)
                    self._recorder.start()
                except Exception:
                    pass
                finally:
                    with contextlib.suppress(Exception):
                        self._recorder.stop()
                    with contextlib.suppress(Exception):
                        self._recorder.set_error_callback(self._handle_recorder_error)

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
        
        # Play beep immediately on dedicated thread for lowest latency
        if self._config.start_sound_file:
            self._sound.ensure_initialized()
            if self._sound.load(self._config.start_sound_file):
                self._sound.prepare()
                # Start beep immediately on dedicated thread
                self._threads.start_daemon(self._sound.play, name="beep_player")
        
        # Start recording on separate non-blocking thread
        def _start_recording_async():
            try:
                self._recorder.start()
            except Exception as e:
                self._is_recording = False
                msg = str(e)
                if (
                    "No recording device detected" in msg
                    or "Invalid input device" in msg
                    or "no default output device" in msg
                ):
                    # Ensure backend is refreshed so the next attempt uses a newly plugged device
                    with contextlib.suppress(Exception):
                        self._recorder.close(reset=True)
                else:
                    # Log message only (no traceback) for cleaner console output
                    with contextlib.suppress(Exception):
                        self._logger.error("Cannot start recording: %s", msg)
        
        # Start recording async to not block beep
        self._threads.start_daemon(_start_recording_async, name="recorder_starter")

    def stop_recording(self) -> None:
        self._recorder.stop()
        self._is_recording = False
        duration = self._time.now_seconds() - self._start_time
        # Suppress the "too short" warning when no device was available
        if duration < self._config.minimum_duration_seconds:
            if self._has_usable_input_device():
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
        from src.infrastructure.common.bytes_io_adapter import BytesIOAdapter
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

    def _has_usable_input_device(self) -> bool:
        """Lightweight probe for presence of any input-capable device.

        Uses a fresh PyAudio instance to avoid stale device lists and attempts to
        open a short-lived stream to verify real usability. Returns True only if
        at least one input device can be opened successfully.
        """
        try:
            import pyaudio as _pa  # Local import to keep domain clean elsewhere
            pa = _pa.PyAudio()
            try:
                count = pa.get_device_count()
                for idx in range(count):
                    info = pa.get_device_info_by_index(idx)
                    if info.get("maxInputChannels", 0) > 0:
                        # Try to actually open the device to confirm usability
                        try:
                            default_rate = int(info.get("defaultSampleRate", 44100) or 44100)
                            test_stream = pa.open(
                                format=_pa.paInt16,
                                channels=1,
                                rate=default_rate,
                                input=True,
                                input_device_index=idx,
                                frames_per_buffer=256,
                            )
                            test_stream.close()
                            return True
                        except Exception:
                            # Try next device
                            continue
            finally:
                with contextlib.suppress(Exception):
                    pa.terminate()
        except Exception:
            return False
        return False


