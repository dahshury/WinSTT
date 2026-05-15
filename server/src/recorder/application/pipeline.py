from __future__ import annotations

import collections
import logging
import queue

import numpy as np
from typing_extensions import override

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.building_blocks.types import AudioChunk
from src.building_blocks.worker import Worker
from src.recorder.domain.audio_buffer import AudioBuffer
from src.recorder.domain.config import RecorderConfig
from src.recorder.domain.events import (
    AudioChunkRecorded,
    AudioLevelComputed,
    NoAudioDetected,
    RecordingStarted,
    RecordingStopped,
    TurnDetectionStarted,
    TurnDetectionStopped,
    VADDetectStarted,
    VADStarted,
    VADStopped,
    WakeWordDetected,
)
from src.recorder.domain.ports.audio_source import IAudioSource
from src.recorder.domain.ports.transcriber import ITranscriber
from src.recorder.domain.ports.vad import IVoiceActivityDetector
from src.recorder.domain.ports.wake_word import IWakeWordDetector
from src.recorder.domain.state_machine import RecorderState, RecorderStateMachine

logger = logging.getLogger(__name__)


class RecordingPipeline(Worker):
    def __init__(
        self,
        *,
        audio_source: IAudioSource,
        vad: IVoiceActivityDetector,
        transcriber: ITranscriber,
        wake_word_detector: IWakeWordDetector | None,
        config: RecorderConfig,
        event_bus: EventBus,
        clock: Clock,
        state_machine: RecorderStateMachine,
        audio_buffer: AudioBuffer,
    ) -> None:
        super().__init__()
        self._audio_source = audio_source
        self._vad = vad
        self._transcriber = transcriber
        self._wake_word_detector = wake_word_detector
        self._config = config
        self._event_bus = event_bus
        self._clock = clock
        self._sm = state_machine
        self._buffer = audio_buffer

        self._post_speech_silence_duration: float = config.vad.post_speech_silence_duration
        self._wake_word_activation_delay: float = config.wake_word.wake_word_activation_delay

        self._audio_queue: queue.Queue[AudioChunk] = queue.Queue()
        self._recording_start_time: float = 0.0
        self._speech_end_silence_start: float = 0.0
        self._listen_start: float = 0.0
        self._wakeword_detected: bool = False
        self._start_recording_on_voice_activity: bool = False
        self._stop_recording_on_voice_deactivity: bool = False
        self._silence_endpoint_enabled: bool = True
        self._speech_detected_in_recording: bool = False
        self._use_wake_words: bool = bool(config.wake_word.wakeword_backend)
        self._transcription_queue: queue.Queue[tuple[bool, float] | None] = queue.Queue()

    def feed_audio(self, chunk: AudioChunk) -> None:
        self._audio_queue.put(chunk)

    def request_listen(self) -> None:
        self._listen_start = self._clock.get_current_time()
        if self._sm.state == RecorderState.INACTIVE:
            self._sm.transition(RecorderState.LISTENING)
        self._start_recording_on_voice_activity = True
        self._event_bus.publish(VADDetectStarted(timestamp=self._clock.get_current_time()))

    def request_start(self) -> None:
        if self._sm.state == RecorderState.INACTIVE:
            self._sm.transition(RecorderState.LISTENING)
        if self._sm.state == RecorderState.LISTENING:
            self._sm.transition(RecorderState.RECORDING)
        elif self._sm.state == RecorderState.WAKEWORD:
            self._sm.transition(RecorderState.LISTENING)
            self._sm.transition(RecorderState.RECORDING)
        self._recording_start_time = self._clock.get_current_time()
        self._buffer.start_recording()
        self._stop_recording_on_voice_deactivity = True
        self._speech_detected_in_recording = False
        self._event_bus.publish(RecordingStarted(timestamp=self._clock.get_current_time()))

    def request_stop(self, backdate_seconds: float = 0.0) -> None:
        if not self._sm.is_recording:
            if not self._silence_endpoint_enabled:
                self._event_bus.publish(NoAudioDetected(timestamp=self._clock.get_current_time()))
            return
        elapsed = self._clock.get_current_time() - self._recording_start_time
        if elapsed < self._config.vad.min_length_of_recording:
            if not self._silence_endpoint_enabled:
                self._event_bus.publish(NoAudioDetected(timestamp=self._clock.get_current_time()))
            return
        if not self._silence_endpoint_enabled and not self._speech_detected_in_recording:
            self._event_bus.publish(NoAudioDetected(timestamp=self._clock.get_current_time()))
            self.request_abort()
            return
        if backdate_seconds > 0:
            self._buffer.backdate(backdate_seconds)
        logger.warning(
            "[pipeline] request_stop: %.2fs of audio, %d frames, silence_endpoint=%s, backdate=%.2f",
            elapsed,
            self._buffer.frame_count,
            self._silence_endpoint_enabled,
            backdate_seconds,
        )
        self._sm.transition(RecorderState.TRANSCRIBING)
        self._stop_recording_on_voice_deactivity = False
        self._speech_end_silence_start = 0.0
        self._event_bus.publish(RecordingStopped(timestamp=self._clock.get_current_time()))
        self._transcription_queue.put((True, backdate_seconds))

    def request_abort(self) -> None:
        self._sm.abort()
        self._buffer.clear()
        self._stop_recording_on_voice_deactivity = False
        self._speech_end_silence_start = 0.0
        self._speech_detected_in_recording = False
        self._wakeword_detected = False

    @property
    def post_speech_silence_duration(self) -> float:
        return self._post_speech_silence_duration

    @post_speech_silence_duration.setter
    def post_speech_silence_duration(self, value: float) -> None:
        self._post_speech_silence_duration = value

    @property
    def silence_endpoint_enabled(self) -> bool:
        return self._silence_endpoint_enabled

    @silence_endpoint_enabled.setter
    def silence_endpoint_enabled(self, value: bool) -> None:
        self._silence_endpoint_enabled = value

    @property
    def transcription_queue(self) -> queue.Queue[tuple[bool, float] | None]:
        return self._transcription_queue

    @property
    def frames(self) -> list[AudioChunk]:
        return self._buffer.frames

    @property
    def last_words_buffer(self) -> collections.deque[AudioChunk]:
        return self._buffer.last_words_buffer

    @property
    def wake_word_activation_delay(self) -> float:
        return self._wake_word_activation_delay

    @wake_word_activation_delay.setter
    def wake_word_activation_delay(self, value: float) -> None:
        self._wake_word_activation_delay = value

    @override
    def _run(self) -> None:
        while not self.should_stop:
            try:
                chunk = self._audio_queue.get(timeout=0.01)
            except queue.Empty:
                continue

            try:
                self._event_bus.publish(AudioChunkRecorded(timestamp=self._clock.get_current_time(), chunk=chunk))
                samples = np.frombuffer(chunk, dtype=np.int16).astype(np.float32)
                rms = float(np.sqrt(np.mean(samples * samples)))
                level = min(1.0, rms / 10000.0)
                self._event_bus.publish(AudioLevelComputed(timestamp=self._clock.get_current_time(), level=level))
                self._buffer.add_to_last_words(chunk)

                if self._sm.is_recording:
                    self._process_recording(chunk)
                else:
                    self._process_not_recording(chunk)
            except Exception:
                logger.exception("Pipeline error processing audio chunk (length: %d bytes)", len(chunk))
                # Continue processing - one bad chunk shouldn't crash the pipeline

    def _process_not_recording(self, chunk: AudioChunk) -> None:
        if self._use_wake_words and not self._wakeword_detected:
            self._process_wake_word(chunk)

        if self._start_recording_on_voice_activity or self._wakeword_detected:
            vad_result = self._vad.detect(chunk)
            if vad_result.is_speech:
                self._event_bus.publish(VADStarted(timestamp=self._clock.get_current_time()))
                self.request_start()
                self._speech_detected_in_recording = True
                self._start_recording_on_voice_activity = False
                return

        self._buffer.add_to_pre_roll(chunk)

    def _process_recording(self, chunk: AudioChunk) -> None:
        self._buffer.add_frame(chunk)

        if not self._stop_recording_on_voice_deactivity:
            return

        vad_result = self._vad.detect(chunk)

        if vad_result.is_speech:
            self._speech_detected_in_recording = True

        if not self._silence_endpoint_enabled:
            return

        if not vad_result.is_speech:
            elapsed = self._clock.get_current_time() - self._recording_start_time
            if elapsed < self._config.vad.min_length_of_recording:
                return

            if self._speech_end_silence_start == 0.0:
                self._speech_end_silence_start = self._clock.get_current_time()
                self._event_bus.publish(TurnDetectionStarted(timestamp=self._clock.get_current_time()))

            silence_duration = self._clock.get_current_time() - self._speech_end_silence_start
            if silence_duration >= self._post_speech_silence_duration:
                logger.warning(
                    "[pipeline] VAD silence-end firing: silence=%.2fs >= threshold=%.2fs",
                    silence_duration,
                    self._post_speech_silence_duration,
                )
                self._event_bus.publish(VADStopped(timestamp=self._clock.get_current_time()))
                self.request_stop()
        else:
            if self._speech_end_silence_start != 0.0:
                self._speech_end_silence_start = 0.0
                self._event_bus.publish(TurnDetectionStopped(timestamp=self._clock.get_current_time()))

    def _process_wake_word(self, chunk: AudioChunk) -> None:
        if self._wake_word_detector is None:
            return
        result = self._wake_word_detector.detect(chunk)
        if result.detected:
            self._wakeword_detected = True
            self._event_bus.publish(
                WakeWordDetected(
                    timestamp=self._clock.get_current_time(),
                    word_index=result.word_index,
                    word=result.word,
                )
            )
