from __future__ import annotations

import pytest

from src.recorder.domain.errors import InvalidStateTransition
from src.recorder.domain.state_machine import RecorderState, RecorderStateMachine


class TestRecorderStateMachine:
    def test_initial_state_is_inactive(self) -> None:
        sm = RecorderStateMachine()
        assert sm.state == RecorderState.INACTIVE

    def test_inactive_to_listening(self) -> None:
        sm = RecorderStateMachine()
        old = sm.transition(RecorderState.LISTENING)
        assert old == RecorderState.INACTIVE
        assert sm.state == RecorderState.LISTENING

    def test_inactive_to_wakeword(self) -> None:
        sm = RecorderStateMachine()
        sm.transition(RecorderState.WAKEWORD)
        assert sm.state == RecorderState.WAKEWORD

    def test_listening_to_recording(self) -> None:
        sm = RecorderStateMachine()
        sm.transition(RecorderState.LISTENING)
        sm.transition(RecorderState.RECORDING)
        assert sm.state == RecorderState.RECORDING

    def test_listening_to_wakeword(self) -> None:
        sm = RecorderStateMachine()
        sm.transition(RecorderState.LISTENING)
        sm.transition(RecorderState.WAKEWORD)
        assert sm.state == RecorderState.WAKEWORD

    def test_wakeword_to_listening(self) -> None:
        sm = RecorderStateMachine()
        sm.transition(RecorderState.WAKEWORD)
        sm.transition(RecorderState.LISTENING)
        assert sm.state == RecorderState.LISTENING

    def test_recording_to_transcribing(self) -> None:
        sm = RecorderStateMachine()
        sm.transition(RecorderState.LISTENING)
        sm.transition(RecorderState.RECORDING)
        sm.transition(RecorderState.TRANSCRIBING)
        assert sm.state == RecorderState.TRANSCRIBING

    def test_transcribing_to_inactive(self) -> None:
        sm = RecorderStateMachine()
        sm.transition(RecorderState.LISTENING)
        sm.transition(RecorderState.RECORDING)
        sm.transition(RecorderState.TRANSCRIBING)
        sm.transition(RecorderState.INACTIVE)
        assert sm.state == RecorderState.INACTIVE

    def test_invalid_transition_raises(self) -> None:
        sm = RecorderStateMachine()
        with pytest.raises(InvalidStateTransition):
            sm.transition(RecorderState.RECORDING)

    def test_invalid_transition_from_recording_to_listening(self) -> None:
        sm = RecorderStateMachine()
        sm.transition(RecorderState.LISTENING)
        sm.transition(RecorderState.RECORDING)
        with pytest.raises(InvalidStateTransition):
            sm.transition(RecorderState.LISTENING)

    def test_abort_from_recording(self) -> None:
        sm = RecorderStateMachine()
        sm.transition(RecorderState.LISTENING)
        sm.transition(RecorderState.RECORDING)
        old = sm.abort()
        assert old == RecorderState.RECORDING
        assert sm.state == RecorderState.INACTIVE

    def test_abort_from_inactive(self) -> None:
        sm = RecorderStateMachine()
        old = sm.abort()
        assert old == RecorderState.INACTIVE
        assert sm.state == RecorderState.INACTIVE

    def test_is_recording_property(self) -> None:
        sm = RecorderStateMachine()
        assert not sm.is_recording
        sm.transition(RecorderState.LISTENING)
        sm.transition(RecorderState.RECORDING)
        assert sm.is_recording

    def test_is_inactive_property(self) -> None:
        sm = RecorderStateMachine()
        assert sm.is_inactive
        sm.transition(RecorderState.LISTENING)
        assert not sm.is_inactive
