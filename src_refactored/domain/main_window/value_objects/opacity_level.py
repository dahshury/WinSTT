"""Opacity level value object.

This module defines the OpacityLevel value object for managing UI transparency.
"""

from dataclasses import dataclass

from src_refactored.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class OpacityLevel(ValueObject):
    """Value object representing an opacity level for UI elements."""
    
    value: float
    
    @classmethod
    def from_percentage(cls, percentage: int) -> "OpacityLevel":
        """Create OpacityLevel from percentage value.
        
        Args:
            percentage: Percentage value (0-100)
            
        Returns:
            OpacityLevel instance
        """
        if not 0 <= percentage <= 100:
            msg = "Percentage must be between 0 and 100"
            raise ValueError(msg)
        return cls(percentage / 100.0)
    
    @classmethod
    def from_float(cls, value: float) -> "OpacityLevel":
        """Create OpacityLevel from float value.
        
        Args:
            value: Float value (0.0-1.0)
            
        Returns:
            OpacityLevel instance
        """
        return cls(value)
    
    @classmethod
    def from_value(cls, value: float) -> "OpacityLevel":
        """Create OpacityLevel from a numeric value.
        
        Args:
            value: Numeric value. If >= 1.0, treated as percentage (0-100).
                   If < 1.0, treated as opacity (0.0-1.0).
            
        Returns:
            OpacityLevel instance
        """
        if isinstance(value, int) and value > 1:
            # Treat as percentage
            return cls.from_percentage(value)
        # Treat as opacity float
        return cls.from_float(float(value))
    
    def __post_init__(self) -> None:
        """Validate the opacity level value."""
        if not isinstance(self.value, int | float):
            msg = "Opacity level must be a number"
            raise ValueError(msg)
        if not 0.0 <= self.value <= 1.0:
            msg = "Opacity level must be between 0.0 and 1.0"
            raise ValueError(msg)
    
    def to_percentage(self) -> int:
        """Convert to percentage value.
        
        Returns:
            Percentage value (0-100)
        """
        return int(self.value * 100)
    
    def is_transparent(self) -> bool:
        """Check if this opacity level is transparent.
        
        Returns:
            True if opacity is 0.0
        """
        return self.value == 0.0
    
    def is_opaque(self) -> bool:
        """Check if this opacity level is opaque.
        
        Returns:
            True if opacity is 1.0
        """
        return self.value == 1.0
    
    def is_semi_transparent(self) -> bool:
        """Check if this opacity level is semi-transparent.
        
        Returns:
            True if opacity is between 0.0 and 1.0
        """
        return 0.0 < self.value < 1.0
    
    def with_transparency(self, transparency: float) -> "OpacityLevel":
        """Create a new OpacityLevel with adjusted transparency.
        
        Args:
            transparency: Transparency factor (0.0-1.0, where 0.0 is opaque, 1.0 is transparent)
            
        Returns:
            New OpacityLevel with adjusted transparency
        """
        if not 0.0 <= transparency <= 1.0:
            msg = "Transparency must be between 0.0 and 1.0"
            raise ValueError(msg)
        new_value = self.value * (1.0 - transparency)
        return OpacityLevel(new_value)
    
    def blend_with(self, other: "OpacityLevel", factor: float = 0.5) -> "OpacityLevel":
        """Blend this opacity with another.
        
        Args:
            other: Other OpacityLevel to blend with
            factor: Blending factor (0.0 = this opacity, 1.0 = other opacity)
            
        Returns:
            New OpacityLevel with blended value
        """
        if not 0.0 <= factor <= 1.0:
            msg = "Blend factor must be between 0.0 and 1.0"
            raise ValueError(msg)
        blended_value = self.value * (1.0 - factor) + other.value * factor
        return OpacityLevel(blended_value)


# Common opacity levels
TRANSPARENT = OpacityLevel(0.0)
SEMI_TRANSPARENT = OpacityLevel(0.5)
OPAQUE = OpacityLevel(1.0)
FADED = OpacityLevel(0.3)
VISIBLE = OpacityLevel(0.8)
