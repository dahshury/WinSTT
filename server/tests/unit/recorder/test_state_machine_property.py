"""Property-based tests for :mod:`src.recorder.domain.state_machine`."""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, rule

from src.recorder.domain.errors import InvalidStateTransition
from src.recorder.domain.state_machine import RecorderState, RecorderStateMachine

_VALID_TRANSITIONS: dict[RecorderState, set[RecorderState]] = {
    RecorderState.INACTIVE: {RecorderState.LISTENING, RecorderState.WAKEWORD},
    RecorderState.LISTENING: {RecorderState.RECORDING, RecorderState.WAKEWORD, RecorderState.INACTIVE},
    RecorderState.WAKEWORD: {RecorderState.LISTENING, RecorderState.INACTIVE},
    RecorderState.RECORDING: {RecorderState.TRANSCRIBING, RecorderState.INACTIVE},
    RecorderState.TRANSCRIBING: {RecorderState.INACTIVE, RecorderState.LISTENING},
}

_ALL_STATES = list(RecorderState)


@settings(max_examples=200)
@given(st.lists(st.sampled_from(_ALL_STATES), max_size=20))
def test_abort_always_reaches_inactive(transitions: list[RecorderState]) -> None:
    sm = RecorderStateMachine()
    for target in transitions:
        try:
            sm.transition(target)
        except InvalidStateTransition:
            pass
    sm.abort()
    assert sm.state == RecorderState.INACTIVE
    assert sm.is_inactive


@settings(max_examples=200)
@given(st.lists(st.sampled_from(_ALL_STATES), max_size=20))
def test_abort_is_idempotent(transitions: list[RecorderState]) -> None:
    sm = RecorderStateMachine()
    for target in transitions:
        try:
            sm.transition(target)
        except InvalidStateTransition:
            pass
    sm.abort()
    state_after_first = sm.state
    sm.abort()
    sm.abort()
    assert sm.state == state_after_first == RecorderState.INACTIVE


@settings(max_examples=200)
@given(st.sampled_from(_ALL_STATES), st.sampled_from(_ALL_STATES))
def test_invalid_transition_always_raises(from_state: RecorderState, to_state: RecorderState) -> None:
    sm = RecorderStateMachine()
    # Force the machine into ``from_state`` by overriding the internal field;
    # abort() then would reset, so we go through the (legal) abort + private set.
    sm._state = from_state  # type: ignore[attr-defined]  # noqa: SLF001
    if to_state in _VALID_TRANSITIONS[from_state]:
        old = sm.transition(to_state)
        assert old == from_state
        assert sm.state == to_state
    else:
        with pytest.raises(InvalidStateTransition):
            sm.transition(to_state)
        # State must not have moved on failure.
        assert sm.state == from_state


@settings(max_examples=200)
@given(st.sampled_from(_ALL_STATES), st.sampled_from(_ALL_STATES))
def test_valid_transitions_are_deterministic(from_state: RecorderState, to_state: RecorderState) -> None:
    if to_state not in _VALID_TRANSITIONS[from_state]:
        return
    sm_a = RecorderStateMachine()
    sm_b = RecorderStateMachine()
    sm_a._state = from_state  # type: ignore[attr-defined]  # noqa: SLF001
    sm_b._state = from_state  # type: ignore[attr-defined]  # noqa: SLF001
    old_a = sm_a.transition(to_state)
    old_b = sm_b.transition(to_state)
    assert old_a == old_b == from_state
    assert sm_a.state == sm_b.state == to_state


class StateMachineModel(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.sm = RecorderStateMachine()

    @rule(target_state=st.sampled_from(_ALL_STATES))
    def try_transition(self, target_state: RecorderState) -> None:
        current = self.sm.state
        if target_state in _VALID_TRANSITIONS[current]:
            old = self.sm.transition(target_state)
            assert old == current
            assert self.sm.state == target_state
        else:
            with pytest.raises(InvalidStateTransition):
                self.sm.transition(target_state)
            assert self.sm.state == current

    @rule()
    def do_abort(self) -> None:
        self.sm.abort()
        assert self.sm.state == RecorderState.INACTIVE

    @invariant()
    def state_is_a_valid_enum(self) -> None:
        assert self.sm.state in _ALL_STATES

    @invariant()
    def boolean_props_match_state(self) -> None:
        assert self.sm.is_recording == (self.sm.state == RecorderState.RECORDING)
        assert self.sm.is_inactive == (self.sm.state == RecorderState.INACTIVE)


TestStateMachineModel = StateMachineModel.TestCase
TestStateMachineModel.settings = settings(max_examples=100, stateful_step_count=30)
