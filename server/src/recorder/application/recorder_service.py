from __future__ import annotations

import collections
import logging
import queue
import re
import threading
import time
from types import TracebackType
from typing import TYPE_CHECKING, Any

import numpy as np

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.building_blocks.types import AudioChunk, BufferSize, SampleRate

if TYPE_CHECKING:
    from src.building_blocks.types import TextCallback
from src.recorder.application.pipeline import RecordingPipeline
from src.recorder.domain.audio_buffer import AudioBuffer
from src.recorder.domain.config import RecorderConfig
from src.recorder.domain.events import (
    RealtimeTranscriptionUpdate,
    TranscriptionCompleted,
    TranscriptionStarted,
)
from src.recorder.domain.ports.audio_source import IAudioSource
from src.recorder.domain.ports.transcriber import ITranscriber
from src.recorder.domain.ports.vad import IVoiceActivityDetector
from src.recorder.domain.ports.wake_word import IWakeWordDetector
from src.recorder.domain.state_machine import RecorderState, RecorderStateMachine

logger = logging.getLogger(__name__)


class RecorderService:
    def __init__(
        self,
        *,
        audio_source: IAudioSource,
        vad: IVoiceActivityDetector,
        transcriber: ITranscriber,
        wake_word_detector: IWakeWordDetector | None = None,
        realtime_transcriber: ITranscriber | None = None,
        config: RecorderConfig,
        event_bus: EventBus,
        clock: Clock | None = None,
    ) -> None:
        self._audio_source = audio_source
        self._vad = vad
        self._transcriber = transcriber
        self._wake_word_detector = wake_word_detector
        self._realtime_transcriber = realtime_transcriber
        self._config = config
        self._event_bus = event_bus
        self._clock = clock if clock is not None else Clock.system_clock()

        self._state_machine = RecorderStateMachine()
        self._audio_buffer = AudioBuffer(
            sample_rate=SampleRate(config.audio.sample_rate),
            buffer_size=BufferSize(config.audio.buffer_size),
            pre_recording_buffer_duration=config.vad.pre_recording_buffer_duration,
        )

        self._pipeline = RecordingPipeline(
            audio_source=audio_source,
            vad=vad,
            transcriber=transcriber,
            wake_word_detector=wake_word_detector,
            config=config,
            event_bus=event_bus,
            clock=self._clock,
            state_machine=self._state_machine,
            audio_buffer=self._audio_buffer,
        )

        self._is_running = False
        self._microphone_enabled: bool = config.audio.use_microphone
        self._external_audio_mode: bool = False
        self._audio_reader_thread: threading.Thread | None = None
        self._realtime_thread: threading.Thread | None = None
        self._transcription_result: queue.Queue[str] = queue.Queue()
        self._feed_buffer = bytearray()
        self._transcriber_lock = threading.Lock()

    def text(self, on_transcription_finished: TextCallback | None = None) -> str:
        self.listen()
        if not self.wait_audio():
            self._audio_buffer.clear()
            return ""
        raw_audio = b"".join(self._audio_buffer.frames)
        audio = self._audio_buffer.get_audio_array()
        self._audio_buffer.clear()
        self._event_bus.publish(TranscriptionStarted(timestamp=self._clock.get_current_time(), audio=raw_audio))

        with self._transcriber_lock:
            result = self._transcriber.transcribe(audio, self._config.transcription.language)
        text = self._preprocess_output(result.text)

        self._event_bus.publish(TranscriptionCompleted(timestamp=self._clock.get_current_time(), text=text))

        if self._state_machine.state == RecorderState.TRANSCRIBING:
            self._state_machine.transition(RecorderState.INACTIVE)

        if on_transcription_finished is not None:
            threading.Thread(target=on_transcription_finished, args=(text,), daemon=True).start()

        return text

    def start(self) -> RecorderService:
        self._pipeline.request_start()
        return self

    def stop(
        self,
        backdate_stop_seconds: float = 0.0,
        backdate_resume_seconds: float = 0.0,
    ) -> RecorderService:
        self._pipeline.request_stop(backdate_seconds=backdate_stop_seconds)
        return self

    def listen(self) -> None:
        if not self._is_running:
            self._start_pipeline()
        self._pipeline.request_listen()

    def feed_audio(
        self,
        chunk: AudioChunk | np.ndarray[Any, Any],
        original_sample_rate: int = 16000,
    ) -> None:
        if isinstance(chunk, np.ndarray):
            arr: np.ndarray[Any, Any] = chunk
            if arr.ndim == 2:
                arr = np.mean(arr, axis=1)
            if original_sample_rate != self._config.audio.sample_rate:
                from scipy.signal import resample

                num_samples = int(len(arr) * self._config.audio.sample_rate / original_sample_rate)
                arr = resample(arr, num_samples)
            arr = arr.astype(np.int16)
            chunk = bytes(arr.tobytes())

        # Buffer small chunks before feeding the pipeline (Silero VAD
        # needs exactly buffer_size samples = buffer_size*2 bytes).
        # Matches the monolith: buf_size = 2 * buffer_size (in bytes).
        self._feed_buffer += chunk
        buf_size = 2 * self._config.audio.buffer_size  # 2 bytes per int16 sample
        while len(self._feed_buffer) >= buf_size:
            to_process = bytes(self._feed_buffer[:buf_size])
            self._feed_buffer = self._feed_buffer[buf_size:]
            self._pipeline.feed_audio(to_process)

    def set_microphone(self, microphone_on: bool = True) -> None:
        """Toggle microphone on/off.

        Mirrors the monolith: the audio stream stays open so the reader
        thread keeps draining the OS buffer.  When *off*, chunks are
        simply discarded instead of being fed to the pipeline.
        """
        self._microphone_enabled = microphone_on

    def clear_feed_buffer(self) -> None:
        """Discard any partial audio data buffered by ``feed_audio``."""
        self._feed_buffer = bytearray()

    def set_external_audio_mode(self, active: bool) -> None:
        """Enable/disable external audio mode (e.g. loopback capture).

        When active, the audio reader thread drains the OS buffer but
        discards frames instead of injecting silence.  This prevents
        silence frames from interleaving with externally fed audio and
        disrupting VAD speech detection.
        """
        self._external_audio_mode = active

    def shutdown(self) -> None:
        self._is_running = False
        self._pipeline.stop(timeout=2.0)
        self._audio_source.cleanup()
        if self._audio_reader_thread is not None:
            self._audio_reader_thread.join(timeout=2.0)
            self._audio_reader_thread = None
        if self._realtime_thread is not None:
            self._realtime_thread.join(timeout=2.0)
            self._realtime_thread = None
        self._transcriber.shutdown()
        if self._realtime_transcriber:
            self._realtime_transcriber.shutdown()
        if self._wake_word_detector:
            self._wake_word_detector.cleanup()
        self._state_machine.abort()

    def warmup(self) -> None:
        """Run a dummy inference to eagerly compile CUDA kernels.

        Call once after construction so the first real transcription
        doesn't pay the JIT-compilation cost.
        """
        dummy = np.zeros(16000, dtype=np.float32)  # 1 s silence @ 16 kHz
        lang = self._config.transcription.language
        self._transcriber.transcribe(dummy, lang)
        if self._realtime_transcriber is not None:
            self._realtime_transcriber.transcribe(dummy, lang)

    def abort(self) -> None:
        self._pipeline.request_abort()
        # Put a sentinel on the queue to unblock wait_audio() immediately
        self._pipeline.transcription_queue.put_nowait(None)

    def wait_audio(self) -> bool:
        """Block until the pipeline signals a recording is ready.

        Returns ``True`` when audio is ready for transcription,
        ``False`` on timeout (no recording was produced).

        Uses short polling intervals so Ctrl+C is not blocked on Windows
        (``queue.get`` with a long timeout swallows ``KeyboardInterrupt``).
        """
        deadline = time.time() + 60.0
        while time.time() < deadline:
            try:
                item = self._pipeline.transcription_queue.get(timeout=0.1)
                if item is None:
                    return False  # Abort sentinel
                return True
            except queue.Empty:
                continue
        logger.debug("Timed out waiting for audio transcription trigger")
        return False

    def wakeup(self) -> None:
        self._pipeline.request_listen()

    def clear_audio_queue(self) -> None:
        self._audio_buffer.clear()

    def transcribe(self) -> str:
        audio = self._audio_buffer.get_audio_array()
        with self._transcriber_lock:
            result = self._transcriber.transcribe(audio, self._config.transcription.language)
        return self._preprocess_output(result.text)

    def swap_transcriber(self, new: ITranscriber) -> None:
        with self._transcriber_lock:
            old = self._transcriber
            self._transcriber = new
        old.shutdown()

    @property
    def state(self) -> RecorderState:
        return self._state_machine.state

    @property
    def is_recording(self) -> bool:
        return self._state_machine.is_recording

    @property
    def post_speech_silence_duration(self) -> float:
        return self._pipeline.post_speech_silence_duration

    @post_speech_silence_duration.setter
    def post_speech_silence_duration(self, value: float) -> None:
        self._pipeline.post_speech_silence_duration = value

    @property
    def frames(self) -> list[AudioChunk]:
        return self._pipeline.frames

    @property
    def last_words_buffer(self) -> collections.deque[AudioChunk]:
        return self._pipeline.last_words_buffer

    @property
    def wake_word_activation_delay(self) -> float:
        return self._pipeline.wake_word_activation_delay

    @wake_word_activation_delay.setter
    def wake_word_activation_delay(self, value: float) -> None:
        self._pipeline.wake_word_activation_delay = value

    @property
    def use_microphone(self) -> bool:
        return self._microphone_enabled

    def _start_pipeline(self) -> None:
        if self._config.audio.use_microphone:
            self._audio_source.setup()
        self._pipeline.start()
        self._is_running = True
        if self._config.audio.use_microphone:
            self._audio_reader_thread = threading.Thread(target=self._audio_reader_loop, daemon=True)
            self._audio_reader_thread.start()
        rt_enabled = self._config.realtime.enable_realtime_transcription
        rt_has_transcriber = self._realtime_transcriber is not None
        if rt_enabled and rt_has_transcriber:
            self._realtime_thread = threading.Thread(target=self._realtime_worker, daemon=True)
            self._realtime_thread.start()
            logger.warning("Realtime worker STARTED (model=%s)", self._config.realtime.realtime_model_type)
        else:
            logger.warning(
                "Realtime worker NOT started (enabled=%s, has_transcriber=%s)",
                rt_enabled,
                rt_has_transcriber,
            )

    def _realtime_worker(self) -> None:
        """Periodically transcribe accumulated audio for live display.

        Mirrors the monolith's ``_realtime_worker``: while recording is
        active, snapshot the frame buffer every ``realtime_processing_pause``
        seconds, run the realtime model, and publish the interim text.
        """
        assert self._realtime_transcriber is not None
        rt_config = self._config.realtime
        last_transcription = time.time()
        recording_seen_at: float | None = None

        while self._is_running:
            if not self._state_machine.is_recording:
                recording_seen_at = None
                time.sleep(0.01)
                continue

            if recording_seen_at is None:
                recording_seen_at = time.time()

            # Respect init delay before first realtime transcription
            if time.time() - recording_seen_at < rt_config.init_realtime_after_seconds:
                time.sleep(0.001)
                continue

            # Wait for the processing pause interval
            if time.time() - last_transcription < rt_config.realtime_processing_pause:
                time.sleep(0.001)
                continue

            last_transcription = time.time()

            frames = self._audio_buffer.frames
            if not frames:
                continue

            audio_array = self._audio_buffer.get_audio_array()
            if len(audio_array) == 0:  # pragma: no cover
                continue

            try:
                with self._transcriber_lock:
                    result = self._realtime_transcriber.transcribe(
                        audio_array,
                        self._config.transcription.language,
                    )
                text = self._preprocess_output(result.text)
                if self._state_machine.is_recording:  # pragma: no branch
                    self._event_bus.publish(
                        RealtimeTranscriptionUpdate(timestamp=self._clock.get_current_time(), text=text)
                    )
            except Exception:
                logger.exception("Realtime transcription error")

    def _audio_reader_loop(self) -> None:
        """Read chunks from the audio source and feed the pipeline.

        The stream is always drained so the OS buffer doesn't overflow.
        When the microphone is logically disabled, silence frames are
        fed instead so the pipeline/VAD can still detect the speech →
        silence transition (required for push-to-talk).
        """
        while self._is_running:
            try:
                chunk = self._audio_source.read_chunk()
            except Exception:
                if not self._is_running:
                    break
                logger.debug("Audio reader: error reading chunk", exc_info=True)
                continue
            if self._microphone_enabled:
                self._pipeline.feed_audio(chunk)
            elif not self._external_audio_mode:
                # Inject silence so VAD detects end-of-speech (PTT mode).
                # In external audio mode we just drain — the loopback
                # thread is the sole audio source.
                self._pipeline.feed_audio(b"\x00" * len(chunk))

    def _preprocess_output(self, text: str) -> str:
        text = re.sub(r"\s+", " ", text.strip())
        if self._config.ui.ensure_sentence_starting_uppercase and text:
            text = text[0].upper() + text[1:]
        if self._config.ui.ensure_sentence_ends_with_period and text and text[-1].isalnum():
            text += "."
        return text

    def __enter__(self) -> RecorderService:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        self.shutdown()
