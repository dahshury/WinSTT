"""Window State Management Value Objects.

This module defines value objects for window state management including
results, phases, states, and transitions.
"""

from enum import Enum

from src_refactored.domain.common.value_object import ValueObject


class ManageResult(ValueObject, Enum):
    """Enumeration of possible window state management results."""
    SUCCESS = "success"
    STATE_CHANGE_FAILED = "state_change_failed"
    PERSISTENCE_FAILED = "persistence_failed"
    RESTORATION_FAILED = "restoration_failed"
    VALIDATION_ERROR = "validation_error"
    UNSUPPORTED_STATE = "unsupported_state"
    GEOMETRY_ERROR = "geometry_error"
    INTERNAL_ERROR = "internal_error"


class ManagePhase(ValueObject, Enum):
    """Enumeration of window state management phases."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    STATE_BACKUP = "state_backup"
    STATE_TRANSITION = "state_transition"
    GEOMETRY_ADJUSTMENT = "geometry_adjustment"
    PERSISTENCE = "persistence"
    FINALIZATION = "finalization"


class WindowState(ValueObject, Enum):
    """Enumeration of window states."""
    NORMAL = "normal"
    MINIMIZED = "minimized"
    MAXIMIZED = "maximized"
    FULLSCREEN = "fullscreen"
    HIDDEN = "hidden"
    ACTIVE = "active"
    INACTIVE = "inactive"
    RESTORED = "restored"


class StateTransition(ValueObject, Enum):
    """Enumeration of state transition types."""
    MINIMIZE = "minimize"
    MAXIMIZE = "maximize"
    RESTORE = "restore"
    HIDE = "hide"
    SHOW = "show"
    ACTIVATE = "activate"
    DEACTIVATE = "deactivate"
    FULLSCREEN = "fullscreen"
    EXIT_FULLSCREEN = "exit_fullscreen"