"""UI coordination type definitions.

This module provides type definitions needed for UI coordination.
"""

from dataclasses import dataclass
from enum import Enum

from src.domain.common.value_object import ValueObject


class ElementType(Enum):
    """UI element types."""
    BUTTON = "button"
    LABEL = "label"
    INPUT = "input"
    PROGRESS_BAR = "progress_bar"
    ICON = "icon"
    CONTAINER = "container"


class InteractionState(Enum):
    """UI interaction states."""
    IDLE = "idle"
    HOVER = "hover"
    PRESSED = "pressed"
    FOCUSED = "focused"
    DISABLED = "disabled"


class UIElementState(Enum):
    """General UI element states."""
    VISIBLE = "visible"
    HIDDEN = "hidden"
    ENABLED = "enabled"
    DISABLED = "disabled"
    LOADING = "loading"
    ERROR = "error"


class VisibilityState(Enum):
    """Visibility states for UI elements."""
    VISIBLE = "visible"
    HIDDEN = "hidden"
    COLLAPSED = "collapsed"
    FADING_IN = "fading_in"
    FADING_OUT = "fading_out"


class MessageType(Enum):
    """Message types for notifications."""
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    SUCCESS = "success"


class MessagePriority(Enum):
    """Message priority levels."""
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass(frozen=True)
class MessageDisplay(ValueObject):
    """Configuration for message display."""
    type: MessageType
    priority: MessagePriority
    duration_ms: int = 3000
    auto_dismiss: bool = True


@dataclass(frozen=True)
class DisplayBehavior(ValueObject):
    """Display behavior configuration."""
    fade_in_duration: int = 300
    fade_out_duration: int = 300
    show_animation: bool = True
    hide_animation: bool = True
