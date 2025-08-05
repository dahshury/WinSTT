"""Progress bar lifecycle entity for progress management domain."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any

from src_refactored.domain.common import Entity


class ProgressBarState(Enum):
    """Progress bar lifecycle state enumeration."""
    IDLE = "idle"
    ATTACHED = "attached"
    REPARENTING = "reparenting"
    ACTIVE = "active"
    RESTORING = "restoring"
    DETACHED = "detached"
    ERROR = "error"


class ReparentingOperation(Enum):
    """Progress bar reparenting operation type."""
    MOVE_TO_DIALOG = "move_to_dialog"
    RESTORE_TO_PARENT = "restore_to_parent"
    MOVE_TO_PLACEHOLDER = "move_to_placeholder"
    DETACH_FROM_LAYOUT = "detach_from_layout"


@dataclass
class ProgressBarGeometry:
    """Progress bar geometry information."""
    x: int
    y: int
    width: int
    height: int

    def __post_init__(self):
        """Validate geometry values."""
        if self.width <= 0 or self.height <= 0:
            msg = "Width and height must be positive"
            raise ValueError(msg)

    def to_tuple(self,
    ) -> tuple[int, int, int, int]:
        """Convert to tuple (x, y, width, height)."""
        return (self.x, self.y, self.width, self.height)

    @classmethod
    def from_tuple(cls, geometry: tuple[int, int, int, int]) -> ProgressBarGeometry:
        """Create from tuple (x, y, width, height)."""
        return cls(x=geometry[0], y=geometry[1], width=geometry[2], height=geometry[3])


@dataclass
class ProgressBarConfiguration:
    """Progress bar lifecycle configuration."""
    bar_id: str
    debounce_interval_ms: int = 200
    auto_restore_on_complete: bool = True
    preserve_visibility: bool = True
    enable_animations: bool = True
    timeout_seconds: int | None = None

    def __post_init__(self):
        """Validate configuration."""
        if not self.bar_id:
            msg = "Bar ID cannot be empty"
            raise ValueError(msg)
        if self.debounce_interval_ms < 0:
            msg = "Debounce interval cannot be negative"
            raise ValueError(msg)
        if self.timeout_seconds is not None and self.timeout_seconds <= 0:
            msg = "Timeout must be positive"
            raise ValueError(msg,
    )


@dataclass
class ParentContext:
    """Parent widget context information."""
    parent_id: str
    parent_type: str
    geometry: ProgressBarGeometry | None = None
    layout_index: int | None = None
    visibility: bool = True
    z_order: int | None = None
    custom_properties: dict[str, Any] | None = None

    def __post_init__(self):
        """Validate parent context."""
        if not self.parent_id:
            msg = "Parent ID cannot be empty"
            raise ValueError(msg)
        if not self.parent_type:
            msg = "Parent type cannot be empty"
            raise ValueError(msg)
        if self.layout_index is not None and self.layout_index < 0:
            msg = "Layout index cannot be negative"
            raise ValueError(msg)


class ProgressBarLifecycle(Entity[str],
    ):
    """Progress bar lifecycle entity managing reparenting and state transitions."""

    def __init__(self, configuration: ProgressBarConfiguration,
    ):
        super().__init__(configuration.bar_id)
        self._configuration = configuration
        self._state = ProgressBarState.IDLE
        self._current_parent: ParentContext | None = None
        self._original_parent: ParentContext | None = None
        self._target_parent: ParentContext | None = None
        self._operation_start_time: datetime | None = None
        self._last_operation: ReparentingOperation | None = None
        self._error_message: str | None = None
        self._is_moving = False
        self._operation_count = 0
        self._custom_data: dict[str, Any] = {}
        self.validate()

    def attach_to_parent(self, parent_context: ParentContext,
    ) -> bool:
        """Attach progress bar to initial parent."""
        if self._state != ProgressBarState.IDLE:
            return False

        self._state = ProgressBarState.ATTACHED
        self._current_parent = parent_context
        self._original_parent = parent_context
        self._operation_count += 1

        self.mark_as_updated()
        return True

    def start_reparenting(self, target_parent: ParentContext, operation: ReparentingOperation,
    ) -> bool:
        """Start reparenting operation."""
        if self._state not in [ProgressBarState.ATTACHED, ProgressBarState.ACTIVE] or self._is_moving:
            return False

        self._state = ProgressBarState.REPARENTING
        self._target_parent = target_parent
        self._last_operation = operation
        self._operation_start_time = datetime.now()
        self._is_moving = True
        self._operation_count += 1

        self.mark_as_updated()
        return True

    def complete_reparenting(self, success: bool = True) -> bool:
        """Complete reparenting operation."""
        if self._state != ProgressBarState.REPARENTING or not self._is_moving:
            return False

        if success and self._target_parent:
            self._current_parent = self._target_parent
            self._state = ProgressBarState.ACTIVE
        else:
            # Restore to previous parent on failure
self._state = (
    ProgressBarState.ATTACHED if self._current_parent else ProgressBarState.IDLE)

        self._target_parent = None
        self._operation_start_time = None
        self._is_moving = False

        self.mark_as_updated()
        return True

    def start_restoration(self,
    ) -> bool:
        """Start restoration to original parent."""
        if (self._state not in [ProgressBarState.ACTIVE, ProgressBarState.ATTACHED] or
            self._is_moving or not self._original_parent):
            return False

        self._state = ProgressBarState.RESTORING
        self._target_parent = self._original_parent
        self._last_operation = ReparentingOperation.RESTORE_TO_PARENT
        self._operation_start_time = datetime.now()
        self._is_moving = True
        self._operation_count += 1

        self.mark_as_updated()
        return True

    def complete_restoration(self, success: bool = True) -> bool:
        """Complete restoration operation."""
        if self._state != ProgressBarState.RESTORING or not self._is_moving:
            return False

        if success and self._original_parent:
            self._current_parent = self._original_parent
            self._state = ProgressBarState.ATTACHED
        else:
            self._state = ProgressBarState.ACTIVE

        self._target_parent = None
        self._operation_start_time = None
        self._is_moving = False

        self.mark_as_updated()
        return True

    def detach(self) -> bool:
        """Detach progress bar from all parents."""
        if self._state == ProgressBarState.DETACHED or self._is_moving:
            return False

        self._state = ProgressBarState.DETACHED
        self._current_parent = None
        self._target_parent = None
        self._operation_count += 1

        self.mark_as_updated(,
    )
        return True

    def error(self, error_message: str,
    ) -> bool:
        """Mark lifecycle as error state."""
        if self._state == ProgressBarState.DETACHED:
            return False

        self._state = ProgressBarState.ERROR
        self._error_message = error_message
        self._is_moving = False
        self._target_parent = None
        self._operation_start_time = None

        self.mark_as_updated()
        return True

    def reset(self) -> bool:
        """Reset lifecycle to idle state."""
        self._state = ProgressBarState.IDLE
        self._current_parent = None
        self._original_parent = None
        self._target_parent = None
        self._operation_start_time = None
        self._last_operation = None
        self._error_message = None
        self._is_moving = False
        self._operation_count = 0
        self._custom_data.clear()

        self.mark_as_updated()
        return True

    def update_current_parent_geometry(self, geometry: ProgressBarGeometry,
    ) -> bool:
        """Update current parent geometry."""
        if not self._current_parent:
            return False

        self._current_parent = ParentContext(
            parent_id=self._current_parent.parent_id,
            parent_type=self._current_parent.parent_type,
            geometry=geometry,
            layout_index=self._current_parent.layout_index,
            visibility=self._current_parent.visibility,
            z_order=self._current_parent.z_order,
            custom_properties=self._current_parent.custom_properties,
        )

        self.mark_as_updated()
        return True

    def update_visibility(self, visible: bool,
    ) -> bool:
        """Update visibility state."""
        if not self._current_parent:
            return False

        self._current_parent = ParentContext(
            parent_id=self._current_parent.parent_id,
            parent_type=self._current_parent.parent_type,
            geometry=self._current_parent.geometry,
            layout_index=self._current_parent.layout_index,
            visibility=visible,
            z_order=self._current_parent.z_order,
            custom_properties=self._current_parent.custom_properties,
        )

        self.mark_as_updated()
        return True

    def set_custom_data(self, key: str, value: Any,
    ) -> None:
        """Set custom data for the lifecycle."""
        self._custom_data[key] = value
        self.mark_as_updated()

    def get_custom_data(self, key: str, default: Any = None,
    ) -> Any:
        """Get custom data from the lifecycle."""
        return self._custom_data.get(key, default)

    def get_operation_duration(self) -> float | None:
        """Get current operation duration in seconds."""
        if not self._operation_start_time:
            return None

        return (datetime.now() - self._operation_start_time).total_seconds()

    def is_operation_timeout(self) -> bool:
        """Check if current operation has timed out."""
        if not self._configuration.timeout_seconds or not self._operation_start_time:
            return False

        duration = self.get_operation_duration()
        return duration is not None and duration > self._configuration.timeout_seconds

    def can_start_operation(self) -> bool:
        """Check if a new operation can be started."""
        return not self._is_moving and self._state not in [ProgressBarState.DETACHED, ProgressBarState.ERROR]

    def should_auto_restore(self) -> bool:
        """Check if should auto-restore to original parent."""
        return (
            self._configuration.auto_restore_on_complete and
            self._state == ProgressBarState.ACTIVE and
            self._original_parent is not None and
            self._current_parent != self._original_parent
        )

    def get_restore_target(self) -> ParentContext | None:
        """Get restoration target parent."""
        return self._original_parent

    # Properties
    @property
    def configuration(self) -> ProgressBarConfiguration:
        """Get lifecycle configuration."""
        return self._configuration

    @property
    def state(self) -> ProgressBarState:
        """Get current lifecycle state."""
        return self._state

    @property
    def current_parent(self) -> ParentContext | None:
        """Get current parent context."""
        return self._current_parent

    @property
    def original_parent(self) -> ParentContext | None:
        """Get original parent context."""
        return self._original_parent

    @property
    def target_parent(self) -> ParentContext | None:
        """Get target parent context."""
        return self._target_parent

    @property
    def last_operation(self) -> ReparentingOperation | None:
        """Get last reparenting operation."""
        return self._last_operation

    @property
    def error_message(self) -> str | None:
        """Get error message if in error state."""
        return self._error_message

    @property
    def is_moving(self) -> bool:
        """Check if currently performing reparenting operation."""
        return self._is_moving

    @property
    def is_attached(self) -> bool:
        """Check if attached to a parent."""
        return self._state in [ProgressBarState.ATTACHED,
        ProgressBarState.ACTIVE, ProgressBarState.REPARENTING, ProgressBarState.RESTORING]

    @property
    def is_active(self) -> bool:
        """Check if in active state."""
        return self._state == ProgressBarState.ACTIVE

    @property
    def is_in_error(self) -> bool:
        """Check if in error state."""
        return self._state == ProgressBarState.ERROR

    @property
    def operation_count(self) -> int:
        """Get number of operations performed."""
        return self._operation_count

    def __invariants__(self) -> None:
        """Validate progress bar lifecycle invariants."""
        if self._state == ProgressBarState.ATTACHED and not self._current_parent:
            msg = "Attached state must have current parent"
            raise ValueError(msg)

        if self._state == ProgressBarState.REPARENTING and not self._target_parent:
            msg = "Reparenting state must have target parent"
            raise ValueError(msg)

        if self._state == ProgressBarState.REPARENTING and not self._is_moving:
            msg = "Reparenting state must have moving flag set"
            raise ValueError(msg)

        if self._state == ProgressBarState.ERROR and not self._error_message:
            msg = "Error state must have error message"
            raise ValueError(msg,
    )

        if self._is_moving and self._state not in [ProgressBarState.REPARENTING, ProgressBarState.RESTORING]:
            msg = "Moving flag can only be set during reparenting or restoring"
            raise ValueError(msg)