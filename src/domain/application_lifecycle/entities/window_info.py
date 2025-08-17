"""Window Information Entity.

This module contains the WindowInfo entity representing information about application windows.
"""

from dataclasses import dataclass
from typing import Any

from src.domain.common.entity import Entity
from src.domain.window_management.value_objects import WindowState


@dataclass
class WindowInfo(Entity):
    """Information about a window.
    
    This entity represents the core information about an application window,
    including its handle, title, state, and properties.
    """

    handle: Any
    title: str
    class_name: str | None = None
    process_id: int | None = None
    state: WindowState = WindowState.UNKNOWN
    is_visible: bool = True
    is_enabled: bool = True
    rect: tuple[int, int, int, int] | None = None  # (left, top, right, bottom)

    def __post_init__(self) -> None:
        # Use title as the entity ID if no explicit ID is provided
        if not hasattr(self, "_id") or self._id is None:
            super().__init__(self.title)

    def is_minimized(self) -> bool:
        """Check if the window is minimized."""
        return self.state == WindowState.MINIMIZED

    def is_maximized(self) -> bool:
        """Check if the window is maximized."""
        return self.state == WindowState.MAXIMIZED

    def is_normal(self) -> bool:
        """Check if the window is in normal state."""
        return self.state == WindowState.NORMAL

    def is_accessible(self) -> bool:
        """Check if the window is accessible (visible and enabled)."""
        return self.is_visible and self.is_enabled

    def get_dimensions(self) -> tuple[int, int] | None:
        """Get window dimensions (width, height)."""
        if self.rect is None:
            return None
        left, top, right, bottom = self.rect
        return (right - left, bottom - top)

    def get_position(self) -> tuple[int, int] | None:
        """Get window position (x, y)."""
        if self.rect is None:
            return None
        return (self.rect[0], self.rect[1])

    def __invariants__(self) -> None:
        """Validate entity invariants."""
        if not self.title:
            msg = "Window must have a title"
            raise ValueError(msg)
        if self.handle is None:
            msg = "Window must have a handle"
            raise ValueError(msg)
        if self.rect is not None and len(self.rect) != 4:
            msg = "Window rect must have 4 coordinates"
            raise ValueError(msg,
    )