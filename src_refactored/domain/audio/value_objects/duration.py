"""Duration Value Object for Audio Domain."""

from __future__ import annotations

from dataclasses import dataclass

from src_refactored.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class Duration(ValueObject):
    """Value object for audio duration with validation and conversions."""

    seconds: float

    # Duration constraints
    MIN_DURATION = 0.1  # Minimum 100ms for meaningful audio
    MAX_DURATION = 3600.0  # Maximum 1 hour for practical limits

    def __post_init__(self):
        if self.seconds < 0:
            msg = f"Duration cannot be negative, got {self.seconds}"
            raise ValueError(msg)

        if self.seconds < self.MIN_DURATION:
            msg = (
                f"Duration too short for processing: {self.seconds}s. "
                f"Minimum: {self.MIN_DURATION}s"
            ,
    )
            raise ValueError(
                msg,
            )

        if self.seconds > self.MAX_DURATION:
            msg = (
                f"Duration too long: {self.seconds}s. "
                f"Maximum: {self.MAX_DURATION}s"
            ,
    )
            raise ValueError(
                msg,
            )

    @property
    def milliseconds(self) -> float:
        """Get duration in milliseconds."""
        return self.seconds * 1000.0

    @property
    def minutes(self) -> float:
        """Get duration in minutes."""
        return self.seconds / 60.0

    @property
    def is_short(self) -> bool:
        """Check if duration is considered short (< 5 seconds)."""
        return self.seconds < 5.0

    @property
    def is_long(self) -> bool:
        """Check if duration is considered long (> 60 seconds)."""
        return self.seconds > 60.0

    def format_time(self) -> str:
        """Format duration as MM:SS or HH:MM:SS."""
        total_seconds = int(self.seconds)
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        seconds = total_seconds % 60

        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        return f"{minutes:02d}:{seconds:02d}"

    @classmethod
    def from_samples(cls, sample_count: int, sample_rate: int,
    ) -> Duration:
        """Create duration from sample count and sample rate."""
        if sample_count <= 0:
            msg = f"Sample count must be positive, got {sample_count}"
            raise ValueError(msg)
        if sample_rate <= 0:
            msg = f"Sample rate must be positive, got {sample_rate}"
            raise ValueError(msg)

        seconds = sample_count / sample_rate
        return cls(seconds)

    @classmethod
    def from_milliseconds(cls, milliseconds: float,
    ) -> Duration:
        """Create duration from milliseconds."""
        return cls(milliseconds / 1000.0)

    @classmethod
    def from_minutes(cls, minutes: float,
    ) -> Duration:
        """Create duration from minutes."""
        return cls(minutes * 60.0)

    def add(self, other: Duration,
    ) -> Duration:
        """Add two durations together."""
        return Duration(self.seconds + other.seconds)

    def subtract(self, other: Duration,
    ) -> Duration:
        """Subtract another duration from this one."""
        result_seconds = self.seconds - other.seconds
        if result_seconds < 0:
            msg = "Cannot subtract larger duration from smaller one"
            raise ValueError(msg)
        return Duration(result_seconds,
    )

    def multiply(self, factor: float,
    ) -> Duration:
        """Multiply duration by a factor."""
        if factor < 0:
            msg = f"Factor must be non-negative, got {factor}"
            raise ValueError(msg)
        return Duration(self.seconds * factor)