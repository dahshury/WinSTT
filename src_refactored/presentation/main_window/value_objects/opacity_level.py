"""Opacity level value object for main window presentation layer."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common.value_object import ValueObject


class OpacityPreset(Enum):
    """Predefined opacity levels for common UI states."""
    FULLY_TRANSPARENT = 0.0
    NEARLY_TRANSPARENT = 0.1
    VERY_LIGHT = 0.25
    LIGHT = 0.4
    MEDIUM_LIGHT = 0.6
    MEDIUM = 0.75
    MEDIUM_DARK = 0.85
    DARK = 0.9
    VERY_DARK = 0.95
    FULLY_OPAQUE = 1.0


@dataclass(frozen=True)
class OpacityLevel(ValueObject):
    """Opacity level value object for UI elements."""
    
    value: float
    
    def __post_init__(self) -> None:
        """Validate opacity level."""
        if not isinstance(self.value, int | float):
            msg = "Opacity value must be a number"
            raise ValueError(msg)
        
        if not (0.0 <= self.value <= 1.0):
            msg = "Opacity value must be between 0.0 and 1.0"
            raise ValueError(msg)
    
    @classmethod
    def from_preset(cls, preset: OpacityPreset) -> OpacityLevel:
        """Create opacity level from preset."""
        return cls(preset.value)
    
    @classmethod
    def from_percentage(cls, percentage: int) -> OpacityLevel:
        """Create opacity level from percentage (0-100)."""
        if not (0 <= percentage <= 100):
            msg = "Percentage must be between 0 and 100"
            raise ValueError(msg)
        return cls(percentage / 100.0)
    
    @classmethod
    def transparent(cls) -> OpacityLevel:
        """Create fully transparent opacity."""
        return cls(OpacityPreset.FULLY_TRANSPARENT.value)
    
    @classmethod
    def opaque(cls) -> OpacityLevel:
        """Create fully opaque opacity."""
        return cls(OpacityPreset.FULLY_OPAQUE.value)
    
    @classmethod
    def semi_transparent(cls) -> OpacityLevel:
        """Create semi-transparent opacity."""
        return cls(OpacityPreset.MEDIUM.value)
    
    def to_percentage(self) -> int:
        """Convert to percentage value."""
        return int(self.value * 100)
    
    def to_css_value(self) -> str:
        """Convert to CSS opacity value."""
        return str(self.value)
    
    def to_qt_value(self) -> float:
        """Convert to Qt opacity value."""
        return self.value
    
    def is_transparent(self) -> bool:
        """Check if opacity is fully transparent."""
        return self.value == 0.0
    
    def is_opaque(self) -> bool:
        """Check if opacity is fully opaque."""
        return self.value == 1.0
    
    def is_semi_transparent(self) -> bool:
        """Check if opacity is semi-transparent."""
        return 0.0 < self.value < 1.0
    
    def increase(self, amount: float) -> OpacityLevel:
        """Create new opacity level increased by amount."""
        new_value = min(1.0, self.value + amount)
        return OpacityLevel(new_value)
    
    def decrease(self, amount: float) -> OpacityLevel:
        """Create new opacity level decreased by amount."""
        new_value = max(0.0, self.value - amount)
        return OpacityLevel(new_value)
    
    def multiply(self, factor: float) -> OpacityLevel:
        """Create new opacity level multiplied by factor."""
        if factor < 0:
            msg = "Factor must be non-negative"
            raise ValueError(msg)
        new_value = min(1.0, self.value * factor)
        return OpacityLevel(new_value)
    
    def blend_with(self, other: OpacityLevel, ratio: float = 0.5) -> OpacityLevel:
        """Blend with another opacity level."""
        if not (0.0 <= ratio <= 1.0):
            msg = "Ratio must be between 0.0 and 1.0"
            raise ValueError(msg)
        
        blended_value = self.value * (1 - ratio) + other.value * ratio
        return OpacityLevel(blended_value)
    
    def get_closest_preset(self) -> OpacityPreset:
        """Get the closest predefined preset."""
        closest_preset = OpacityPreset.FULLY_OPAQUE
        min_distance = abs(self.value - OpacityPreset.FULLY_OPAQUE.value)
        
        for preset in OpacityPreset:
            distance = abs(self.value - preset.value)
            if distance < min_distance:
                min_distance = distance
                closest_preset = preset
        
        return closest_preset
    
    def __str__(self) -> str:
        """String representation."""
        return f"{self.to_percentage()}%"
    
    def __repr__(self) -> str:
        """Developer representation."""
        preset = self.get_closest_preset()
        return f"OpacityLevel({self.value}, closest={preset.name})"
