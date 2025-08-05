"""State management domain concepts.

This module contains domain value objects and enums for UI state management,
defining the core concepts for state transitions and state definitions.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class StateTransitionResult(Enum):
    """Result of state transition."""
    SUCCESS = "success"
    FAILED = "failed"
    BLOCKED = "blocked"
    INVALID = "invalid"


@dataclass
class StateTransition:
    """Represents a state transition."""
    from_state: str
    to_state: str
    trigger: str
    data: dict[str, Any] = field(default_factory=dict)
    result: StateTransitionResult = StateTransitionResult.SUCCESS
    error_message: str = ""


@dataclass
class StateDefinition:
    """Definition of a UI state."""
    name: str
    data: dict[str, Any] = field(default_factory=dict)
    entry_actions: list[str] = field(default_factory=list)
    exit_actions: list[str] = field(default_factory=list)
    allowed_transitions: set[str] = field(default_factory=set)
    is_persistent: bool = False
    timeout_ms: int | None = None

    def can_transition_to(self, target_state: str,
    ) -> bool:
        """Check if transition to target state is allowed.
        
        Args:
            target_state: Target state name
            
        Returns:
            True if transition is allowed, False otherwise
        """
        return not self.allowed_transitions or target_state in self.allowed_transitions