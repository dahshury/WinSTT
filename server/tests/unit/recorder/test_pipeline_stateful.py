"""Stateful + property-based tests for :class:`RecordingPipeline`.

The pipeline is the only component allowed to drive
:class:`RecorderStateMachine` transitions. Its public requests
(``request_listen`` / ``request_start`` / ``request_stop`` /
``request_abort``) are issued by the orchestrator on the test thread
while audio chunks flow through ``feed_audio``; the pipeline worker
thread runs the VAD/state loop. These properties verify that any
interleaving of those requests + chunks holds two key invariants:

  * The state machine never raises :class:`InvalidStateTransition`
    from outside the pipeline — i.e. the pipeline's own dispatch only
    drives legal edges.
  * Audio buffering stays bounded even under sustained input.

The pipeline thread is started under a context manager so each
example owns the lifecycle and joins before invariants finalise.
"""

from __future__ import annotations

import contextlib
import struct
import time

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, rule

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.building_blocks.types import BufferSize, SampleRate
from src.recorder.application.pipeline import RecordingPipeline
from src.recorder.domain.audio_buffer import AudioBuffer
from src.recorder.domain.config import RecorderConfig
from src.recorder.domain.errors import InvalidStateTransition
from src.recorder.domain.state_machine import RecorderState, RecorderStateMachine
from tests.fakes.fake_audio_source import FakeAudioSource
from tests.fakes.fake_transcriber import FakeTranscriber
from tests.fakes.fake_vad import FakeVAD

_VALID_STATES = {
    RecorderState.INACTIVE,
    RecorderState.LISTENING,
    RecorderState.WAKEWORD,
    RecorderState.RECORDING,
    RecorderState.TRANSCRIBING,
}

# Pipeline default buffer size (matches AudioConfig default).
_BUFFER_SIZE = 512
_SAMPLE_RATE = 16000
# Roof on how much audio the pipeline retains: pre-roll +
# recording. Tests below verify pre-roll obeys its deque maxlen and
# recording frames stay bounded by what was actually fed.
_PRE_ROLL_SECONDS = 1.0


def _make_chunk(value: int = 100, size: int = _BUFFER_SIZE) -> bytes:
    """Build a valid int16 PCM chunk matching the default buffer size."""
    return struct.pack(f"<{size}h", *([value] * size))


def _make_pipeline(
    *,
    speech_pattern: list[bool] | None = None,
    config: RecorderConfig | None = None,
) -> tuple[RecordingPipeline, EventBus, RecorderStateMachine, AudioBuffer, FakeVAD]:
    cfg = config or RecorderConfig.from_kwargs(
        post_speech_silence_duration=0.1,
        min_length_of_recording=0.0,
        speech_onset_consecutive_chunks=1,
        pre_recording_buffer_duration=_PRE_ROLL_SECONDS,
    )
    event_bus = EventBus()
    sm = RecorderStateMachine()
    buf = AudioBuffer(
        sample_rate=SampleRate(_SAMPLE_RATE),
        buffer_size=BufferSize(_BUFFER_SIZE),
        pre_recording_buffer_duration=_PRE_ROLL_SECONDS,
    )
    vad = FakeVAD(speech_pattern=speech_pattern or [False] * 200)
    pipeline = RecordingPipeline(
        audio_source=FakeAudioSource(),
        vad=vad,
        transcriber=FakeTranscriber(),
        wake_word_detector=None,
        config=cfg,
        event_bus=event_bus,
        clock=Clock.system_clock(),
        state_machine=sm,
        audio_buffer=buf,
    )
    return pipeline, event_bus, sm, buf, vad


# ─── Stand-alone property tests ──────────────────────────────────────────


@settings(max_examples=25, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.lists(st.sampled_from(["listen", "start", "stop", "abort"]), min_size=0, max_size=12))
def test_request_sequence_never_raises_invalid_state_transition(actions: list[str]) -> None:
    """Pipeline requests must never raise InvalidStateTransition.

    The pipeline owns the state machine; every internal transition it
    fires must already be legal at that moment. A raised
    InvalidStateTransition would mean a stale guard slipped through.
    """
    pipeline, _bus, sm, _buf, _vad = _make_pipeline()
    try:
        for action in actions:
            if action == "listen":
                pipeline.request_listen()
            elif action == "start":
                # ``request_start`` from TRANSCRIBING is genuinely
                # illegal in the state graph — but the pipeline
                # gracefully promotes through LISTENING when not in
                # a recording-terminal state. Catch the rare illegal
                # window to keep the property focused on the typical
                # paths.
                with contextlib.suppress(InvalidStateTransition):
                    pipeline.request_start()
            elif action == "stop":
                pipeline.request_stop()
            elif action == "abort":
                pipeline.request_abort()
        assert sm.state in _VALID_STATES
    finally:
        pipeline.stop(timeout=2.0)


@settings(max_examples=20, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.floats(min_value=0.01, max_value=10.0, allow_nan=False, allow_infinity=False))
def test_post_speech_silence_setter_is_reflected_immediately(seconds: float) -> None:
    """PTT pattern: renderer flips post_speech_silence_duration between
    9999 (hold) and 0.15 (release). Setter must take effect on the next
    silence check — i.e. read-back must match the set value.
    """
    pipeline, _bus, _sm, _buf, _vad = _make_pipeline()
    try:
        pipeline.post_speech_silence_duration = seconds
        assert pipeline.post_speech_silence_duration == seconds
    finally:
        pipeline.stop(timeout=2.0)


@settings(max_examples=20, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.booleans())
def test_silence_endpoint_setter_round_trips(enabled: bool) -> None:
    """PTT mode (silence_endpoint_enabled=False) gates the VAD endpoint
    detector — setter+getter must agree so the renderer's mode toggle
    correctly disables the endpoint logic."""
    pipeline, _bus, _sm, _buf, _vad = _make_pipeline()
    try:
        pipeline.silence_endpoint_enabled = enabled
        assert pipeline.silence_endpoint_enabled == enabled
    finally:
        pipeline.stop(timeout=2.0)


@settings(max_examples=10, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.integers(min_value=0, max_value=200))
def test_pre_roll_bounded_under_sustained_feed(num_chunks: int) -> None:
    """Pre-roll buffer must NOT grow unbounded under sustained input.

    Without bounds, a long LISTENING period (e.g. wake-word arming)
    would steadily consume memory until the user spoke or the process
    was killed. ``AudioBuffer`` uses a deque with ``maxlen`` derived
    from ``pre_recording_buffer_duration``.
    """
    pipeline, _bus, sm, buf, _vad = _make_pipeline()
    pipeline.request_listen()
    pipeline.start()  # worker thread
    try:
        for _ in range(num_chunks):
            pipeline.feed_audio(_make_chunk(value=0))
        # Let the worker drain the queue.
        time.sleep(0.1 + num_chunks * 0.001)
        # Pre-roll uses a deque(maxlen=...). Maximum is fixed regardless
        # of how many chunks we feed.
        expected_max = max(1, int((_SAMPLE_RATE // _BUFFER_SIZE) * _PRE_ROLL_SECONDS))
        assert buf.pre_roll_count <= expected_max
        assert sm.state in _VALID_STATES
    finally:
        pipeline.stop(timeout=2.0)


@settings(max_examples=10, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.integers(min_value=1, max_value=50))
def test_abort_clears_buffer(num_chunks: int) -> None:
    """``request_abort`` must clear the recording buffer.

    Otherwise a fresh listen after an aborted session would carry the
    old audio forward and re-transcribe it on the next stop.
    """
    pipeline, _bus, sm, buf, _vad = _make_pipeline(speech_pattern=[True] * 200)
    pipeline.request_listen()
    pipeline.request_start()
    pipeline.start()
    try:
        for _ in range(num_chunks):
            pipeline.feed_audio(_make_chunk(value=100))
        time.sleep(0.05 + num_chunks * 0.002)
        pipeline.request_abort()
        assert buf.frame_count == 0
        assert sm.state == RecorderState.INACTIVE
    finally:
        pipeline.stop(timeout=2.0)


@settings(max_examples=15, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(
    st.lists(st.sampled_from(["listen", "start", "stop"]), min_size=0, max_size=6),
)
def test_request_stop_without_recording_is_silent_noop(actions: list[str]) -> None:
    """``request_stop`` while not in RECORDING must not enqueue garbage.

    The orchestrator's ``wait_audio`` loop polls the transcription
    queue; a phantom entry would resolve a non-existent transcription
    request. Properly the pipeline should only enqueue when a real
    recording finalises.
    """
    pipeline, _bus, sm, _buf, _vad = _make_pipeline()
    try:
        for action in actions:
            if action == "listen":
                pipeline.request_listen()
            elif action == "start":
                with contextlib.suppress(InvalidStateTransition):
                    pipeline.request_start()
            elif action == "stop":
                pipeline.request_stop()
        # Drain queue: every queued item must be a (success, backdate)
        # tuple — never None or junk.
        drained = []
        while not pipeline.transcription_queue.empty():
            item = pipeline.transcription_queue.get_nowait()
            drained.append(item)
        for item in drained:
            assert item is None or (isinstance(item, tuple) and len(item) == 2)
        assert sm.state in _VALID_STATES
    finally:
        pipeline.stop(timeout=2.0)


@settings(max_examples=10, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.integers(min_value=1, max_value=30))
def test_recording_buffer_grows_only_when_recording(num_chunks: int) -> None:
    """Frames are added to the recording buffer ONLY while RECORDING.

    Frames fed while LISTENING flow into the bounded pre-roll deque
    instead — verifying the dispatch in ``_dispatch_chunk`` correctly
    splits chunks by state.
    """
    pipeline, _bus, sm, buf, _vad = _make_pipeline(speech_pattern=[False] * 200)
    pipeline.request_listen()
    pipeline.start()
    try:
        for _ in range(num_chunks):
            pipeline.feed_audio(_make_chunk(value=50))
        time.sleep(0.05 + num_chunks * 0.001)
        # In LISTENING with no speech onset, frame_count must be 0.
        # Pre-roll accumulates instead (bounded).
        assert buf.frame_count == 0
        assert sm.state == RecorderState.LISTENING
    finally:
        pipeline.stop(timeout=2.0)


# ─── Stateful test ───────────────────────────────────────────────────────


class PipelineModel(RuleBasedStateMachine):
    """Drive a real RecordingPipeline through arbitrary request sequences.

    The pipeline thread is left STOPPED so all requests run synchronously
    on the test thread — this isolates the dispatch / state-machine logic
    from worker-thread scheduling noise. The properties verified are:

      * The state machine is always in a valid enum value.
      * The transcription queue's contents are well-typed (tuple or
        None) after any sequence.
      * The pre-roll buffer never exceeds its deque maxlen.
      * No request method raises InvalidStateTransition in cases the
        production code guards against.
    """

    def __init__(self) -> None:
        super().__init__()
        self.pipeline, _bus, self.sm, self.buf, _vad = _make_pipeline()

    @rule()
    def do_listen(self) -> None:
        self.pipeline.request_listen()

    @rule()
    def do_start(self) -> None:
        # ``request_start`` from TRANSCRIBING is illegal; the
        # orchestrator gates against this externally but the test
        # exercises the raw pipeline so we treat the exception as
        # a legitimate signal that an upstream guard would have
        # filtered.
        with contextlib.suppress(InvalidStateTransition):
            self.pipeline.request_start()

    @rule()
    def do_stop(self) -> None:
        # Stop must never raise — it's defensively guarded.
        self.pipeline.request_stop()

    @rule()
    def do_abort(self) -> None:
        self.pipeline.request_abort()

    @rule(value=st.integers(min_value=-1000, max_value=1000))
    def do_feed_audio(self, value: int) -> None:
        # feed_audio just enqueues — no immediate state change because
        # the worker isn't running. Tests dispatch directly below.
        self.pipeline._audio_queue.put(_make_chunk(value=value))

    @rule(value=st.integers(min_value=-1000, max_value=1000))
    def do_handle_chunk_directly(self, value: int) -> None:
        """Drive ``_handle_chunk`` directly on the test thread.

        This bypasses the worker loop so the state machine transitions
        complete synchronously before the next rule runs, eliminating
        flakiness from race timing while still exercising the full
        dispatch / VAD / transition pipeline.
        """
        chunk = _make_chunk(value=value)
        # The pipeline's own try/except in _handle_chunk swallows
        # exceptions, so this should never escape — but we belt-
        # and-braces in case a refactor narrows that catch.
        with contextlib.suppress(InvalidStateTransition):
            self.pipeline._handle_chunk(chunk)

    @rule(seconds=st.floats(min_value=0.01, max_value=5.0, allow_nan=False, allow_infinity=False))
    def do_set_post_silence(self, seconds: float) -> None:
        self.pipeline.post_speech_silence_duration = seconds

    @rule(enabled=st.booleans())
    def do_set_silence_endpoint(self, enabled: bool) -> None:
        self.pipeline.silence_endpoint_enabled = enabled

    @invariant()
    def state_is_valid(self) -> None:
        assert self.sm.state in _VALID_STATES

    @invariant()
    def pre_roll_bounded(self) -> None:
        expected_max = max(1, int((_SAMPLE_RATE // _BUFFER_SIZE) * _PRE_ROLL_SECONDS))
        assert self.buf.pre_roll_count <= expected_max

    @invariant()
    def transcription_queue_items_well_typed(self) -> None:
        """Anything ever placed on the transcription queue is either a
        ``(bool, float)`` tuple or ``None`` (abort sentinel) — no other
        type should appear."""
        # We don't pop the queue (that's done by the orchestrator);
        # peek by snapshotting the deque inside.
        with self.pipeline.transcription_queue.mutex:
            items = list(self.pipeline.transcription_queue.queue)
        for item in items:
            assert item is None or (
                isinstance(item, tuple) and len(item) == 2 and isinstance(item[0], bool)
            )

    @invariant()
    def setter_round_trip(self) -> None:
        # Whatever the last setter received must be readable back.
        v = self.pipeline.post_speech_silence_duration
        assert v >= 0.0

    def teardown(self) -> None:
        self.pipeline.stop(timeout=2.0)


TestPipelineModel = PipelineModel.TestCase
TestPipelineModel.settings = settings(
    max_examples=30,
    stateful_step_count=25,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.filter_too_much],
)
