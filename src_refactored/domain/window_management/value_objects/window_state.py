"""Window State Value Object

Defines the possible states a window can be in.
"""

from enum import Enum


class WindowState(Enum):
    """Window states."""
    NORMAL = "normal"
    MINIMIZED = "minimized"
    MAXIMIZED = "maximized"
    HIDDEN = "hidden"
    FULLSCREEN = "fullscreen"
    UNKNOWN = "unknown"