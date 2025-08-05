"""Opacity level value object.

This module contains the OpacityLevel value object for managing UI element opacity.
"""

from __future__ import annotations

from enum import Enum

from src_refactored.domain.common.result import Result
from src_refactored.domain.common.value_object import ValueObject


class OpacityPreset(Enum):
    """Predefined opacity levels."""
    TRANSPARENT = 0.0
    VERY_LOW = 0.1
    LOW = 0.25
    MEDIUM_LOW = 0.4
    MEDIUM = 0.5
    MEDIUM_HIGH = 0.6
    HIGH = 0.75
    VERY_HIGH = 0.9
    OPAQUE = 1.0


class OpacityLevel(ValueObject[float]):
    """Opacity level value object.
    
    Represents an opacity value between 0.0 (transparent) and 1.0 (opaque).
    """

    MIN_OPACITY = 0.0
    MAX_OPACITY = 1.0

    def __init__(self, value: float,
    ):
        """Initialize opacity level.
        
        Args:
            value: Opacity value between 0.0 and 1.0
            
        Raises:
            ValueError: If value is not between 0.0 and 1.0
        """
        if not isinstance(value, int | float):
            msg = f"Opacity value must be a number, got {type(value)}"
            raise ValueError(msg)

        value = float(value)

        if not (self.MIN_OPACITY <= value <= self.MAX_OPACITY):
            msg = (
                f"Opacity value must be between {self.MIN_OPACITY} and {self.MAX_OPACITY}, "
                f"got {value}"
            )
            raise ValueError(
                msg,
            )

        super().__init__(value)

    @classmethod
    def from_value(cls, value: float,
    ) -> Result[OpacityLevel]:
        """Create OpacityLevel from numeric value with validation.
        
        Args:
            value: Opacity value
            
        Returns:
            Result containing OpacityLevel or error
        """
        try:
            return Result.success(cls(value))
        except ValueError as e:
            return Result.failure(str(e))

    @classmethod
    def from_percentage(cls, percentage: float,
    ) -> Result[OpacityLevel]:
        """Create OpacityLevel from percentage (0-100).
        
        Args:
            percentage: Percentage value (0-100)
            
        Returns:
            Result containing OpacityLevel or error
        """
        try:
            if not isinstance(percentage, int | float):
                return Result.failure(f"Percentage must be a number, got {type(percentage)}")

            if not (0 <= percentage <= 100):
                return Result.failure(f"Percentage must be between 0 and 100, got {percentage}")

            opacity_value = percentage / 100.0
            return Result.success(cls(opacity_value))
        except Exception as e:
            return Result.failure(f"Failed to create opacity from percentage: {e!s}")

    @classmethod
    def from_preset(cls, preset: OpacityPreset,
    ) -> OpacityLevel:
        """Create OpacityLevel from preset.
        
        Args:
            preset: Opacity preset
            
        Returns:
            OpacityLevel with preset value
        """
        return cls(preset.value)

    @classmethod
    def transparent(cls) -> OpacityLevel:
        """Create transparent opacity (0.0).
        
        Returns:
            Transparent OpacityLevel
        """
        return cls(OpacityPreset.TRANSPARENT.value)

    @classmethod
    def opaque(cls) -> OpacityLevel:
        """Create opaque opacity (1.0).
        
        Returns:
            Opaque OpacityLevel
        """
        return cls(OpacityPreset.OPAQUE.value)

    @classmethod
    def medium(cls) -> OpacityLevel:
        """Create medium opacity (0.5).
        
        Returns:
            Medium OpacityLevel
        """
        return cls(OpacityPreset.MEDIUM.value)

    def to_percentage(self) -> float:
        """Convert to percentage (0-100).
        
        Returns:
            Percentage value
        """
        return self.value * 100.0

    def to_int_percentage(self) -> int:
        """Convert to integer percentage (0-100).
        
        Returns:
            Integer percentage value
        """
        return round(self.to_percentage())

    def to_alpha_byte(self) -> int:
        """Convert to alpha byte value (0-255).
        
        Returns:
            Alpha byte value for use in RGBA colors
        """
        return round(self.value * 255)

    def is_transparent(self) -> bool:
        """Check if opacity is transparent (0.0).
        
        Returns:
            True if transparent, False otherwise
        """
        return self.value == self.MIN_OPACITY

    def is_opaque(self) -> bool:
        """Check if opacity is opaque (1.0).
        
        Returns:
            True if opaque, False otherwise
        """
        return self.value == self.MAX_OPACITY

    def is_semi_transparent(self) -> bool:
        """Check if opacity is semi-transparent (between 0.0 and 1.0).
        
        Returns:
            True if semi-transparent, False otherwise
        """
        return self.MIN_OPACITY < self.value < self.MAX_OPACITY

    def increase(self, amount: float,
    ) -> Result[OpacityLevel]:
        """Increase opacity by amount.
        
        Args:
            amount: Amount to increase (can be negative to decrease)
            
        Returns:
            Result containing new OpacityLevel or error
        """
        new_value = self.value + amount
        return OpacityLevel.from_value(new_value)

    def decrease(self, amount: float,
    ) -> Result[OpacityLevel]:
        """Decrease opacity by amount.
        
        Args:
            amount: Amount to decrease (must be positive)
            
        Returns:
            Result containing new OpacityLevel or error
        """
        if amount < 0:
            return Result.failure("Decrease amount must be positive")
        return self.increase(-amount)

    def multiply(self, factor: float,
    ) -> Result[OpacityLevel]:
        """Multiply opacity by factor.
        
        Args:
            factor: Multiplication factor
            
        Returns:
            Result containing new OpacityLevel or error
        """
        if factor < 0:
            return Result.failure("Multiplication factor must be non-negative")

        new_value = self.value * factor
        return OpacityLevel.from_value(new_value)

    def clamp_to_range(self, min_opacity: float, max_opacity: float,
    ) -> Result[OpacityLevel]:
        """Clamp opacity to specified range.
        
        Args:
            min_opacity: Minimum opacity value
            max_opacity: Maximum opacity value
            
        Returns:
            Result containing clamped OpacityLevel or error
        """
        if min_opacity < self.MIN_OPACITY or max_opacity > self.MAX_OPACITY:
            return Result.failure(
                f"Range must be within {self.MIN_OPACITY}-{self.MAX_OPACITY}",
            )

        if min_opacity > max_opacity:
            return Result.failure("Minimum opacity cannot be greater than maximum")

        clamped_value = max(min_opacity, min(max_opacity, self.value))
        return OpacityLevel.from_value(clamped_value)

    def interpolate(self, other: OpacityLevel, factor: float,
    ) -> Result[OpacityLevel]:
        """Interpolate between this and another opacity level.
        
        Args:
            other: Other opacity level
            factor: Interpolation factor (0.0 = this, 1.0 = other)
            
        Returns:
            Result containing interpolated OpacityLevel or error
        """
        if not (0.0 <= factor <= 1.0):
            return Result.failure(f"Interpolation factor must be between 0.0 and 1.0, got {factor}")

        interpolated_value = self.value + (other.value - self.value) * factor
        return OpacityLevel.from_value(interpolated_value)

    def get_closest_preset(self) -> OpacityPreset:
        """Get the closest predefined preset.
        
        Returns:
            Closest OpacityPreset
        """
        closest_preset = OpacityPreset.TRANSPARENT
        min_distance = abs(self.value - OpacityPreset.TRANSPARENT.value)

        for preset in OpacityPreset:
            distance = abs(self.value - preset.value)
            if distance < min_distance:
                min_distance = distance
                closest_preset = preset

        return closest_preset

    def invert(self) -> OpacityLevel:
        """Invert opacity (1.0 - value).
        
        Returns:
            Inverted OpacityLevel
        """
        return OpacityLevel(self.MAX_OPACITY - self.value)

    def to_css_value(self) -> str:
        """Convert to CSS opacity value.
        
        Returns:
            CSS opacity string
        """
        return f"{self.value:.3f}"

    def to_qt_value(self) -> float:
        """Convert to Qt opacity value (same as raw value,
    ).
        
        Returns:
            Qt-compatible opacity value
        """
        return self.value

    def __add__(self, other: OpacityLevel | float) -> Result[OpacityLevel]:
        """Add opacity levels or values.
        
        Args:
            other: Other opacity level or numeric value
            
        Returns:
            Result containing new OpacityLevel or error
        """
        if isinstance(other, OpacityLevel):
            return self.increase(other.value)
        if isinstance(other, int | float):
            return self.increase(float(other))
        return Result.failure(f"Cannot add {type(other)} to OpacityLevel")

    def __sub__(self, other: OpacityLevel | float) -> Result[OpacityLevel]:
        """Subtract opacity levels or values.
        
        Args:
            other: Other opacity level or numeric value
            
        Returns:
            Result containing new OpacityLevel or error
        """
        if isinstance(other, OpacityLevel):
            return self.increase(-other.value)
        if isinstance(other, int | float):
            return self.increase(-float(other))
        return Result.failure(f"Cannot subtract {type(other)} from OpacityLevel")

    def __mul__(self, other: float,
    ) -> Result[OpacityLevel]:
        """Multiply opacity by factor.
        
        Args:
            other: Multiplication factor
            
        Returns:
            Result containing new OpacityLevel or error
        """
        if isinstance(other, int | float):
            return self.multiply(float(other))
        return Result.failure(f"Cannot multiply OpacityLevel by {type(other)}")

    def __lt__(self, other: OpacityLevel,
    ) -> bool:
        """Less than comparison."""
        if not isinstance(other, OpacityLevel):
            return NotImplemented
        return self.value < other.value

    def __le__(self, other: OpacityLevel,
    ) -> bool:
        """Less than or equal comparison."""
        if not isinstance(other, OpacityLevel):
            return NotImplemented
        return self.value <= other.value

    def __gt__(self, other: OpacityLevel,
    ) -> bool:
        """Greater than comparison."""
        if not isinstance(other, OpacityLevel):
            return NotImplemented
        return self.value > other.value

    def __ge__(self, other: OpacityLevel,
    ) -> bool:
        """Greater than or equal comparison."""
        if not isinstance(other, OpacityLevel):
            return NotImplemented
        return self.value >= other.value

    def __str__(self) -> str:
        """String representation."""
        return f"{self.value:.3f}"

    def __repr__(self) -> str:
        """Developer representation."""
        return f"OpacityLevel({self.value})"