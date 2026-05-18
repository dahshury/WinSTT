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
        # How long after a wake-word fires the recorder stays armed for the
        # follow-up utterance. If the user doesn't speak within this window
        # the gate clears and they must say the wake word again. Mirrors the
        # monolith's `wake_word_timeout`.
        self._wake_word_timeout: float = config.wake_word.wake_word_timeout

        self._audio_queue: queue.Queue[AudioChunk] = queue.Queue()
        self._recording_start_time: float = 0.0
        self._speech_end_silence_start: float = 0.0
        self._listen_start: float = 0.0
        self._wakeword_detected: bool = False
        # Timestamp of the most recent wake-word fire (or 0.0 when not armed).
        # Read by `_maybe_expire_wake_word` to clear the gate after the
        # follow-up window elapses without speech.
        self._wakeword_detected_at: float = 0.0
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
        # When a wake-word backend is configured, VAD onset MUST stay disarmed
        # until the detector fires (`_wakeword_detected = True`). Otherwise the
        # very first speech chunk would trigger `_try_start_on_voice_activity`
        # and the wake word would never matter — the recorder would behave like
        # plain listen-on-speech. The wake-word detector arms VAD onset itself
        # via `_vad_onset_armed()` once it sees the trigger word; we just stop
        # forcing the gate open here.
        if not self._use_wake_words:
            self._start_recording_on_voice_activity = True
        self._event_bus.publish(VADDetectStarted(timestamp=self._clock.get_current_time()))

    def _enter_recording_state(self) -> None:
        if self._sm.state in (RecorderState.INACTIVE, RecorderState.WAKEWORD):
            self._sm.transition(RecorderState.LISTENING)
        if self._sm.state == RecorderState.LISTENING:
            self._sm.transition(RecorderState.RECORDING)

    def request_start(self) -> None:
        self._enter_recording_state()
        self._recording_start_time = self._clock.get_current_time()
        self._buffer.start_recording()
        self._stop_recording_on_voice_deactivity = True
        self._speech_detected_in_recording = False
        self._event_bus.publish(RecordingStarted(timestamp=self._clock.get_current_time()))

    def _emit_no_audio(self) -> None:
        self._event_bus.publish(NoAudioDetected(timestamp=self._clock.get_current_time()))

    def _emit_no_audio_if_ptt(self) -> None:
        if not self._silence_endpoint_enabled:
            self._emit_no_audio()

    def _is_stop_blocked(self) -> bool:
        if not self._sm.is_recording:
            self._emit_no_audio_if_ptt()
            return True
        elapsed = self._clock.get_current_time() - self._recording_start_time
        if elapsed < self._config.vad.min_length_of_recording:
            self._emit_no_audio_if_ptt()
            return True
        return False

    def _is_ptt_stop_without_speech(self) -> bool:
        return not self._silence_endpoint_enabled and not self._speech_detected_in_recording

    def request_stop(self, backdate_seconds: float = 0.0) -> None:
        if self._is_stop_blocked():
            return
        if self._is_ptt_stop_without_speech():
            self._emit_no_audio()
            self.request_abort()
            return
        self._finalize_stop(backdate_seconds)

    def _finalize_stop(self, backdate_seconds: float) -> None:
        if backdate_seconds > 0:
            self._buffer.backdate(backdate_seconds)
        elapsed = self._clock.get_current_time() - self._recording_start_time
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
        # Re-arm the wake-word gate for the next session. Without this reset,
        # a one-time wake-word detection would unlock VAD onset *forever* —
        # every subsequent utterance would auto-record without the user saying
        # the trigger word again. Mirrors the monolith's per-cycle reset.
        self._wakeword_detected = False
        self._wakeword_detected_at = 0.0
        self._event_bus.publish(RecordingStopped(timestamp=self._clock.get_current_time()))
        self._transcription_queue.put((True, backdate_seconds))

    def request_abort(self) -> None:
        self._sm.abort()
        self._buffer.clear()
        self._stop_recording_on_voice_deactivity = False
        self._speech_end_silence_start = 0.0
        self._speech_detected_in_recording = False
        self._wakeword_detected = False
        self._wakeword_detected_at = 0.0

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

    def _dispatch_chunk(self, chunk: AudioChunk) -> None:
        if self._sm.is_recording:
            self._process_recording(chunk)
        else:
            self._process_not_recording(chunk)

    def _handle_chunk(self, chunk: AudioChunk) -> None:
        try:
            self._event_bus.publish(AudioChunkRecorded(timestamp=self._clock.get_current_time(), chunk=chunk))
            samples = np.frombuffer(chunk, dtype=np.int16).astype(np.float32)
            rms = float(np.sqrt(np.mean(samples * samples)))
            level = min(1.0, rms / 10000.0)
            self._event_bus.publish(AudioLevelComputed(timestamp=self._clock.get_current_time(), level=level))
            self._buffer.add_to_last_words(chunk)
            self._dispatch_chunk(chunk)
        except Exception:
            logger.exception("Pipeline error processing audio chunk (length: %d bytes)", len(chunk))
            # Continue processing - one bad chunk shouldn't crash the pipeline

    @override
    def _run(self) -> None:
        while not self.should_stop:
            try:
                chunk = self._audio_queue.get(timeout=0.01)
            except queue.Empty:
                continue
            self._handle_chunk(chunk)

    def _maybe_expire_wake_word(self) -> None:
        """Clear the wake-word gate if the follow-up window has elapsed.

        Without this, a wake-word fire stays armed indefinitely — the user
        could trigger detection at 9am and have any speech at 3pm start a
        recording. The timeout matches `wake_word_timeout` from config and
        mirrors the monolith's behaviour.
        """
        if self._wake_word_gate_expired():
            self._wakeword_detected = False
            self._wakeword_detected_at = 0.0

    def _wake_word_gate_expired(self) -> bool:
        """Whether an armed wake-word gate has outlived its follow-up window."""
        if not self._wakeword_detected or self._wake_word_timeout <= 0:
            return False
        elapsed = self._clock.get_current_time() - self._wakeword_detected_at
        return elapsed >= self._wake_word_timeout

    def _maybe_detect_wake_word(self, chunk: AudioChunk) -> None:
        self._maybe_expire_wake_word()
        if self._use_wake_words and not self._wakeword_detected:
            self._process_wake_word(chunk)

    def _vad_onset_armed(self) -> bool:
        return self._start_recording_on_voice_activity or self._wakeword_detected

    def _try_start_on_voice_activity(self, chunk: AudioChunk) -> bool:
        if not self._vad_onset_armed():
            return False
        if not self._vad.detect(chunk).is_speech:
            return False
        self._event_bus.publish(VADStarted(timestamp=self._clock.get_current_time()))
        self.request_start()
        self._speech_detected_in_recording = True
        self._start_recording_on_voice_activity = False
        return True

    def _process_not_recording(self, chunk: AudioChunk) -> None:
        self._maybe_detect_wake_word(chunk)
        if self._try_start_on_voice_activity(chunk):
            return
        self._buffer.add_to_pre_roll(chunk)

    def _begin_silence_turn(self) -> None:
        if self._speech_end_silence_start == 0.0:
            self._speech_end_silence_start = self._clock.get_current_time()
            self._event_bus.publish(TurnDetectionStarted(timestamp=self._clock.get_current_time()))

    def _maybe_fire_silence_end(self) -> None:
        silence_duration = self._clock.get_current_time() - self._speech_end_silence_start
        if silence_duration >= self._post_speech_silence_duration:
            logger.warning(
                "[pipeline] VAD silence-end firing: silence=%.2fs >= threshold=%.2fs",
                silence_duration,
                self._post_speech_silence_duration,
            )
            self._event_bus.publish(VADStopped(timestamp=self._clock.get_current_time()))
            self.request_stop()

    def _handle_silence(self) -> None:
        elapsed = self._clock.get_current_time() - self._recording_start_time
        if elapsed < self._config.vad.min_length_of_recording:
            return
        self._begin_silence_turn()
        self._maybe_fire_silence_end()

    def _handle_speech_resumed(self) -> None:
        if self._speech_end_silence_start != 0.0:
            self._speech_end_silence_start = 0.0
            self._event_bus.publish(TurnDetectionStopped(timestamp=self._clock.get_current_time()))

    def _track_turn_endpoint(self, is_speech: bool) -> None:
        if not is_speech:
            self._handle_silence()
        else:
            self._handle_speech_resumed()

    def _evaluate_recording_vad(self, chunk: AudioChunk) -> None:
        is_speech = self._vad.detect(chunk).is_speech
        if is_speech:
            self._speech_detected_in_recording = True
        if not self._silence_endpoint_enabled:
            return
        self._track_turn_endpoint(is_speech)

    def _process_recording(self, chunk: AudioChunk) -> None:
        self._buffer.add_frame(chunk)
        if self._stop_recording_on_voice_deactivity:
            self._evaluate_recording_vad(chunk)

    def _process_wake_word(self, chunk: AudioChunk) -> None:
        if self._wake_word_detector is None:
            return
        result = self._wake_word_detector.detect(chunk)
        if result.detected:
            self._wakeword_detected = True
            self._wakeword_detected_at = self._clock.get_current_time()
            self._event_bus.publish(
                WakeWordDetected(
                    timestamp=self._clock.get_current_time(),
                    word_index=result.word_index,
                    word=result.word,
                )
            )
