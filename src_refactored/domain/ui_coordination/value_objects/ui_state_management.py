"""UI state management domain value objects.

This module contains domain concepts related to UI state management
that are independent of infrastructure concerns.
"""

from enum import Enum


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