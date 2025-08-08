"""Window size value object."""

from dataclasses import dataclass

from src_refactored.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class WindowSize(ValueObject):
    """Value object representing a window size."""
    
    width: int
    height: int
    
    @classmethod
    def default(cls) -> "WindowSize":
        """Create default window size."""
        return cls(800, 600)
    
    @classmethod
    def square(cls, size: int) -> "WindowSize":
        """Create square window with given size."""
        return cls(size, size)
    
    def __post_init__(self) -> None:
        """Validate the size values."""
        if not isinstance(self.width, int) or not isinstance(self.height, int):
            msg = "Size dimensions must be integers"
            raise ValueError(msg)
        if self.width <= 0 or self.height <= 0:
            msg = "Size dimensions must be positive"
            raise ValueError(msg)
    
    def scale(self, factor: float) -> "WindowSize":
        """Create new size scaled by given factor."""
        new_width = int(self.width * factor)
        new_height = int(self.height * factor)
        return WindowSize(max(1, new_width), max(1, new_height))
    
    def with_width(self, width: int) -> "WindowSize":
        """Create new size with different width."""
        return WindowSize(width, self.height)
    
    def with_height(self, height: int) -> "WindowSize":
        """Create new size with different height."""
        return WindowSize(self.width, height)
    
    def area(self) -> int:
        """Calculate the area of the window."""
        return self.width * self.height
    
    def aspect_ratio(self) -> float:
        """Calculate the aspect ratio (width/height)."""
        return self.width / self.height
    
    def to_tuple(self) -> tuple[int, int]:
        """Convert to tuple of (width, height)."""
        return (self.width, self.height)
