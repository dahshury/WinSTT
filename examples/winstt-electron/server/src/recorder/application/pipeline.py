from __future__ import annotations

import collections
import dataclasses
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


@dataclasses.dataclass(frozen=True)
class _StopMarker:
    """End-of-recording sentinel pushed onto the audio queue.

    Lets a user-driven stop (PTT release) be ordered AFTER every audio chunk
    already queued: the worker buffers those chunks first, then sees the
    marker and finalizes — so the tail captured right up to release isn't
    dropped. See :meth:`RecordingPipeline.request_stop_via_queue`.
    """

    backdate_seconds: float = 0.0


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

        # Leading-silence carry-forward. The deque holds the
        # most recent N silence-classified chunks while not recording. On
        # the transition INACTIVE/LISTENING → RECORDING the deque contents
        # are PREPENDED to the recording so the Whisper encoder sees the
        # silence→speech boundary, giving weak starting consonants the
        # context they need to survive far-mic acoustics. ``maxlen`` is
        # derived from chunk_duration_ms = buffer_size / sample_rate;
        # 0-ms (disabled) yields maxlen=0 (the deque accepts and discards
        # immediately, which is cheaper than guarding every append).
        # This is the ``prefill_frames`` mechanism.
        self._silence_prefill: collections.deque[AudioChunk] = collections.deque(
            maxlen=self._compute_silence_prefill_maxlen(config),
        )

        self._audio_queue: queue.Queue[AudioChunk | _StopMarker] = queue.Queue()
        self._recording_start_time: float = 0.0
        self._speech_end_silence_start: float = 0.0
        self._listen_start: float = 0.0
        self._wakeword_detected: bool = False
        # Timestamp of the most recent wake-word fire (or 0.0 when not armed).
        # Read by `_maybe_expire_wake_word` to clear the gate after the
        # follow-up window elapses without speech.
        self._wakeword_detected_at: float = 0.0
        self._start_recording_on_voice_activity: bool = False
        # Speech-onset debounce: require this many CONSECUTIVE speech chunks
        # on the VAD-onset path before committing to a recording, so a single
        # noisy chunk can't pop the overlay or wake Whisper. See
        # ``VADConfig.speech_onset_consecutive_chunks``.
        self._speech_onset_required: int = config.vad.speech_onset_consecutive_chunks
        self._consecutive_speech_chunks: int = 0
        self._stop_recording_on_voice_deactivity: bool = False
        self._silence_endpoint_enabled: bool = True
        self._speech_detected_in_recording: bool = False
        self._use_wake_words: bool = bool(config.wake_word.wakeword_backend)
        self._transcription_queue: queue.Queue[tuple[bool, float] | None] = queue.Queue()

    @staticmethod
    def _compute_silence_prefill_maxlen(config: RecorderConfig) -> int:
        """Translate vad_prefill_ms into a chunk count for the prefill deque.

        ``chunk_duration_ms = buffer_size / sample_rate * 1000``. At the
        defaults (512 / 16000 = 32 ms) and prefill=450 ms this resolves to
        ``ceil(450 / 32) = 15`` chunks — matching the hardcoded
        ``prefill_frames=15``. We round UP so we don't accidentally
        truncate the prefill window when the buffer size doesn't divide
        the prefill cleanly; an extra chunk of silence costs negligible
        Whisper encoder time but a missing one re-introduces the bug.
        """
        prefill_ms = config.vad.vad_prefill_ms
        if prefill_ms <= 0:
            return 0
        sample_rate = max(1, config.audio.sample_rate)
        buffer_size = max(1, config.audio.buffer_size)
        chunk_ms = (buffer_size * 1000.0) / sample_rate
        # Unreachable today: sample_rate and buffer_size are both clamped to
        # >= 1 just above, so (buffer_size * 1000.0) / sample_rate is always
        # strictly positive. Kept as a defensive guard against a future
        # refactor that drops those clamps — hence excluded from coverage
        # rather than covered by a test that cannot construct the input.
        if chunk_ms <= 0:  # pragma: no cover
            return 0
        # math.ceil without importing math — int(x) + (1 if x % 1 else 0)
        return RecordingPipeline._ceil_ratio(prefill_ms / chunk_ms)

    @staticmethod
    def _ceil_ratio(ratio: float) -> int:
        """math.ceil for a non-negative float without importing math."""
        count = int(ratio)
        if ratio > count:
            count += 1
        return count

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
        self._consecutive_speech_chunks = 0
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
        # PREPEND the silence-prefill deque so the Whisper encoder sees
        # the silence→speech boundary. ``start_recording`` above just
        # promoted the pre-roll into ``_frames``; we splice the silence
        # prefill in front of it. ``start_recording`` already cleared
        # the pre-roll, but we still need to clear the silence_prefill
        # ourselves — otherwise the next utterance double-prepends the
        # same silence frames. Order: silence_prefill || pre_roll ||
        # recording frames (rightmost is most recent).
        self._splice_silence_prefill_in_front()
        self._stop_recording_on_voice_deactivity = True
        self._speech_detected_in_recording = False
        self._consecutive_speech_chunks = 0
        self._event_bus.publish(RecordingStarted(timestamp=self._clock.get_current_time()))

    def _splice_silence_prefill_in_front(self) -> None:
        """Prepend the silence-prefill deque to the recording frames buffer.

        Called from ``request_start`` immediately after the pre-roll is
        promoted into ``_frames``. The audio_buffer exposes ``frames``
        as a list, so we splice via re-assignment. Clears the prefill
        deque so the next recording doesn't double-count these frames.
        Pre-roll and prefill overlap in content for the VAD-onset path
        (both capture the same silence chunks) — that's deliberate. The
        prefill is the explicit MINIMUM 450 ms silence guarantee even
        when pre_recording_buffer_duration is shortened, and pre-roll
        adds whatever extra context fits in its wider window. Whisper's
        encoder is robust to a few hundred ms of redundant silence —
        what matters is that the silence→speech transition is present.
        """
        if not self._silence_prefill:
            return
        prefill_frames = list(self._silence_prefill)
        self._silence_prefill.clear()
        # Splice into the buffer's frame list. We touch ``_frames``
        # via the public ``frames`` property only for the read; the
        # write goes through ``add_frame`` so the buffer's internal
        # invariants stay owned by AudioBuffer. We rebuild the list
        # rather than insert-at-zero to keep the operation O(n) once.
        existing = list(self._buffer.frames)
        # The cheapest way to splice with current AudioBuffer surface
        # is to clear + re-add. ``clear`` resets pre_roll too but
        # that's already empty post start_recording.
        self._buffer.clear()
        self._refill_buffer_frames(prefill_frames + existing)

    def _refill_buffer_frames(self, frames: list[AudioChunk]) -> None:
        """Re-add ``frames`` to the (already-cleared) audio buffer in order."""
        for frame in frames:
            self._buffer.add_frame(frame)

    def _emit_no_audio(self) -> None:
        self._event_bus.publish(NoAudioDetected(timestamp=self._clock.get_current_time()))

    def _emit_no_audio_if_ptt(self) -> None:
        if not self._silence_endpoint_enabled:
            self._emit_no_audio()

    def _is_ptt_stop_without_speech(self) -> bool:
        return not self._silence_endpoint_enabled and not self._speech_detected_in_recording

    def request_stop(self, backdate_seconds: float = 0.0) -> None:
        """Transition out of RECORDING in response to PTT release / toggle off
        / VAD silence endpoint.

        Three exits, all of which leave the state machine in a valid resting
        state (no caller is allowed to leave us stuck in RECORDING):

        1. **Not recording** — caller raced a real stop with a state we already
           left (e.g., abort fired first, or we're in LISTENING/WAKEWORD).
           Emit ``NoAudioDetected`` on PTT so the UI can react, no state
           change needed.

        2. **PTT stop without speech** — VAD never registered a speech-
           active frame (e.g., user held PTT during silence). **Abort** the
           recording (state → INACTIVE, buffer cleared) — if we merely
           returned here the state would stay at RECORDING with no audio
           reader feeding the buffer (set_microphone(False) already paused
           the source), and the realtime worker would tight-loop on the
           stale pre-roll frames until process exit. (See
           ``project_pipeline_stop_abort_too_short`` memory note.) This is
           the sole, content-based "no audio detected" gate — a smoothed
           VAD follows the same pattern.
           Short utterances are no longer rejected by a time floor; clips
           shorter than 1.25 s are zero-padded to 1.25 s at transcribe time.

        Otherwise: finalize stop, transition to TRANSCRIBING, enqueue for
        transcription.
        """
        if not self._sm.is_recording:
            self._emit_no_audio_if_ptt()
            return
        if self._is_ptt_stop_without_speech():
            self._emit_no_audio()
            self.request_abort()
            return
        self._finalize_stop(backdate_seconds)

    def request_stop_via_queue(self, backdate_seconds: float = 0.0) -> None:
        """Stop by enqueuing a marker, so queued audio is buffered first.

        The user-release path (``set_microphone(False)``) calls this instead
        of ``request_stop()`` directly. A direct call from the control thread
        transitions to TRANSCRIBING immediately — any chunks still sitting in
        ``_audio_queue`` then hit ``_process_not_recording`` and are dropped
        from the recording, clipping the last fraction of a second the user
        spoke. Routing the stop through the queue guarantees the worker
        drains those trailing chunks into the buffer before it finalizes, and
        keeps the state transition on the worker thread (single-writer
        invariant — see CLAUDE.md §5).
        """
        self._audio_queue.put(_StopMarker(backdate_seconds))

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
        self._consecutive_speech_chunks = 0
        self._wakeword_detected = False
        self._wakeword_detected_at = 0.0
        # Drop the silence-prefill — an aborted recording shouldn't leak
        # its trailing silence into the NEXT recording's prefill, and the
        # deque would otherwise survive across the abort. ``maxlen``
        # is preserved (deque.clear() leaves it intact).
        self._silence_prefill.clear()

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
            # The streaming resampler emits empty chunks while priming or
            # holding back its tail (pyaudio_source._StreamingResampler.process
            # returns b"" — happens on any mic whose native rate != 16 kHz, i.e.
            # most real 44.1/48 kHz devices). An empty buffer carries no level:
            # np.mean over a zero-size array warns ("Mean of empty slice" +
            # "invalid value encountered in divide") and yields NaN. Skip the
            # level computation for empty chunks (mirrors VADCalibrator._on_chunk),
            # but still pass the chunk downstream — VAD/buffer tolerate empties.
            if samples.size:
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
                item = self._audio_queue.get(timeout=0.01)
            except queue.Empty:
                continue
            self._dispatch_queue_item(item)

    def _dispatch_queue_item(self, item: AudioChunk | _StopMarker) -> None:
        if isinstance(item, _StopMarker):
            # All chunks queued before the marker have now been buffered;
            # finalize the recording on this (worker) thread.
            self.request_stop(item.backdate_seconds)
        else:
            self._handle_chunk(item)

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

    def _accumulate_onset_speech_from_result(self, is_speech: bool) -> bool:
        """Track consecutive-speech onset; return whether it's sustained.

        A non-speech chunk breaks the run — onset must be CONSECUTIVE
        speech so an isolated noisy frame can't accumulate a start. When
        speech is present but not yet sustained the caller stays in
        LISTENING (no RecordingStarted) while still pre-rolling the chunk
        so the onset audio is preserved for when we do commit.

        Takes the VAD verdict as a parameter rather than running VAD
        again so the caller (``_process_not_recording``) can share one
        VAD call with the silence-prefill bookkeeping.
        """
        if not is_speech:
            self._consecutive_speech_chunks = 0
            return False
        self._consecutive_speech_chunks += 1
        return self._consecutive_speech_chunks >= self._speech_onset_required

    def _try_start_on_voice_activity_from_result(self, is_speech: bool) -> bool:
        if not self._vad_onset_armed():
            return False
        if not self._accumulate_onset_speech_from_result(is_speech):
            return False
        self._consecutive_speech_chunks = 0
        self._event_bus.publish(VADStarted(timestamp=self._clock.get_current_time()))
        self.request_start()
        self._speech_detected_in_recording = True
        self._start_recording_on_voice_activity = False
        return True

    def _process_not_recording(self, chunk: AudioChunk) -> None:
        self._maybe_detect_wake_word(chunk)
        # Run VAD exactly once per chunk and share the verdict between
        # the silence-prefill bookkeeping and the onset-debounce decision.
        # Calling ``_vad.detect`` twice would double the CPU cost of the
        # composite VAD (Silero is the expensive half) and risk Silero's
        # internal LSTM state diverging across the two calls.
        is_speech = self._vad.detect(chunk).is_speech
        # Silence-prefill: bounded deque of the most recent N silence
        # frames. On the first speech chunk that commits a recording
        # (handled below), ``request_start`` drains this into the
        # recording buffer so Whisper sees the silence→speech transition.
        self._maybe_append_silence_prefill(chunk, is_speech=is_speech)
        if self._try_start_on_voice_activity_from_result(is_speech):
            return
        self._buffer.add_to_pre_roll(chunk)

    def _maybe_append_silence_prefill(self, chunk: AudioChunk, *, is_speech: bool) -> None:
        """Carry a silence-classified chunk forward in the bounded prefill deque."""
        if not is_speech and self._silence_prefill.maxlen:
            self._silence_prefill.append(chunk)

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
