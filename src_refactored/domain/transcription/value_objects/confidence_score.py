"""
Confidence Score Value Object

Represents confidence levels for transcription results.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common.value_object import ValueObject


class ConfidenceLevel(Enum):
    """Confidence level categories."""
    VERY_LOW = "very_low"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    VERY_HIGH = "very_high"


@dataclass(frozen=True)
class ConfidenceScore(ValueObject):
    """
    Value object for transcription confidence scores.
    
    Represents the confidence level of transcription results
    with validation and categorization.
    """
    value: float

    def __post_init__(self) -> None:
        if not 0.0 <= self.value <= 1.0:
            msg = f"Confidence score must be between 0.0 and 1.0, got: {self.value}"
            raise ValueError(msg)

    @property
    def level(self) -> ConfidenceLevel:
        """Categorize confidence score into discrete levels."""
        if self.value < 0.2:
            return ConfidenceLevel.VERY_LOW
        if self.value < 0.4:
            return ConfidenceLevel.LOW
        if self.value < 0.6:
            return ConfidenceLevel.MEDIUM
        if self.value < 0.8:
            return ConfidenceLevel.HIGH
        return ConfidenceLevel.VERY_HIGH

    @property
    def percentage(self) -> float:
        """Get confidence as percentage."""
        return self.value * 100.0

    @property
    def is_reliable(self) -> bool:
        """Check if confidence is high enough to be considered reliable."""
        return self.value >= 0.6

    @property
    def is_very_reliable(self) -> bool:
        """Check if confidence is very high."""
        return self.value >= 0.8

    @property
    def is_questionable(self) -> bool:
        """Check if confidence is low enough to be questionable."""
        return self.value < 0.4

    @property
    def description(self) -> str:
        """Get human-readable description of confidence level."""
        level_descriptions = {
            ConfidenceLevel.VERY_LOW: "Very Low",
            ConfidenceLevel.LOW: "Low",
            ConfidenceLevel.MEDIUM: "Medium",
            ConfidenceLevel.HIGH: "High",
            ConfidenceLevel.VERY_HIGH: "Very High",
        }
        return level_descriptions[self.level]

    def format_percentage(self, decimals: int = 1,
    ) -> str:
        """Format as percentage string."""
        return f"{self.percentage:.{decimals}f}%"

    @classmethod
    def from_percentage(cls, percentage: float,
    ) -> ConfidenceScore:
        """Create confidence score from percentage (0-100)."""
        return cls(percentage / 100.0)

    @classmethod
    def very_high(cls) -> ConfidenceScore:
        """Create very high confidence score."""
        return cls(0.95)

    @classmethod
    def high(cls) -> ConfidenceScore:
        """Create high confidence score."""
        return cls(0.8)

    @classmethod
    def medium(cls) -> ConfidenceScore:
        """Create medium confidence score."""
        return cls(0.6)

    @classmethod
    def low(cls) -> ConfidenceScore:
        """Create low confidence score."""
        return cls(0.3)

    @classmethod
    def very_low(cls) -> ConfidenceScore:
        """Create very low confidence score."""
        return cls(0.1)

    def combine_with(self, other: ConfidenceScore, weight: float = 0.5) -> ConfidenceScore:
        """
        Combine with another confidence score using weighted average.
        
        Args:
            other: Another confidence score to combine with
            weight: Weight for this score (0.0 to 1.0,
    ), other gets (1-weight)
        """
        if not 0.0 <= weight <= 1.0:
            msg = f"Weight must be between 0.0 and 1.0, got: {weight}"
            raise ValueError(msg)

        combined_value = (self.value * weight) + (other.value * (1.0 - weight))
        return ConfidenceScore(combined_value)