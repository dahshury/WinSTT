"""Element type value object for UI coordination.

Moved from domain layer to presentation layer as this is UI-specific presentation logic.
"""

from enum import Enum


class ElementType(Enum):
    """Types of UI elements."""
    LABEL = "label"
    BUTTON = "button"
    PROGRESS_BAR = "progress_bar"
    VISUALIZER = "visualizer"
    LOGO = "logo"
    TITLE = "title"
    INSTRUCTION = "instruction"
    SETTINGS = "settings"
    TRAY_ICON = "tray_icon"


class VisibilityState(Enum):
    """Visibility states for UI elements."""
    VISIBLE = "visible"
    HIDDEN = "hidden"
    DIMMED = "dimmed"
    FADING_IN = "fading_in"
    FADING_OUT = "fading_out"


class InteractionState(Enum):
    """Interaction states for UI elements."""
    ENABLED = "enabled"
    DISABLED = "disabled"
    BLOCKED = "blocked"
    LOADING = "loading"