"""Window state value object."""

from dataclasses import dataclass
from enum import Enum

from src.domain.common.value_object import ValueObject


class WindowState(Enum):
    """Window state enumeration."""
    NORMAL = "normal"
    MINIMIZED = "minimized"
    MAXIMIZED = "maximized"
    FULLSCREEN = "fullscreen"
    HIDDEN = "hidden"
    CLOSED = "closed"


@dataclass(frozen=True)
class WindowConfiguration(ValueObject):
    """Window configuration value object."""
    
    state: WindowState = WindowState.NORMAL
    resizable: bool = True
    always_on_top: bool = False
    has_title_bar: bool = True
    
    def is_visible(self) -> bool:
        """Check if window is visible."""
        return self.state not in [WindowState.HIDDEN, WindowState.CLOSED]
    
    def is_interactive(self) -> bool:
        """Check if window can receive user input."""
        return self.state in [WindowState.NORMAL, WindowState.MAXIMIZED, WindowState.FULLSCREEN]
