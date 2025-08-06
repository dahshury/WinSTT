"""UI-specific value objects for the presentation layer.

This module contains value objects that are purely UI-related and belong
in the presentation layer according to hexagonal architecture principles.
"""

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class WindowDimensions:
    """Value object for window dimensions."""
    width: int
    height: int
    
    def __post_init__(self):
        if self.width <= 0 or self.height <= 0:
            msg = f"Invalid dimensions: {self.width}x{self.height}"
            raise ValueError(msg)
        
        if self.width < 300 or self.height < 200:
            msg = f"Window too small: {self.width}x{self.height}. Minimum size is 300x200."
            raise ValueError(msg)
    
    @property
    def aspect_ratio(self) -> float:
        """Calculate aspect ratio."""
        return self.width / self.height
    
    @property
    def area(self) -> int:
        """Calculate window area."""
        return self.width * self.height


@dataclass(frozen=True)
class StyleConfiguration:
    """Value object for UI style settings."""
    theme: Literal["light", "dark", "auto"]
    
    def __post_init__(self):
        valid_themes = ["light", "dark", "auto"]
        if self.theme not in valid_themes:
            msg = f"Invalid theme: {self.theme}. Must be one of {valid_themes}."
            raise ValueError(msg)


__all__ = [
    "StyleConfiguration",
    "WindowDimensions",
]