"""UI coordination value objects.

Note: UI-specific value objects have been moved to the presentation layer.
"""

# Temporarily create missing animation value objects as placeholders
from dataclasses import dataclass
from enum import Enum

from src.domain.common.value_object import ValueObject

from .ui_coordination_types import (
    DisplayBehavior,
    ElementType,
    InteractionState,
    MessageDisplay,
    MessagePriority,
    MessageType,
    UIElementState,
    VisibilityState,
)
from .window_position import WindowPosition
from .window_size import WindowSize
from .window_state import WindowConfiguration, WindowState


class AnimationType(Enum):
    """Animation type enumeration."""
    FADE_IN = "fade_in"
    FADE_OUT = "fade_out"
    SLIDE_IN = "slide_in"
    SLIDE_OUT = "slide_out"

class AnimationState(Enum):
    """Animation state enumeration."""
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"

@dataclass(frozen=True)
class AnimationEasing(ValueObject):
    """Animation easing configuration."""
    type: str = "linear"
    duration_ms: float = 300.0

__all__ = [
    "AnimationEasing",
    "AnimationState",
    "AnimationType",
    "DisplayBehavior",
    "ElementType",
    "InteractionState",
    "MessageDisplay",
    "MessagePriority",
    "MessageType",
    "UIElementState",
    "VisibilityState",
    "WindowConfiguration",
    "WindowPosition",
    "WindowSize",
    "WindowState",
]