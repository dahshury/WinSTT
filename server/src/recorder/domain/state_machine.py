from __future__ import annotations

from enum import Enum, auto

from src.recorder.domain.errors import InvalidStateTransition


class RecorderState(Enum):
    INACTIVE = auto()
    LISTENING = auto()
    WAKEWORD = auto()
    RECORDING = auto()
    TRANSCRIBING = auto()


_VALID_TRANSITIONS: dict[RecorderState, set[RecorderState]] = {
    RecorderState.INACTIVE: {RecorderState.LISTENING, RecorderState.WAKEWORD},
    RecorderState.LISTENING: {RecorderState.RECORDING, RecorderState.WAKEWORD, RecorderState.INACTIVE},
    RecorderState.WAKEWORD: {RecorderState.LISTENING, RecorderState.INACTIVE},
    RecorderState.RECORDING: {RecorderState.TRANSCRIBING, RecorderState.INACTIVE},
    RecorderState.TRANSCRIBING: {RecorderState.INACTIVE, RecorderState.LISTENING},
}


class RecorderStateMachine:
    def __init__(self) -> None:
        self._state = RecorderState.INACTIVE

    @property
    def state(self) -> RecorderState:
        return self._state

    def transition(self, new_state: RecorderState) -> RecorderState:
        if new_state not in _VALID_TRANSITIONS.get(self._state, set()):
            raise InvalidStateTransition(f"Cannot transition from {self._state.name} to {new_state.name}")
        old_state = self._state
        self._state = new_state
        return old_state

    def abort(self) -> RecorderState:
        old_state = self._state
        self._state = RecorderState.INACTIVE
        return old_state

    @property
    def is_recording(self) -> bool:
        return self._state == RecorderState.RECORDING

    @property
    def is_inactive(self) -> bool:
        return self._state == RecorderState.INACTIVE
