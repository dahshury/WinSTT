"""Progress state value object for progress management domain."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common import ValueObject


class ProgressStateType(Enum):
    """Enumeration of progress state types."""
    IDLE = "idle"
    DOWNLOADING = "downloading"
    MOVING = "moving"
    PROCESSING = "processing"
    COMPLETED = "completed"
    ERROR = "error"


class ProgressBarMovementState(Enum):
    """Enumeration of progress bar movement states."""
    STATIONARY = "stationary"
    MOVING = "moving"
    REPARENTING = "reparenting"
    RESTORING = "restoring"


class ProgressType(Enum):
    """Enumeration of progress types for different operations."""
    MODEL_DOWNLOAD = "model_download"
    TRANSCRIPTION = "transcription"
    AUDIO_PROCESSING = "audio_processing"
    FILE_OPERATION = "file_operation"
    GENERAL = "general"


@dataclass(frozen=True)
class ProgressState(ValueObject):
    """Value object for progress state validation and management."""

    state_type: ProgressStateType
    is_downloading_model: bool = False
    is_progress_bar_moving: bool = False
    movement_state: ProgressBarMovementState = ProgressBarMovementState.STATIONARY
    error_message: str | None = None

    def __post_init__(self) -> None:
        """Validate progress state after initialization."""
        # Validate state consistency
        if self.state_type == ProgressStateType.DOWNLOADING and not self.is_downloading_model:
            msg = "Downloading state requires is_downloading_model to be True"
            raise ValueError(msg)

        if self.state_type == ProgressStateType.MOVING and not self.is_progress_bar_moving:
            msg = "Moving state requires is_progress_bar_moving to be True"
            raise ValueError(msg)

        if self.state_type == ProgressStateType.ERROR and not self.error_message:
            msg = "Error state requires an error message"
            raise ValueError(msg)

        if self.state_type != ProgressStateType.ERROR and self.error_message:
            msg = "Error message can only be set for error state"
            raise ValueError(msg)

        # Validate movement state consistency
        if self.is_progress_bar_moving and self.movement_state == ProgressBarMovementState.STATIONARY:
            msg = "Progress bar cannot be moving while in stationary movement state"
            raise ValueError(msg)

        if not self.is_progress_bar_moving and self.movement_state != ProgressBarMovementState.STATIONARY:
            msg = "Progress bar must be moving for non-stationary movement states"
            raise ValueError(msg)

    @classmethod
    def create_idle(cls,
    ) -> ProgressState:
        """Create an idle progress state."""
        return cls(
            state_type=ProgressStateType.IDLE,
            is_downloading_model=False,
            is_progress_bar_moving=False,
            movement_state=ProgressBarMovementState.STATIONARY,
        )

    @classmethod
    def create_downloading(cls, is_moving: bool = False) -> ProgressState:
        """Create a downloading progress state."""
        movement_state = (
            ProgressBarMovementState.MOVING if is_moving
            else ProgressBarMovementState.STATIONARY
        )

        return cls(
            state_type=ProgressStateType.DOWNLOADING,
            is_downloading_model=True,
            is_progress_bar_moving=is_moving,
            movement_state=movement_state,
        )

    @classmethod
    def create_moving(cls,
    movement_state: ProgressBarMovementState = ProgressBarMovementState.MOVING) -> ProgressState:
        """Create a moving progress state."""
        if movement_state == ProgressBarMovementState.STATIONARY:
            msg = "Cannot create moving state with stationary movement state"
            raise ValueError(msg)

        return cls(
            state_type=ProgressStateType.MOVING,
            is_downloading_model=False,
            is_progress_bar_moving=True,
            movement_state=movement_state,
        )

    @classmethod
    def create_reparenting(cls) -> ProgressState:
        """Create a reparenting progress state."""
        return cls(
            state_type=ProgressStateType.MOVING,
            is_downloading_model=False,
            is_progress_bar_moving=True,
            movement_state=ProgressBarMovementState.REPARENTING,
        )

    @classmethod
    def create_restoring(cls) -> ProgressState:
        """Create a restoring progress state."""
        return cls(
            state_type=ProgressStateType.MOVING,
            is_downloading_model=False,
            is_progress_bar_moving=True,
            movement_state=ProgressBarMovementState.RESTORING,
        )

    @classmethod
    def create_processing(cls) -> ProgressState:
        """Create a processing progress state."""
        return cls(
            state_type=ProgressStateType.PROCESSING,
            is_downloading_model=False,
            is_progress_bar_moving=False,
            movement_state=ProgressBarMovementState.STATIONARY,
        )

    @classmethod
    def create_completed(cls) -> ProgressState:
        """Create a completed progress state."""
        return cls(
            state_type=ProgressStateType.COMPLETED,
            is_downloading_model=False,
            is_progress_bar_moving=False,
            movement_state=ProgressBarMovementState.STATIONARY,
        )

    @classmethod
    def create_error(cls, error_message: str,
    ) -> ProgressState:
        """Create an error progress state."""
        if not error_message or not error_message.strip():
            msg = "Error message cannot be empty"
            raise ValueError(msg)

        return cls(
            state_type=ProgressStateType.ERROR,
            is_downloading_model=False,
            is_progress_bar_moving=False,
            movement_state=ProgressBarMovementState.STATIONARY,
            error_message=error_message.strip(),
        )

    def is_idle(self) -> bool:
        """Check if state is idle."""
        return self.state_type == ProgressStateType.IDLE

    def is_downloading(self) -> bool:
        """Check if state is downloading."""
        return self.state_type == ProgressStateType.DOWNLOADING

    def is_moving(self) -> bool:
        """Check if state is moving."""
        return self.state_type == ProgressStateType.MOVING

    def is_processing(self) -> bool:
        """Check if state is processing."""
        return self.state_type == ProgressStateType.PROCESSING

    def is_completed(self) -> bool:
        """Check if state is completed."""
        return self.state_type == ProgressStateType.COMPLETED

    def is_error(self) -> bool:
        """Check if state is error."""
        return self.state_type == ProgressStateType.ERROR

    def is_active(self) -> bool:
        """Check if state represents an active operation."""
        return self.state_type in {
            ProgressStateType.DOWNLOADING,
            ProgressStateType.MOVING,
            ProgressStateType.PROCESSING,
        }

    def is_terminal(self) -> bool:
        """Check if state is terminal (completed or error)."""
        return self.state_type in {
            ProgressStateType.COMPLETED,
            ProgressStateType.ERROR,
        }

    def can_transition_to(self, new_state_type: ProgressStateType,
    ) -> bool:
        """Check if transition to new state type is valid."""
        # Define valid state transitions
        valid_transitions = {
            ProgressStateType.IDLE: {
                ProgressStateType.DOWNLOADING,
                ProgressStateType.MOVING,
                ProgressStateType.PROCESSING,
            },
            ProgressStateType.DOWNLOADING: {
                ProgressStateType.MOVING,
                ProgressStateType.COMPLETED,
                ProgressStateType.ERROR,
                ProgressStateType.IDLE,
            },
            ProgressStateType.MOVING: {
                ProgressStateType.DOWNLOADING,
                ProgressStateType.PROCESSING,
                ProgressStateType.COMPLETED,
                ProgressStateType.ERROR,
                ProgressStateType.IDLE,
            },
            ProgressStateType.PROCESSING: {
                ProgressStateType.COMPLETED,
                ProgressStateType.ERROR,
                ProgressStateType.IDLE,
            },
            ProgressStateType.COMPLETED: {
                ProgressStateType.IDLE,
            },
            ProgressStateType.ERROR: {
                ProgressStateType.IDLE,
                ProgressStateType.DOWNLOADING,
                ProgressStateType.PROCESSING,
            },
        }

        return new_state_type in valid_transitions.get(self.state_type, set())

    def with_downloading(self, is_downloading: bool,
    ) -> ProgressState:
        """Create new state with updated downloading flag."""
        if is_downloading:
            return self.__class__(
                state_type=ProgressStateType.DOWNLOADING,
                is_downloading_model=True,
                is_progress_bar_moving=self.is_progress_bar_moving,
                movement_state=self.movement_state,
                error_message=None,
            )
        return self.__class__(
            state_type=(
                ProgressStateType.IDLE if self.state_type == ProgressStateType.DOWNLOADING else self.state_type
            ),
            is_downloading_model=False,
            is_progress_bar_moving=self.is_progress_bar_moving,
            movement_state=self.movement_state,
            error_message=self.error_message,
        )

    def with_movement(
    self,
    is_moving: bool,
    movement_state: ProgressBarMovementState | None = None) -> ProgressState:
        """Create new state with updated movement flags."""
        if is_moving:
            new_movement_state = movement_state or ProgressBarMovementState.MOVING
            if new_movement_state == ProgressBarMovementState.STATIONARY:
                msg = "Cannot set moving to True with stationary movement state"
                raise ValueError(msg)

            return self.__class__(
                state_type=(
                    ProgressStateType.MOVING if not self.is_downloading_model else self.state_type
                ),
                is_downloading_model=self.is_downloading_model,
                is_progress_bar_moving=True,
                movement_state=new_movement_state,
                error_message=self.error_message,
            )
        return self.__class__(
            state_type=(
                ProgressStateType.IDLE if self.state_type == ProgressStateType.MOVING
                and not self.is_downloading_model else self.state_type
            ),
            is_downloading_model=self.is_downloading_model,
            is_progress_bar_moving=False,
            movement_state=ProgressBarMovementState.STATIONARY,
            error_message=self.error_message,
        )

    def __str__(self) -> str:
        """String representation of progress state."""
        parts = [self.state_type.value]

        if self.is_downloading_model:
            parts.append("downloading")

        if self.is_progress_bar_moving:
            parts.append(f"moving({self.movement_state.value})")

        if self.error_message:
            parts.append(f"error: {self.error_message}")

        return " | ".join(parts)