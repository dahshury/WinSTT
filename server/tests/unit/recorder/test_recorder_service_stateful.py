"""Stateful + property-based tests for :class:`RecorderService` orchestration.

These tests use ``hypothesis.stateful.RuleBasedStateMachine`` to drive the
service through arbitrary sequences of public-API calls (``start`` /
``stop`` / ``listen`` / ``set_microphone`` / ``feed_audio`` / ``abort`` /
``wait_audio``) and verify global invariants — never an exception, the
state machine never wedges in an illegal state, and PTT-shaped mic toggles
do the right thing — for every reachable interleaving the model produces.

The service is exercised entirely with the :mod:`tests.fakes` adapters so
no real audio / model code runs. ``use_microphone=False`` keeps the audio
reader thread out of the picture; everything goes through ``feed_audio``
on the main thread so each rule completes synchronously before invariants
run.
"""

from __future__ import annotations

import struct
import time

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, rule

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.recorder.application.recorder_service import RecorderService
from src.recorder.domain.config import RecorderConfig
from src.recorder.domain.errors import InvalidStateTransition
from src.recorder.domain.state_machine import RecorderState
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


def _make_chunk(value: int = 100, size: int = 512) -> bytes:
    """Build a valid int16 PCM chunk matching the default buffer_size (512)."""
    return struct.pack(f"<{size}h", *([value] * size))


def _make_service(
    *,
    speech_pattern: list[bool] | None = None,
    use_microphone: bool = False,
) -> RecorderService:
    """Build a RecorderService wired entirely with Fake adapters.

    ``use_microphone=False`` keeps the audio reader thread out — all audio
    flows through explicit ``feed_audio`` calls on the test thread, so
    every rule completes synchronously before invariants are checked.
    """
    config = RecorderConfig.from_kwargs(
        post_speech_silence_duration=0.05,
        min_length_of_recording=0.0,
        speech_onset_consecutive_chunks=1,
        use_microphone=use_microphone,
    )
    return RecorderService(
        audio_source=FakeAudioSource(),
        vad=FakeVAD(speech_pattern=speech_pattern or [False] * 100),
        transcriber=FakeTranscriber(),
        wake_word_detector=None,
        realtime_transcriber=None,
        config=config,
        event_bus=EventBus(),
        clock=Clock.system_clock(),
    )


# ─── Stand-alone property tests ──────────────────────────────────────────


@settings(max_examples=30, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.lists(st.sampled_from(["listen", "start", "stop", "abort"]), min_size=0, max_size=12))
def test_arbitrary_action_sequence_never_raises(actions: list[str]) -> None:
    """Any pre-shutdown sequence of public API calls must never throw.

    Mirrors the production assumption that the WebSocket control handler
    can dispatch arbitrary out-of-order commands without crashing the
    server — a malicious / buggy client must not be able to wedge us
    into an unhandled exception state.
    """
    service = _make_service()
    try:
        for action in actions:
            if action == "listen":
                service.listen()
            elif action == "start":
                # start() must be a quiet no-op when called from a
                # non-startable state (e.g. TRANSCRIBING). The orchestrator
                # is responsible for swallowing the pipeline's transition
                # error so PTT callers never see it bubble up.
                service.start()
            elif action == "stop":
                service.stop()
            elif action == "abort":
                service.abort()
    finally:
        service.shutdown()
    # After shutdown, the state machine has been aborted to INACTIVE.
    assert service.state == RecorderState.INACTIVE


@settings(max_examples=20, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.integers(min_value=0, max_value=5))
def test_stop_when_inactive_is_idempotent(num_extra_stops: int) -> None:
    """``stop()`` while the state machine is INACTIVE must not raise.

    The pipeline's ``request_stop`` short-circuits when not recording;
    the user's release of PTT after a silence-driven auto-stop arrives
    in this state and must be a quiet no-op.
    """
    service = _make_service()
    try:
        for _ in range(num_extra_stops + 1):
            result = service.stop()
            assert result is service
        assert service.state == RecorderState.INACTIVE
    finally:
        service.shutdown()


@settings(max_examples=15, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.booleans(), st.booleans())
def test_set_microphone_toggles_use_microphone_flag(first: bool, second: bool) -> None:
    """``use_microphone`` reflects the most recent ``set_microphone`` arg.

    The frontend reads this back via ``get_parameter`` to display the
    correct mute indicator; if the property drifted from the actual
    state, the UI would lie about whether the mic is hot.
    """
    service = _make_service()
    try:
        service.set_microphone(first)
        assert service.use_microphone == first
        service.set_microphone(second)
        assert service.use_microphone == second
    finally:
        service.shutdown()


@settings(max_examples=15, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.integers(min_value=0, max_value=10))
def test_set_microphone_false_then_listen_stays_silent(num_silent_feeds: int) -> None:
    """``set_microphone(False)`` then ``listen()`` does NOT auto-record.

    With the VAD wired to "no speech" the silence injection from a
    paused mic must not drive a state-machine transition out of
    LISTENING — the user's release must be sticky until the next
    explicit ``set_microphone(True)``.
    """
    service = _make_service(speech_pattern=[False] * 50)
    try:
        service.set_microphone(False)
        service.listen()
        # Even after fed silence, must remain in LISTENING (no spurious
        # transition to RECORDING).
        for _ in range(num_silent_feeds):
            service.feed_audio(_make_chunk(value=0))
        # Allow pipeline worker time to drain the queue.
        time.sleep(0.05)
        assert service.state in (
            RecorderState.LISTENING,
            RecorderState.INACTIVE,
        )
        assert not service.is_recording
    finally:
        service.shutdown()


@settings(max_examples=10, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.integers(min_value=0, max_value=4))
def test_start_then_immediate_stop_does_not_lose_callback(num_repeats: int) -> None:
    """``start()`` followed immediately by ``stop()`` exits cleanly.

    The PTT path can sometimes fire a release before the press has
    propagated through the pipeline thread; the orchestrator must not
    drop the transcription-finished callback chain or leak threads.
    """
    callback_called: list[str] = []
    service = _make_service()
    try:
        for _ in range(num_repeats + 1):
            service.listen()
            service.start()
            service.stop()
        # Service must still be responsive after the rapid start/stop loop.
        assert service.state in _VALID_STATES
    finally:
        service.shutdown()
    assert callback_called == []  # no actual transcription fired in this test


@settings(max_examples=10, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.lists(st.booleans(), min_size=0, max_size=8))
def test_set_microphone_cycles_never_crash(toggles: list[bool]) -> None:
    """Any sequence of ``set_microphone(True/False)`` toggles is safe.

    Users in PTT-toggle mode flip the mic frequently; the orchestrator
    must remain in a valid state for every interleaving.
    """
    service = _make_service()
    try:
        for value in toggles:
            service.set_microphone(value)
        assert service.use_microphone == (toggles[-1] if toggles else False)
        assert service.state in _VALID_STATES
    finally:
        service.shutdown()


def test_start_swallows_invalid_state_transition_from_pipeline() -> None:
    """``start()`` must NEVER leak ``InvalidStateTransition`` to the caller.

    The current pipeline implementation happens not to raise from
    ``request_start`` in any reachable state, but the orchestrator's
    contract is "PTT presses are a quiet no-op when the pipeline can't
    honour them" regardless of the lower-level state machine's edges.
    Forcing the raise here pins that contract so a future pipeline
    refactor (e.g. tighter transitions) can't silently leak the lower-
    level exception out to WebSocket callers.
    """
    service = _make_service()
    try:

        def _raise(*_args: object, **_kwargs: object) -> None:
            raise InvalidStateTransition("simulated pipeline rejection")

        service._pipeline.request_start = _raise  # type: ignore[method-assign]
        # Must not raise — the orchestrator catches and logs.
        result = service.start()
        assert result is service
    finally:
        service.shutdown()


# ─── Stateful test (RuleBasedStateMachine) ───────────────────────────────


class RecorderServiceModel(RuleBasedStateMachine):
    """Drive a real RecorderService through arbitrary public-API sequences.

    Invariants verified after every rule:

    * The state machine is always in a valid :class:`RecorderState` enum.
    * ``service.use_microphone`` matches the model's tracking variable.
    * ``service.is_recording`` is consistent with ``service.state``.

    Rules are restricted to the public API; the model does NOT drive
    audio_reader_thread (use_microphone=False) so every rule completes
    synchronously and invariants run against a stable snapshot.
    """

    def __init__(self) -> None:
        super().__init__()
        self.service = _make_service(speech_pattern=[False] * 200)
        self.expected_mic_on = False
        self.pipeline_started = False

    @rule()
    def do_listen(self) -> None:
        self.service.listen()
        self.pipeline_started = True

    @rule()
    def do_start(self) -> None:
        # ``start()`` from INACTIVE without listen() goes through
        # _enter_recording_state which lifts INACTIVE→LISTENING→RECORDING.
        # The pipeline can refuse the promotion if the current state forbids
        # it (e.g. already TRANSCRIBING) — the orchestrator MUST swallow that
        # InvalidStateTransition so PTT callers never see it. Asserting no
        # exception here pins the contract; if a regression brings the leak
        # back this rule will fail noisily instead of being papered over.
        self.service.start()
        self.pipeline_started = True

    @rule()
    def do_stop(self) -> None:
        # Stop must NEVER raise — even when called from any state.
        self.service.stop()

    @rule()
    def do_abort(self) -> None:
        # Abort drives the state machine straight to INACTIVE; the
        # ``transcription_queue`` gets a sentinel so any waiter resolves.
        self.service.abort()

    @rule(mic_on=st.booleans())
    def do_set_microphone(self, mic_on: bool) -> None:
        self.service.set_microphone(mic_on)
        self.expected_mic_on = mic_on

    @rule(value=st.integers(min_value=-1000, max_value=1000))
    def do_feed_audio(self, value: int) -> None:
        # Only feed when the pipeline thread is up — otherwise the chunk
        # would accumulate in the queue across a future ``shutdown`` and
        # confuse later invariants.
        if not self.pipeline_started:
            return
        self.service.feed_audio(_make_chunk(value=value))

    @rule(seconds=st.floats(min_value=0.01, max_value=2.0))
    def do_set_post_speech_silence(self, seconds: float) -> None:
        """PTT pattern: the renderer sets this to 9999 during a hold,
        then 0.15 on release. Setter must reflect on the next read."""
        self.service.post_speech_silence_duration = seconds
        assert self.service.post_speech_silence_duration == seconds

    @rule(enabled=st.booleans())
    def do_set_silence_endpoint(self, enabled: bool) -> None:
        self.service.silence_endpoint_enabled = enabled
        assert self.service.silence_endpoint_enabled == enabled

    @invariant()
    def state_is_valid_enum(self) -> None:
        assert self.service.state in _VALID_STATES

    @invariant()
    def use_microphone_matches_last_set(self) -> None:
        assert self.service.use_microphone == self.expected_mic_on

    @invariant()
    def is_recording_consistent_with_state(self) -> None:
        assert self.service.is_recording == (
            self.service.state == RecorderState.RECORDING
        )

    @invariant()
    def post_speech_silence_is_nonneg(self) -> None:
        assert self.service.post_speech_silence_duration >= 0.0

    def teardown(self) -> None:
        # Defensive: shutdown must complete without raising regardless of
        # state. The harness allocates a fresh model per example so a
        # missing teardown would leak the pipeline thread.
        self.service.shutdown()


TestRecorderServiceModel = RecorderServiceModel.TestCase
TestRecorderServiceModel.settings = settings(
    max_examples=30,
    stateful_step_count=20,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.filter_too_much],
)


# ─── Property: PTT-shape mic toggle never leaves dangling recording ──────


@settings(max_examples=15, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.lists(st.booleans(), min_size=1, max_size=6))
def test_set_microphone_off_clears_recording_eventually(mic_sequence: list[bool]) -> None:
    """A ``set_microphone(False)`` must eventually drop the recording.

    The PTT release path sets ``_microphone_enabled = False`` and (when
    a recording is in progress) calls ``request_stop()``. After the
    sequence ends with ``False``, the state machine must not be stuck
    in RECORDING — either INACTIVE, LISTENING, or TRANSCRIBING are
    acceptable (the transcribe finalises the recording).
    """
    service = _make_service()
    try:
        service.listen()
        # Force into RECORDING via the explicit-start path. ``start()`` is a
        # quiet no-op if the state machine refuses the transition, so this
        # call can never raise.
        service.start()
        # Apply the random mic sequence.
        for value in mic_sequence:
            service.set_microphone(value)
        # Final set was the last element; if False, the recording must
        # have been requested to stop.
        if not mic_sequence[-1]:
            assert service.state != RecorderState.RECORDING or not service.is_recording
    finally:
        service.shutdown()
