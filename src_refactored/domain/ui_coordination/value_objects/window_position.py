"""Window position value object."""

from dataclasses import dataclass

from src_refactored.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class WindowPosition(ValueObject):
    """Value object representing a window position."""
    
    x: int
    y: int
    
    @classmethod
    def origin(cls) -> "WindowPosition":
        """Create position at origin (0, 0)."""
        return cls(0, 0)
    
    @classmethod
    def center_of_screen(cls, screen_width: int, screen_height: int, window_width: int, window_height: int) -> "WindowPosition":
        """Create position that centers window on screen."""
        x = (screen_width - window_width) // 2
        y = (screen_height - window_height) // 2
        return cls(x, y)
    
    def __post_init__(self) -> None:
        """Validate the position values."""
        if not isinstance(self.x, int) or not isinstance(self.y, int):
            msg = "Position coordinates must be integers"
            raise ValueError(msg)
    
    def offset(self, dx: int, dy: int) -> "WindowPosition":
        """Create new position offset by given amounts."""
        return WindowPosition(self.x + dx, self.y + dy)
    
    def to_tuple(self) -> tuple[int, int]:
        """Convert to tuple of (x, y)."""
        return (self.x, self.y)
