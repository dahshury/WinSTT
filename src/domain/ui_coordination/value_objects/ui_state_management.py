"""UI state management domain value objects.

This module contains domain concepts related to UI state management
that are independent of infrastructure concerns.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Any

from src.domain.common.result import Result


class UIState(Enum):
    """Enumeration of UI states for domain operations."""
    ENABLED = "enabled"
    DISABLED = "disabled"
    LOADING = "loading"
    RECORDING = "recording"
    PROCESSING = "processing"
    ERROR = "error"
    SUCCESS = "success"


class OpacityLevel(Enum):
    """Predefined opacity levels for different UI states."""
    FULLY_VISIBLE = 1.0
    SEMI_TRANSPARENT = 0.7
    DISABLED = 0.5
    BARELY_VISIBLE = 0.3
    HIDDEN = 0.0


@dataclass
class StateDefinition:
    """Definition of a UI state with its properties."""
    name: str
    properties: dict[str, Any]
    transitions: list[str]
    
    def validate(self) -> Result[None]:
        """Validate the state definition."""
        if not self.name:
            return Result.failure("State name cannot be empty")
        return Result.success(None)


@dataclass
class StateTransition:
    """Represents a transition between UI states."""
    from_state: str
    to_state: str
    trigger: str
    conditions: dict[str, Any]
    
    def is_valid(self) -> bool:
        """Check if the transition is valid."""
        return bool(self.from_state and self.to_state and self.trigger)


@dataclass
class StateTransitionResult:
    """Result of a state transition operation."""
    success: bool
    from_state: str
    to_state: str
    message: str | None = None
    metadata: dict[str, Any] | None = None
    
    @classmethod
    def success_result(cls, from_state: str, to_state: str, message: str = "") -> "StateTransitionResult":
        """Create a successful transition result."""
        return cls(
            success=True,
            from_state=from_state,
            to_state=to_state,
            message=message,
        )
    
    @classmethod
    def failure_result(cls, from_state: str, to_state: str, message: str) -> "StateTransitionResult":
        """Create a failed transition result."""
        return cls(
            success=False,
            from_state=from_state,
            to_state=to_state,
            message=message,
        )