"""Progress percentage value object for progress management domain."""

from __future__ import annotations

from dataclasses import dataclass

from src.domain.common import ValueObject


@dataclass(frozen=True)
class ProgressPercentage(ValueObject):
    """Value object for progress percentage validation (0-100)."""

    value: float

    def __post_init__(self) -> None:
        """Validate progress percentage after initialization."""
        if not isinstance(self.value, int | float):
            msg = f"Progress percentage must be a number, got: {type(self.value).__name__}"
            raise TypeError(msg)

        if not 0.0 <= self.value <= 100.0:
            msg = f"Progress percentage must be between 0 and 100, got: {self.value}"
            raise ValueError(msg)

        # Ensure value is stored as float with reasonable precision
        normalized_value = round(float(self.value), 2)
        object.__setattr__(self, "value", normalized_value)

    @classmethod
    def from_int(cls, percentage: int,
    ) -> ProgressPercentage:
        """Create from integer percentage."""
        return cls(value=float(percentage))

    @classmethod
    def from_float(cls, percentage: float,
    ) -> ProgressPercentage:
        """Create from float percentage."""
        return cls(value=percentage)

    @classmethod
    def from_fraction(cls, numerator: float, denominator: float,
    ) -> ProgressPercentage:
        """Create from fraction (numerator/denominator * 100)."""
        if denominator == 0:
            msg = "Denominator cannot be zero"
            raise ValueError(msg)

        if numerator < 0 or denominator < 0:
            msg = "Numerator and denominator must be non-negative"
            raise ValueError(msg)

        if numerator > denominator:
            msg = "Numerator cannot be greater than denominator"
            raise ValueError(msg)

        percentage = (numerator / denominator) * 100.0
        return cls(value=percentage)

    @classmethod
    def zero(cls) -> ProgressPercentage:
        """Create zero percentage."""
        return cls(value=0.0)

    @classmethod
    def complete(cls) -> ProgressPercentage:
        """Create complete (100%) percentage."""
        return cls(value=100.0)

    @classmethod
    def half(cls) -> ProgressPercentage:
        """Create half (50%) percentage."""
        return cls(value=50.0)

    def is_zero(self) -> bool:
        """Check if percentage is zero."""
        return self.value == 0.0

    def is_complete(self) -> bool:
        """Check if percentage is complete (100%)."""
        return self.value == 100.0

    def is_half_or_more(self,
    ) -> bool:
        """Check if percentage is 50% or more."""
        return self.value >= 50.0

    def is_nearly_complete(self, threshold: float = 95.0) -> bool:
        """Check if percentage is nearly complete (default: >= 95%,
    )."""
        if not 0.0 <= threshold <= 100.0:
            msg = f"Threshold must be between 0 and 100, got: {threshold}"
            raise ValueError(msg)
        return self.value >= threshold

    def to_int(self) -> int:
        """Convert to integer percentage (rounded)."""
        return round(self.value)

    def to_float(self) -> float:
        """Convert to float percentage."""
        return self.value

    def to_fraction(self) -> float:
        """Convert to fraction (0.0 to 1.0)."""
        return self.value / 100.0

    def to_string(self, decimal_places: int = 1) -> str:
        """Convert to string with specified decimal places."""
        if decimal_places < 0:
            msg = "Decimal places cannot be negative"
            raise ValueError(msg)

        format_str = f"{{:.{decimal_places}f}}%"
        return format_str.format(self.value,
    )

    def add(self, other: ProgressPercentage | float) -> ProgressPercentage:
        """Add to this percentage, ensuring result stays within bounds."""
        if isinstance(other, ProgressPercentage):
            new_value = self.value + other.value
        else:
            new_value = self.value + float(other,
    )

        # Clamp to valid range
        new_value = max(0.0, min(100.0, new_value))
        return ProgressPercentage(value=new_value)

    def subtract(self, other: ProgressPercentage | float) -> ProgressPercentage:
        """Subtract from this percentage, ensuring result stays within bounds."""
        if isinstance(other, ProgressPercentage):
            new_value = self.value - other.value
        else:
            new_value = self.value - float(other,
    )

        # Clamp to valid range
        new_value = max(0.0, min(100.0, new_value))
        return ProgressPercentage(value=new_value)

    def multiply(self, factor: float,
    ) -> ProgressPercentage:
        """Multiply this percentage by a factor, ensuring result stays within bounds."""
        new_value = self.value * float(factor)

        # Clamp to valid range
        new_value = max(0.0, min(100.0, new_value))
        return ProgressPercentage(value=new_value)

    def interpolate(self, other: ProgressPercentage, factor: float,
    ) -> ProgressPercentage:
        """Interpolate between this and another percentage."""
        if not 0.0 <= factor <= 1.0:
            msg = f"Interpolation factor must be between 0 and 1, got: {factor}"
            raise ValueError(msg)

        new_value = self.value + (other.value - self.value) * factor
        return ProgressPercentage(value=new_value)

    def distance_to(self, other: ProgressPercentage,
    ) -> float:
        """Calculate distance to another percentage."""
        return abs(self.value - other.value)

    def is_close_to(self, other: ProgressPercentage, tolerance: float = 1.0) -> bool:
        """Check if this percentage is close to another within tolerance."""
        if tolerance < 0:
            msg = "Tolerance cannot be negative"
            raise ValueError(msg)

        return self.distance_to(other) <= tolerance

    def __str__(self) -> str:
        """String representation of progress percentage."""
        return self.to_string()

    def __int__(self) -> int:
        """Integer representation of progress percentage."""
        return self.to_int()

    def __float__(self) -> float:
        """Float representation of progress percentage."""
        return self.to_float()

    def __lt__(self, other: ProgressPercentage | float) -> bool:
        """Less than comparison."""
        if isinstance(other, ProgressPercentage):
            return self.value < other.value
        return self.value < float(other)

    def __le__(self, other: ProgressPercentage | float) -> bool:
        """Less than or equal comparison."""
        if isinstance(other, ProgressPercentage):
            return self.value <= other.value
        return self.value <= float(other)

    def __gt__(self, other: ProgressPercentage | float) -> bool:
        """Greater than comparison."""
        if isinstance(other, ProgressPercentage):
            return self.value > other.value
        return self.value > float(other)

    def __ge__(self, other: ProgressPercentage | float) -> bool:
        """Greater than or equal comparison."""
        if isinstance(other, ProgressPercentage):
            return self.value >= other.value
        return self.value >= float(other)