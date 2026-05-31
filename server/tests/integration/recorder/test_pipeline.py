from __future__ import annotations

import queue
import struct
import time
import warnings

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.building_blocks.types import BufferSize, SampleRate
from src.recorder.application.pipeline import RecordingPipeline
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
from src.recorder.domain.state_machine import RecorderState, RecorderStateMachine
from tests.fakes.fake_audio_source import FakeAudioSource
from tests.fakes.fake_transcriber import FakeTranscriber
from tests.fakes.fake_vad import FakeVAD
from tests.fakes.fake_wake_word import FakeWakeWordDetector


def _make_chunk(size: int = 512) -> bytes:
    return struct.pack(f"<{size}h", *([0] * size))


class TestRecordingPipeline:
    def _make_pipeline(
        self,
        speech_pattern: list[bool] | None = None,
        config: RecorderConfig | None = None,
    ) -> tuple[RecordingPipeline, EventBus, RecorderStateMachine, AudioBuffer]:
        cfg = config or RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.1,
            # Preserve the legacy single-chunk onset semantics these tests
            # were written against; the speech-onset debounce is the new
            # production default (3) and is covered by its own tests below.
            speech_onset_consecutive_chunks=1,
        )
        event_bus = EventBus()
        sm = RecorderStateMachine()
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=1.0,
        )
        pipeline = RecordingPipeline(
            audio_source=FakeAudioSource(),
            vad=FakeVAD(speech_pattern=speech_pattern),
            transcriber=FakeTranscriber(),
            wake_word_detector=None,
            config=cfg,
            event_bus=event_bus,
            clock=Clock.system_clock(),
            state_machine=sm,
            audio_buffer=buf,
        )
        return pipeline, event_bus, sm, buf

    def _make_pipeline_with_clock(
        self,
        clock: Clock,
        speech_pattern: list[bool] | None = None,
        config: RecorderConfig | None = None,
        wake_word_detector: FakeWakeWordDetector | None = None,
    ) -> tuple[RecordingPipeline, EventBus, RecorderStateMachine, AudioBuffer, FakeVAD]:
        cfg = config or RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.1,
            # Preserve the legacy single-chunk onset semantics these tests
            # were written against; the speech-onset debounce is the new
            # production default (3) and is covered by its own tests below.
            speech_onset_consecutive_chunks=1,
        )
        event_bus = EventBus()
        sm = RecorderStateMachine()
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=1.0,
        )
        vad = FakeVAD(speech_pattern=speech_pattern)
        pipeline = RecordingPipeline(
            audio_source=FakeAudioSource(),
            vad=vad,
            transcriber=FakeTranscriber(),
            wake_word_detector=wake_word_detector,
            config=cfg,
            event_bus=event_bus,
            clock=clock,
            state_machine=sm,
            audio_buffer=buf,
        )
        return pipeline, event_bus, sm, buf, vad

    # ------------------------------------------------------------------ #
    # Original 4 tests (preserved)
    # ------------------------------------------------------------------ #

    def test_voice_triggers_recording(self) -> None:
        pipeline, event_bus, sm, _buf = self._make_pipeline(
            speech_pattern=[True, False, False, False, False, False, False, False, False, False, False]
        )
        events: list[object] = []
        event_bus.subscribe(RecordingStarted, events.append)

        pipeline.request_listen()
        chunk = _make_chunk()
        pipeline.feed_audio(chunk)

        with pipeline:
            time.sleep(0.2)

        assert sm.state != RecorderState.LISTENING or len(events) > 0

    def test_silence_stops_recording(self) -> None:
        pipeline, event_bus, _sm, _buf = self._make_pipeline(
            speech_pattern=[True] + [False] * 20,
        )
        stopped: list[object] = []
        event_bus.subscribe(RecordingStopped, stopped.append)

        pipeline.request_listen()
        for _ in range(21):
            pipeline.feed_audio(_make_chunk())

        with pipeline:
            time.sleep(0.5)

    def test_pre_roll_drain(self) -> None:
        pipeline, _event_bus, _sm, buf = self._make_pipeline(speech_pattern=[True])
        # Add pre-roll data
        for _ in range(5):
            buf.add_to_pre_roll(_make_chunk())
        assert buf.pre_roll_count == 5

        pipeline.request_listen()
        pipeline.feed_audio(_make_chunk())
        with pipeline:
            time.sleep(0.2)

    def test_event_emission(self) -> None:
        pipeline, event_bus, _sm, _buf = self._make_pipeline(
            speech_pattern=[True],
        )
        vad_events: list[object] = []
        event_bus.subscribe(VADStarted, vad_events.append)

        pipeline.request_listen()
        pipeline.feed_audio(_make_chunk())

        with pipeline:
            time.sleep(0.2)

    # ------------------------------------------------------------------ #
    # New tests for full coverage
    # ------------------------------------------------------------------ #

    def test_request_stop_via_queue_buffers_backlog_before_finalizing(self) -> None:
        """The stop marker buffers every already-queued chunk BEFORE the
        transition out of RECORDING — so the tail spoken right up to PTT
        release isn't dropped. A direct ``request_stop()`` would finalize
        immediately and leave the queued chunks to ``_process_not_recording``.
        """
        pipeline, event_bus, sm, buf = self._make_pipeline(speech_pattern=[True] + [False] * 50)
        # PTT semantics: no VAD silence endpoint, so only the marker stops us.
        pipeline.silence_endpoint_enabled = False
        stopped: list[object] = []
        event_bus.subscribe(RecordingStopped, stopped.append)

        pipeline.request_start()
        assert sm.state == RecorderState.RECORDING
        # Queue a backlog of chunks, then the stop marker, all BEFORE the
        # worker starts draining — mirrors a release while chunks are in flight.
        for _ in range(8):
            pipeline.feed_audio(_make_chunk())
        pipeline.request_stop_via_queue()

        with pipeline:
            deadline = time.time() + 1.0
            while sm.state == RecorderState.RECORDING and time.time() < deadline:
                time.sleep(0.01)

        assert sm.state == RecorderState.TRANSCRIBING  # type: ignore[comparison-overlap]
        # All 8 queued chunks landed in the buffer before the marker finalized.
        assert buf.frame_count >= 8
        assert len(stopped) == 1

    def test_request_listen_when_already_listening(self) -> None:
        """Line 72->74: request_listen() skips transition when state is already LISTENING."""
        clock = Clock.fixed_clock(1000.0)
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(clock)

        vad_detect_events: list[object] = []
        event_bus.subscribe(VADDetectStarted, vad_detect_events.append)

        # First call transitions INACTIVE -> LISTENING
        pipeline.request_listen()
        assert sm.state == RecorderState.LISTENING

        # Second call: state is already LISTENING, should skip transition but
        # still set the flag and publish VADDetectStarted
        pipeline.request_listen()
        assert sm.state == RecorderState.LISTENING
        assert len(vad_detect_events) == 2

    def test_request_start_from_inactive(self) -> None:
        """Line 79: request_start() when state is INACTIVE transitions INACTIVE->LISTENING->RECORDING."""
        clock = Clock.fixed_clock(1000.0)
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(clock)

        started_events: list[object] = []
        event_bus.subscribe(RecordingStarted, started_events.append)

        assert sm.state == RecorderState.INACTIVE
        pipeline.request_start()
        assert sm.state == RecorderState.RECORDING  # type: ignore[comparison-overlap]
        assert len(started_events) == 1

    def test_request_start_from_wakeword(self) -> None:
        """Lines 82-84: request_start() from WAKEWORD state transitions WAKEWORD->LISTENING->RECORDING."""
        clock = Clock.fixed_clock(1000.0)
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(clock)

        started_events: list[object] = []
        event_bus.subscribe(RecordingStarted, started_events.append)

        # Manually set state to WAKEWORD via valid transitions
        sm.transition(RecorderState.LISTENING)
        sm.transition(RecorderState.WAKEWORD)
        assert sm.state == RecorderState.WAKEWORD

        pipeline.request_start()
        assert sm.state == RecorderState.RECORDING  # type: ignore[comparison-overlap]
        assert len(started_events) == 1

    def test_request_stop_not_recording(self) -> None:
        """Lines 91-92: request_stop() returns early when not recording."""
        clock = Clock.fixed_clock(1000.0)
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(clock)

        stopped_events: list[object] = []
        event_bus.subscribe(RecordingStopped, stopped_events.append)

        # State is INACTIVE, not recording
        assert sm.state == RecorderState.INACTIVE
        pipeline.request_stop()
        assert sm.state == RecorderState.INACTIVE
        assert len(stopped_events) == 0

    def test_request_stop_with_backdate(self) -> None:
        """Lines 96-97: request_stop() with backdate_seconds > 0 calls buffer.backdate()."""
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.1,
        )
        pipeline, event_bus, sm, buf, _vad = self._make_pipeline_with_clock(clock, config=cfg)

        stopped_events: list[object] = []
        event_bus.subscribe(RecordingStopped, stopped_events.append)

        # Start recording
        pipeline.request_start()
        assert sm.state == RecorderState.RECORDING

        # Add some frames so backdate has something to work on
        for _ in range(10):
            buf.add_frame(_make_chunk())

        frame_count_before = buf.frame_count

        # Stop with backdate
        pipeline.request_stop(backdate_seconds=0.5)
        assert sm.state == RecorderState.TRANSCRIBING  # type: ignore[comparison-overlap]
        assert len(stopped_events) == 1
        # backdate should have removed some frames
        assert buf.frame_count < frame_count_before

    def test_request_stop_transitions_to_transcribing(self) -> None:
        """Lines 98-102: Full stop path - transitions to TRANSCRIBING, publishes event, enqueues."""
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.1,
        )
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(clock, config=cfg)

        stopped_events: list[object] = []
        event_bus.subscribe(RecordingStopped, stopped_events.append)

        pipeline.request_start()
        assert sm.state == RecorderState.RECORDING

        pipeline.request_stop()
        assert sm.state == RecorderState.TRANSCRIBING  # type: ignore[comparison-overlap]
        assert len(stopped_events) == 1
        # Check transcription_queue got an item
        item = pipeline.transcription_queue.get_nowait()
        assert item == (True, 0.0)

    def test_transcription_queue_property(self) -> None:
        """Line 113: Access the transcription_queue property."""
        clock = Clock.fixed_clock(1000.0)
        pipeline, _event_bus, _sm, _buf, _vad = self._make_pipeline_with_clock(clock)

        q = pipeline.transcription_queue
        assert isinstance(q, queue.Queue)
        # Should be the same object on repeated access
        assert q is pipeline.transcription_queue

    def test_process_not_recording_with_wake_words(self) -> None:
        """Line 131: _process_not_recording calls _process_wake_word when use_wake_words=True.

        Uses a FakeWakeWordDetector that does NOT detect on the first call, so
        we exercise the wake-word path but fall through to pre-roll.
        """
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.1,
            wakeword_backend="openwakeword",  # Enables use_wake_words
        )
        wake_detector = FakeWakeWordDetector(detect_at_call=-1)  # Never detects
        pipeline, _event_bus, sm, buf, _vad = self._make_pipeline_with_clock(
            clock,
            config=cfg,
            wake_word_detector=wake_detector,
        )

        # State is INACTIVE, _start_recording_on_voice_activity = False,
        # _wakeword_detected = False. So it should call _process_wake_word
        # and then fall through to add_to_pre_roll.
        sm.transition(RecorderState.LISTENING)
        chunk = _make_chunk()
        pipeline._process_not_recording(chunk)

        # Wake word detector was called
        assert wake_detector.call_count == 1
        # Chunk was added to pre-roll (since no voice activity detection triggered)
        assert buf.pre_roll_count == 1

    def test_process_not_recording_adds_pre_roll(self) -> None:
        """Line 141: _process_not_recording adds chunk to pre-roll when not listening for voice."""
        clock = Clock.fixed_clock(1000.0)
        pipeline, _event_bus, sm, buf, _vad = self._make_pipeline_with_clock(clock)

        # Transition to LISTENING so we can call _process_not_recording
        sm.transition(RecorderState.LISTENING)

        # _start_recording_on_voice_activity is False, _wakeword_detected is False
        # so it skips VAD and goes straight to add_to_pre_roll
        chunk = _make_chunk()
        pipeline._process_not_recording(chunk)
        assert buf.pre_roll_count == 1

    def test_process_recording_stop_disabled(self) -> None:
        """Line 147: _process_recording returns early when _stop_recording_on_voice_deactivity=False."""
        clock = Clock.fixed_clock(1000.0)
        pipeline, _event_bus, sm, buf, _vad = self._make_pipeline_with_clock(
            clock,
            speech_pattern=[False],
        )

        # Start recording then disable voice deactivity stopping
        pipeline.request_start()
        assert sm.state == RecorderState.RECORDING
        pipeline._stop_recording_on_voice_deactivity = False

        chunk = _make_chunk()
        initial_frame_count = buf.frame_count
        pipeline._process_recording(chunk)
        # Frame was added
        assert buf.frame_count == initial_frame_count + 1
        # Still recording (did not call VAD or stop)
        assert sm.state == RecorderState.RECORDING

    def test_process_recording_silence_triggers_stop(self) -> None:
        """Lines 162-163: Enough silence to trigger VADStopped + request_stop."""
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.0,  # Zero = immediate stop on silence
        )
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(
            clock,
            speech_pattern=[False, False],
            config=cfg,
        )

        vad_stopped_events: list[object] = []
        event_bus.subscribe(VADStopped, vad_stopped_events.append)
        stopped_events: list[object] = []
        event_bus.subscribe(RecordingStopped, stopped_events.append)
        turn_started_events: list[object] = []
        event_bus.subscribe(TurnDetectionStarted, turn_started_events.append)

        pipeline.request_start()
        assert sm.state == RecorderState.RECORDING

        # First silent chunk: sets _speech_end_silence_start, publishes TurnDetectionStarted
        chunk = _make_chunk()
        pipeline._process_recording(chunk)

        # With fixed clock, silence_duration = 1000.0 - 1000.0 = 0.0 >= 0.0
        # So the first call also triggers the stop
        assert sm.state == RecorderState.TRANSCRIBING  # type: ignore[comparison-overlap]
        assert len(vad_stopped_events) == 1
        assert len(stopped_events) == 1
        assert len(turn_started_events) == 1

    def test_process_recording_speech_resumes_after_silence(self) -> None:
        """Lines 166-167: Speech resumes after silence started, resets _speech_end_silence_start."""
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=999.0,  # Very long, so silence won't trigger stop
        )
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(
            clock,
            speech_pattern=[False, True],
            config=cfg,
        )

        turn_started_events: list[object] = []
        turn_stopped_events: list[object] = []
        event_bus.subscribe(TurnDetectionStarted, turn_started_events.append)
        event_bus.subscribe(TurnDetectionStopped, turn_stopped_events.append)

        pipeline.request_start()
        assert sm.state == RecorderState.RECORDING

        # First chunk: silence detected, sets _speech_end_silence_start, publishes TurnDetectionStarted
        pipeline._process_recording(_make_chunk())
        assert len(turn_started_events) == 1
        assert pipeline._speech_end_silence_start != 0.0

        # Second chunk: speech detected, resets _speech_end_silence_start, publishes TurnDetectionStopped
        pipeline._process_recording(_make_chunk())
        assert pipeline._speech_end_silence_start == 0.0
        assert len(turn_stopped_events) == 1
        assert sm.state == RecorderState.RECORDING

    def test_wake_word_detection(self) -> None:
        """Lines 170-175: Wake word detector detects a wake word, publishes WakeWordDetected."""
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.1,
            wakeword_backend="openwakeword",  # Enables use_wake_words
        )
        wake_detector = FakeWakeWordDetector(detect_at_call=1, word="jarvis")
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(
            clock,
            config=cfg,
            wake_word_detector=wake_detector,
        )

        wakeword_events: list[WakeWordDetected] = []
        event_bus.subscribe(WakeWordDetected, wakeword_events.append)

        # Transition to non-recording state
        sm.transition(RecorderState.LISTENING)

        # Call _process_not_recording - wake word detector will detect on call 1
        chunk = _make_chunk()
        pipeline._process_not_recording(chunk)

        assert len(wakeword_events) == 1
        assert wakeword_events[0].word == "jarvis"
        assert wakeword_events[0].word_index == 0
        assert pipeline._wakeword_detected is True

    def test_wake_word_triggers_vad_and_recording(self) -> None:
        """After wake word detected, VAD speech triggers recording start."""
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.1,
            wakeword_backend="openwakeword",
            # This test exercises the wake-word → VAD-onset wiring, not the
            # speech-onset debounce — keep the legacy single-chunk start.
            speech_onset_consecutive_chunks=1,
        )
        wake_detector = FakeWakeWordDetector(detect_at_call=1, word="jarvis")
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(
            clock,
            speech_pattern=[False, True],
            config=cfg,
            wake_word_detector=wake_detector,
        )

        started_events: list[object] = []
        event_bus.subscribe(RecordingStarted, started_events.append)

        sm.transition(RecorderState.LISTENING)

        # First chunk: wake word detected, VAD says no speech -> pre-roll
        pipeline._process_not_recording(_make_chunk())
        assert pipeline._wakeword_detected is True

        # Second chunk: wake word already detected (skips _process_wake_word),
        # VAD says speech -> triggers recording
        pipeline._process_not_recording(_make_chunk())
        assert sm.state == RecorderState.RECORDING
        assert len(started_events) == 1

    def test_request_start_when_already_recording(self) -> None:
        """Branch 82->85: request_start() when state is already RECORDING.

        Neither the if (LISTENING) nor the elif (WAKEWORD) matches,
        so execution falls through directly to line 85.
        """
        clock = Clock.fixed_clock(1000.0)
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(clock)

        started_events: list[object] = []
        event_bus.subscribe(RecordingStarted, started_events.append)

        # First request_start from INACTIVE -> LISTENING -> RECORDING
        pipeline.request_start()
        assert sm.state == RecorderState.RECORDING
        assert len(started_events) == 1

        # Second request_start while already RECORDING: neither if nor elif match
        pipeline.request_start()
        assert sm.state == RecorderState.RECORDING
        assert len(started_events) == 2  # RecordingStarted published again

    def test_request_abort(self) -> None:
        """Lines 105-109: request_abort() resets state machine and clears buffer."""
        clock = Clock.fixed_clock(1000.0)
        pipeline, _event_bus, sm, buf, _vad = self._make_pipeline_with_clock(clock)

        # Start recording to get into RECORDING state
        pipeline.request_start()
        assert sm.state == RecorderState.RECORDING

        # Add some frames
        buf.add_frame(_make_chunk())
        assert buf.frame_count > 0

        # Set internal flags that should be reset
        pipeline._stop_recording_on_voice_deactivity = True
        pipeline._speech_end_silence_start = 42.0
        pipeline._wakeword_detected = True

        pipeline.request_abort()

        assert sm.state == RecorderState.INACTIVE  # type: ignore[comparison-overlap]
        assert buf.frame_count == 0
        assert pipeline._stop_recording_on_voice_deactivity is False
        assert pipeline._speech_end_silence_start == 0.0
        assert pipeline._wakeword_detected is False

    def test_process_recording_speech_without_prior_silence(self) -> None:
        """Branch 165->exit: Speech detected in _process_recording but
        _speech_end_silence_start is already 0 (no prior silence period).

        The else branch at line 164 is entered, but the inner if at 165 is False,
        so execution falls through without publishing TurnDetectionStopped.
        """
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.1,
        )
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(
            clock,
            speech_pattern=[True],
            config=cfg,
        )

        turn_stopped_events: list[object] = []
        event_bus.subscribe(TurnDetectionStopped, turn_stopped_events.append)

        pipeline.request_start()
        assert sm.state == RecorderState.RECORDING
        # _speech_end_silence_start is 0.0 by default

        # Process a speech chunk - enters else branch but inner if is False
        pipeline._process_recording(_make_chunk())

        assert sm.state == RecorderState.RECORDING
        assert len(turn_stopped_events) == 0
        assert pipeline._speech_end_silence_start == 0.0

    def test_post_speech_silence_duration_default(self) -> None:
        """Property returns the config default."""
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(post_speech_silence_duration=0.42)
        pipeline, _event_bus, _sm, _buf, _vad = self._make_pipeline_with_clock(clock, config=cfg)
        assert pipeline.post_speech_silence_duration == 0.42

    def test_post_speech_silence_duration_setter(self) -> None:
        """Setter mutates the runtime value without touching config."""
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(post_speech_silence_duration=0.42)
        pipeline, _event_bus, _sm, _buf, _vad = self._make_pipeline_with_clock(clock, config=cfg)

        pipeline.post_speech_silence_duration = 1.5
        assert pipeline.post_speech_silence_duration == 1.5
        # Config is unchanged
        assert cfg.vad.post_speech_silence_duration == 0.42

    def test_post_speech_silence_duration_affects_stop(self) -> None:
        """Mutated post_speech_silence_duration is used in _process_recording."""
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=999.0,  # Very long — would never fire
        )
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(
            clock,
            speech_pattern=[False, False],
            config=cfg,
        )

        vad_stopped: list[object] = []
        event_bus.subscribe(VADStopped, vad_stopped.append)

        pipeline.request_start()
        assert sm.state == RecorderState.RECORDING

        # Override to 0.0 at runtime so silence immediately fires
        pipeline.post_speech_silence_duration = 0.0
        pipeline._process_recording(_make_chunk())

        assert sm.state == RecorderState.TRANSCRIBING  # type: ignore[comparison-overlap]
        assert len(vad_stopped) == 1

    def test_frames_property(self) -> None:
        """Pipeline.frames delegates to buffer.frames."""
        clock = Clock.fixed_clock(1000.0)
        pipeline, _event_bus, _sm, buf, _vad = self._make_pipeline_with_clock(clock)
        pipeline.request_start()
        buf.add_frame(_make_chunk())
        assert pipeline.frames is buf.frames
        assert len(pipeline.frames) > 0

    def test_last_words_buffer_property(self) -> None:
        """Pipeline.last_words_buffer delegates to buffer.last_words_buffer."""
        clock = Clock.fixed_clock(1000.0)
        pipeline, _event_bus, _sm, buf, _vad = self._make_pipeline_with_clock(clock)
        buf.add_to_last_words(_make_chunk())
        assert pipeline.last_words_buffer is buf.last_words_buffer
        assert len(pipeline.last_words_buffer) == 1

    def test_wake_word_activation_delay_default(self) -> None:
        """Property returns the config default."""
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(wake_word_activation_delay=3.5)
        pipeline, _event_bus, _sm, _buf, _vad = self._make_pipeline_with_clock(clock, config=cfg)
        assert pipeline.wake_word_activation_delay == 3.5

    def test_wake_word_activation_delay_setter(self) -> None:
        """Setter mutates the runtime value without touching config."""
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(wake_word_activation_delay=3.5)
        pipeline, _event_bus, _sm, _buf, _vad = self._make_pipeline_with_clock(clock, config=cfg)
        pipeline.wake_word_activation_delay = 7.0
        assert pipeline.wake_word_activation_delay == 7.0
        assert cfg.wake_word.wake_word_activation_delay == 3.5

    def test_process_wake_word_without_detector(self) -> None:
        """Line 171: _process_wake_word returns early when wake_word_detector is None.

        Constructs pipeline with use_wake_words=True but wake_word_detector=None.
        """
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.1,
            wakeword_backend="openwakeword",  # Enables use_wake_words
        )
        # wake_word_detector is None (the default)
        pipeline, event_bus, sm, buf, _vad = self._make_pipeline_with_clock(
            clock,
            config=cfg,
            wake_word_detector=None,
        )

        wakeword_events: list[object] = []
        event_bus.subscribe(WakeWordDetected, wakeword_events.append)

        sm.transition(RecorderState.LISTENING)

        # _use_wake_words is True, _wakeword_detected is False
        # So _process_wake_word is called, but detector is None -> return
        pipeline._process_not_recording(_make_chunk())

        # No wake word detected, chunk added to pre-roll
        assert len(wakeword_events) == 0
        assert pipeline._wakeword_detected is False
        assert buf.pre_roll_count == 1

    def test_silence_endpoint_enabled_default(self) -> None:
        """Property defaults to True."""
        clock = Clock.fixed_clock(1000.0)
        pipeline, _event_bus, _sm, _buf, _vad = self._make_pipeline_with_clock(clock)
        assert pipeline.silence_endpoint_enabled is True

    def test_silence_endpoint_enabled_setter(self) -> None:
        """Setter mutates the runtime value."""
        clock = Clock.fixed_clock(1000.0)
        pipeline, _event_bus, _sm, _buf, _vad = self._make_pipeline_with_clock(clock)
        pipeline.silence_endpoint_enabled = False
        assert pipeline.silence_endpoint_enabled is False

    def test_silence_endpoint_disabled_skips_vad_stop(self) -> None:
        """When silence_endpoint_enabled is False, silence does not trigger stop."""
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.0,  # Would fire immediately if enabled
        )
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(
            clock,
            speech_pattern=[False, False],
            config=cfg,
        )

        vad_stopped: list[object] = []
        event_bus.subscribe(VADStopped, vad_stopped.append)

        pipeline.request_start()
        assert sm.state == RecorderState.RECORDING

        # Disable silence endpoint — silence should NOT trigger stop
        pipeline.silence_endpoint_enabled = False
        pipeline._process_recording(_make_chunk())

        assert sm.state == RecorderState.RECORDING
        assert len(vad_stopped) == 0

    def test_silence_endpoint_disabled_vad_still_tracks_speech(self) -> None:
        """VAD runs even when silence endpoint is disabled, tracking speech presence."""
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.0,
        )
        pipeline, _event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(
            clock,
            speech_pattern=[True],
            config=cfg,
        )

        pipeline.request_start()
        pipeline.silence_endpoint_enabled = False
        pipeline._process_recording(_make_chunk())

        # VAD ran and detected speech even though silence endpoint is disabled
        assert pipeline._speech_detected_in_recording is True
        # But recording was NOT stopped (silence endpoint disabled)
        assert sm.state == RecorderState.RECORDING

    def test_request_stop_aborts_when_no_speech_in_ptt_mode(self) -> None:
        """In PTT mode, request_stop aborts if no speech was detected and emits NoAudioDetected."""
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.1,
        )
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(
            clock,
            speech_pattern=[False],
            config=cfg,
        )

        no_audio_events: list[object] = []
        event_bus.subscribe(NoAudioDetected, no_audio_events.append)

        pipeline.request_start()
        pipeline.silence_endpoint_enabled = False
        # Feed silence — VAD says no speech
        pipeline._process_recording(_make_chunk())
        assert pipeline._speech_detected_in_recording is False

        # Stop should abort instead of transcribing
        pipeline.request_stop()
        assert sm.state == RecorderState.INACTIVE
        assert len(no_audio_events) == 1

    def test_request_stop_emits_no_audio_when_not_recording_in_ptt_mode(self) -> None:
        """In PTT mode, request_stop while INACTIVE emits NoAudioDetected (line 102 silent-exit)."""
        clock = Clock.fixed_clock(1000.0)
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(clock)

        no_audio_events: list[object] = []
        event_bus.subscribe(NoAudioDetected, no_audio_events.append)

        pipeline.silence_endpoint_enabled = False
        assert sm.state == RecorderState.INACTIVE
        pipeline.request_stop()
        assert sm.state == RecorderState.INACTIVE
        assert len(no_audio_events) == 1

    def test_handle_chunk_swallows_processing_errors(self) -> None:
        """Lines 207-208: _handle_chunk logs and swallows exceptions from a bad chunk.

        An odd-length byte buffer makes np.frombuffer raise ValueError; the
        pipeline must continue (one bad chunk shouldn't crash the worker).
        """
        clock = Clock.fixed_clock(1000.0)
        pipeline, _event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(clock)

        # 1 byte is not a multiple of int16 element size -> np.frombuffer raises.
        bad_chunk = b"\x00"
        pipeline._handle_chunk(bad_chunk)

        # No exception propagated; state unchanged.
        assert sm.state == RecorderState.INACTIVE

    def test_handle_chunk_skips_level_for_empty_chunk(self) -> None:
        """An empty chunk computes no level and emits no numpy "Mean of empty slice" warning.

        The streaming resampler (pyaudio_source._StreamingResampler) returns
        b"" while priming / holding back its tail — routine on any mic whose
        native rate != 16 kHz. _handle_chunk must not run np.mean over the
        resulting zero-size buffer (which warns and yields a NaN level); it
        skips the AudioLevelComputed publish but still forwards the chunk.
        """
        clock = Clock.fixed_clock(1000.0)
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(clock)

        levels: list[object] = []
        chunks: list[object] = []
        event_bus.subscribe(AudioLevelComputed, levels.append)
        event_bus.subscribe(AudioChunkRecorded, chunks.append)

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            pipeline._handle_chunk(b"")

        # No RuntimeWarning ("Mean of empty slice" / "invalid value in divide").
        assert [w for w in caught if issubclass(w.category, RuntimeWarning)] == []
        # No spurious (NaN) level event for the empty chunk...
        assert levels == []
        # ...but the chunk still flows downstream (passthrough preserved).
        assert len(chunks) == 1
        assert sm.state == RecorderState.INACTIVE

    def test_dispatch_chunk_routes_to_recording_branch(self) -> None:
        """_dispatch_chunk routes to _process_recording while RECORDING."""
        clock = Clock.fixed_clock(1000.0)
        pipeline, _event_bus, sm, buf, _vad = self._make_pipeline_with_clock(
            clock,
            speech_pattern=[True],
        )
        pipeline.request_start()
        assert sm.state == RecorderState.RECORDING

        before = buf.frame_count
        pipeline._dispatch_chunk(_make_chunk())
        # Recording branch adds a frame to the buffer.
        assert buf.frame_count == before + 1

    def test_dispatch_chunk_routes_to_not_recording_branch(self) -> None:
        """_dispatch_chunk routes to _process_not_recording while not RECORDING."""
        clock = Clock.fixed_clock(1000.0)
        pipeline, _event_bus, sm, buf, _vad = self._make_pipeline_with_clock(clock)
        sm.transition(RecorderState.LISTENING)

        pipeline._dispatch_chunk(_make_chunk())
        # Not-recording branch falls through to pre-roll.
        assert buf.pre_roll_count == 1

    def test_request_stop_transcribes_when_speech_detected_in_ptt_mode(self) -> None:
        """In PTT mode, request_stop transcribes normally if speech was detected."""
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.1,
        )
        pipeline, _event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(
            clock,
            speech_pattern=[True],
            config=cfg,
        )

        pipeline.request_start()
        pipeline.silence_endpoint_enabled = False
        # Feed speech — VAD detects it
        pipeline._process_recording(_make_chunk())
        assert pipeline._speech_detected_in_recording is True

        pipeline.request_stop()
        assert sm.state == RecorderState.TRANSCRIBING

    # ------------------------------------------------------------------ #
    # Speech-onset debounce (noise must not pop the pill / wake Whisper)
    # ------------------------------------------------------------------ #

    def _onset_pipeline(
        self, *, required: int, speech_pattern: list[bool]
    ) -> tuple[RecordingPipeline, list[object], RecorderStateMachine, AudioBuffer]:
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.1,
            speech_onset_consecutive_chunks=required,
        )
        pipeline, event_bus, sm, buf, _vad = self._make_pipeline_with_clock(
            Clock.fixed_clock(1000.0),
            speech_pattern=speech_pattern,
            config=cfg,
        )
        started: list[object] = []
        event_bus.subscribe(RecordingStarted, started.append)
        pipeline.request_listen()
        return pipeline, started, sm, buf

    def test_speech_onset_requires_consecutive_chunks(self) -> None:
        """A single noisy speech chunk must NOT start recording; 3 consecutive must."""
        pipeline, started, sm, buf = self._onset_pipeline(required=3, speech_pattern=[True, True, True])

        # Chunk 1 & 2: speech, but not yet sustained — no RecordingStarted,
        # still LISTENING, and the onset audio is preserved in the pre-roll.
        pipeline._process_not_recording(_make_chunk())
        pipeline._process_not_recording(_make_chunk())
        assert started == []
        assert sm.state == RecorderState.LISTENING
        assert buf.pre_roll_count == 2

        # Chunk 3: the run reaches the threshold — recording commits.
        pipeline._process_not_recording(_make_chunk())
        assert len(started) == 1
        assert sm.state == RecorderState.RECORDING  # type: ignore[comparison-overlap]

    def test_speech_onset_non_speech_resets_the_run(self) -> None:
        """A non-speech chunk breaks the run — onset must be CONSECUTIVE."""
        pipeline, started, sm, _buf = self._onset_pipeline(required=3, speech_pattern=[True, True, False, True, True])

        # 2 speech, then a non-speech chunk zeroes the counter, then 2 more
        # speech — only 2 consecutive at the end, so still no start.
        for _ in range(5):
            pipeline._process_not_recording(_make_chunk())
        assert started == []
        assert sm.state == RecorderState.LISTENING

    def test_speech_onset_one_is_legacy_immediate_start(self) -> None:
        """speech_onset_consecutive_chunks=1 restores start-on-first-chunk."""
        pipeline, started, sm, _buf = self._onset_pipeline(required=1, speech_pattern=[True])

        pipeline._process_not_recording(_make_chunk())
        assert len(started) == 1
        assert sm.state == RecorderState.RECORDING

    def test_ptt_force_start_bypasses_onset_debounce(self) -> None:
        """PTT calls request_start() directly — the debounce never applies."""
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.1,
            speech_onset_consecutive_chunks=3,
        )
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(Clock.fixed_clock(1000.0), config=cfg)
        started: list[object] = []
        event_bus.subscribe(RecordingStarted, started.append)

        pipeline.request_start()
        assert len(started) == 1
        assert sm.state == RecorderState.RECORDING

    def test_request_listen_with_wake_words_does_not_arm_vad_onset(self) -> None:
        """request_listen() with a wake-word backend must NOT arm VAD onset.

        Covers the wake-words-enabled branch of request_listen (the
        ``if not self._use_wake_words`` False arm): onset stays disarmed
        until the detector fires, the debounce counter is reset, and
        VADDetectStarted is still published.
        """
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.1,
            wakeword_backend="openwakeword",
        )
        pipeline, event_bus, sm, _buf, _vad = self._make_pipeline_with_clock(Clock.fixed_clock(1000.0), config=cfg)
        detect_started: list[object] = []
        event_bus.subscribe(VADDetectStarted, detect_started.append)

        pipeline.request_listen()

        assert pipeline._use_wake_words is True
        assert pipeline._start_recording_on_voice_activity is False
        assert pipeline._consecutive_speech_chunks == 0
        assert sm.state == RecorderState.LISTENING
        assert len(detect_started) == 1

    def test_expired_wake_word_gate_is_cleared(self) -> None:
        """_maybe_expire_wake_word clears an armed gate past its timeout."""
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.1,
            wakeword_backend="openwakeword",
        )
        pipeline, _event_bus, _sm, _buf, _vad = self._make_pipeline_with_clock(Clock.fixed_clock(1000.0), config=cfg)
        # Arm the gate well in the past (timeout default 5.0; elapsed ~1000s).
        pipeline._wakeword_detected = True
        pipeline._wakeword_detected_at = 0.0

        pipeline._maybe_expire_wake_word()

        assert pipeline._wakeword_detected is False
        assert pipeline._wakeword_detected_at == 0.0

    # ------------------------------------------------------------------ #
    # Silence-prefill maxlen rounding (math.ceil substitute)
    # ------------------------------------------------------------------ #

    def test_silence_prefill_maxlen_rounds_up_on_fractional_ratio(self) -> None:
        """Branch 131->132: a non-integer ratio rounds UP (count += 1).

        Default config (vad_prefill_ms=450, buffer_size=512, sample_rate=16000)
        gives chunk_ms=32 and ratio=450/32=14.0625 — strictly greater than its
        int(14), so the ceil-substitute bumps the count to 15. This is the
        Handy-parity prefill_frames=15 invariant the docstring calls out.
        """
        cfg = RecorderConfig.from_kwargs()
        # Sanity: this is the fractional-ratio scenario, not an exact divisor.
        assert (cfg.audio.buffer_size * 1000.0 / cfg.audio.sample_rate) == 32.0
        assert cfg.vad.vad_prefill_ms == 450

        maxlen = RecordingPipeline._compute_silence_prefill_maxlen(cfg)

        # ceil(450 / 32) = ceil(14.0625) = 15 (rounded UP, not truncated to 14).
        assert maxlen == 15

    def test_silence_prefill_maxlen_no_round_up_on_exact_ratio(self) -> None:
        """Branch 131->133: an exact-integer ratio is NOT bumped.

        With vad_prefill_ms=64 and chunk_ms=32 the ratio is exactly 2.0, so
        ``ratio > count`` is False and the count returns as-is (2). Covers the
        not-taken arm of the ceil-substitute that the default (fractional)
        config never exercises.
        """
        cfg = RecorderConfig.from_kwargs(vad_prefill_ms=64)
        # chunk_ms is 32, so 64/32 == 2.0 exactly (the exact-divisor case).
        assert (cfg.audio.buffer_size * 1000.0 / cfg.audio.sample_rate) == 32.0

        maxlen = RecordingPipeline._compute_silence_prefill_maxlen(cfg)

        # int(2.0) == 2 and ratio is not > 2, so no +1: stays exactly 2.
        assert maxlen == 2

    def test_silence_prefill_maxlen_wires_through_to_deque(self) -> None:
        """The computed maxlen is the live ``_silence_prefill`` deque cap.

        Locks the exact-ratio path end-to-end: a pipeline built with
        vad_prefill_ms=64 must cap its silence-prefill deque at 2 chunks, so
        a third append drops the oldest entry.
        """
        clock = Clock.fixed_clock(1000.0)
        cfg = RecorderConfig.from_kwargs(vad_prefill_ms=64)
        pipeline, _event_bus, _sm, _buf, _vad = self._make_pipeline_with_clock(clock, config=cfg)

        assert pipeline._silence_prefill.maxlen == 2

        # Distinct payloads so eviction is observable by value.
        first = struct.pack("<3h", 1, 1, 1)
        second = struct.pack("<3h", 2, 2, 2)
        third = struct.pack("<3h", 3, 3, 3)
        pipeline._silence_prefill.append(first)
        pipeline._silence_prefill.append(second)
        pipeline._silence_prefill.append(third)

        # Deque capped at 2: the third append evicted the first chunk.
        assert len(pipeline._silence_prefill) == 2
        assert list(pipeline._silence_prefill) == [second, third]
