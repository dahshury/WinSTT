"""Window State Management Value Objects.

This module defines value objects for window state management including
results, phases, states, and transitions.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from src_refactored.domain.common.value_object import ValueObject


class ManageResult(Enum):
    """Enumeration of possible window state management results."""
    SUCCESS = "success"
    STATE_CHANGE_FAILED = "state_change_failed"
    PERSISTENCE_FAILED = "persistence_failed"
    RESTORATION_FAILED = "restoration_failed"
    VALIDATION_ERROR = "validation_error"
    UNSUPPORTED_STATE = "unsupported_state"
    GEOMETRY_ERROR = "geometry_error"
    INTERNAL_ERROR = "internal_error"


class ManagePhase(Enum):
    """Enumeration of window state management phases."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    STATE_BACKUP = "state_backup"
    STATE_TRANSITION = "state_transition"
    GEOMETRY_ADJUSTMENT = "geometry_adjustment"
    PERSISTENCE = "persistence"
    FINALIZATION = "finalization"


class WindowState(Enum):
    """Enumeration of window states."""
    NORMAL = "normal"
    MINIMIZED = "minimized"
    MAXIMIZED = "maximized"
    FULLSCREEN = "fullscreen"
    HIDDEN = "hidden"
    ACTIVE = "active"
    INACTIVE = "inactive"
    RESTORED = "restored"


class StateTransition(Enum):
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


@dataclass(frozen=True)
class WindowStateManager(ValueObject):
    """Manages window state transitions and persistence."""
    
    current_state: WindowState
    previous_state: WindowState | None = None
    pending_transition: StateTransition | None = None
    state_history: dict[str, Any] | None = None
    is_transitioning: bool = False
    
    def __post_init__(self) -> None:
        """Validate the state manager parameters."""
        if not isinstance(self.current_state, WindowState):
            msg = "current_state must be a WindowState"
            raise ValueError(msg)
        
        if self.previous_state is not None and not isinstance(self.previous_state, WindowState):
            msg = "previous_state must be a WindowState or None"
            raise ValueError(msg)
            
        if self.pending_transition is not None and not isinstance(self.pending_transition, StateTransition):
            msg = "pending_transition must be a StateTransition or None"
            raise ValueError(msg)
    
    def with_state(self, new_state: WindowState) -> WindowStateManager:
        """Create a new state manager with a different current state."""
        return WindowStateManager(
            current_state=new_state,
            previous_state=self.current_state,
            pending_transition=self.pending_transition,
            state_history=self.state_history,
            is_transitioning=self.is_transitioning,
        )
    
    def with_transition(self, transition: StateTransition) -> WindowStateManager:
        """Create a new state manager with a pending transition."""
        return WindowStateManager(
            current_state=self.current_state,
            previous_state=self.previous_state,
            pending_transition=transition,
            state_history=self.state_history,
            is_transitioning=True,
        )
    
    def complete_transition(self, new_state: WindowState) -> WindowStateManager:
        """Complete a transition and move to the new state."""
        return WindowStateManager(
            current_state=new_state,
            previous_state=self.current_state,
            pending_transition=None,
            state_history=self.state_history,
            is_transitioning=False,
        )
    
    def cancel_transition(self) -> WindowStateManager:
        """Cancel any pending transition."""
        return WindowStateManager(
            current_state=self.current_state,
            previous_state=self.previous_state,
            pending_transition=None,
            state_history=self.state_history,
            is_transitioning=False,
        )