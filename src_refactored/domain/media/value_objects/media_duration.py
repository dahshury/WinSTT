"""Media duration value object."""

from dataclasses import dataclass

from src_refactored.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class MediaDuration(ValueObject):
    """Value object representing media duration in seconds."""

    total_seconds: float

    def __post_init__(self):
        """Validate duration after initialization."""
        if self.total_seconds < 0:
            msg = "Duration cannot be negative"
            raise ValueError(msg,
    )

    @classmethod
    def from_seconds(cls, seconds: float,
    ) -> "MediaDuration":
        """Create duration from seconds."""
        return cls(total_seconds=float(seconds))

    @classmethod
    def from_minutes(cls, minutes: float,
    ) -> "MediaDuration":
        """Create duration from minutes."""
        return cls(total_seconds=float(minutes) * 60)

    @classmethod
    def from_hours(cls, hours: float,
    ) -> "MediaDuration":
        """Create duration from hours."""
        return cls(total_seconds=float(hours) * 3600)

    @classmethod
    def from_time_components(
    cls,
    hours: int = 0,
    minutes: int = 0,
    seconds: float = 0) -> "MediaDuration":
        """Create duration from time components."""
        total = hours * 3600 + minutes * 60 + float(seconds)
        return cls(total_seconds=total,
    )

    @classmethod
    def from_srt_timestamp(cls, timestamp: str,
    ) -> "MediaDuration":
        """Create duration from SRT timestamp format (HH:MM:SS,mmm)."""
        try:
            # Handle both comma and dot as decimal separator
            timestamp = timestamp.replace(",", ".")

            # Split into time and milliseconds parts
            if "." in timestamp:
                time_part, ms_part = timestamp.split(".")
                milliseconds = float("0." + ms_part)
            else:
                time_part = timestamp
                milliseconds = 0

            # Parse time components
            time_components = time_part.split(":")
            if len(time_components) != 3:
                msg = "Invalid timestamp format"
                raise ValueError(msg)

            hours = int(time_components[0])
            minutes = int(time_components[1])
            seconds = int(time_components[2])

            total_seconds = hours * 3600 + minutes * 60 + seconds + milliseconds
            return cls(total_seconds=total_seconds,
    )

        except (ValueError, IndexError) as e:
            msg = f"Invalid SRT timestamp format: {timestamp}"
            raise ValueError(msg) from e

    def to_seconds(self) -> float:
        """Get duration in seconds."""
        return self.total_seconds

    def to_minutes(self) -> float:
        """Get duration in minutes."""
        return self.total_seconds / 60

    def to_hours(self) -> float:
        """Get duration in hours."""
        return self.total_seconds / 3600

    def to_time_components(self,
    ) -> tuple[int, int, float]:
        """Get duration as (hours, minutes, seconds) tuple."""
        total = self.total_seconds
        hours = int(total // 3600)
        remaining = total % 3600
        minutes = int(remaining // 60)
        seconds = remaining % 60
        return hours, minutes, seconds

    def to_srt_timestamp(self) -> str:
        """Format duration as SRT timestamp (HH:MM:SS,mmm)."""
        hours, minutes, seconds = self.to_time_components()

        # Split seconds into integer and fractional parts
        int_seconds = int(seconds)
        milliseconds = int((seconds - int_seconds) * 1000)

        return f"{hours:02d}:{minutes:02d}:{int_seconds:02d},{milliseconds:03d}"

    def to_human_readable(self) -> str:
        """Format duration in human-readable format."""
        hours, minutes, seconds = self.to_time_components()

        if hours > 0:
            return f"{hours}h {minutes}m {seconds:.1f}s"
        if minutes > 0:
            return f"{minutes}m {seconds:.1f}s"
        return f"{seconds:.1f}s"

    def add(self, other: "MediaDuration") -> "MediaDuration":
        """Add another duration to this one."""
        return MediaDuration(total_seconds=self.total_seconds + other.total_seconds)

    def subtract(self, other: "MediaDuration") -> "MediaDuration":
        """Subtract another duration from this one."""
        result = self.total_seconds - other.total_seconds
        result = max(result, 0)
        return MediaDuration(total_seconds=result)

    def multiply(self, factor: float,
    ) -> "MediaDuration":
        """Multiply duration by a factor."""
        return MediaDuration(total_seconds=self.total_seconds * factor)

    def is_zero(self) -> bool:
        """Check if duration is zero."""
        return self.total_seconds == 0

    def is_short(self, threshold_seconds: float = 30,
    ) -> bool:
        """Check if duration is considered short."""
        return self.total_seconds <= threshold_seconds

    def is_long(self, threshold_seconds: float = 3600) -> bool:
        """Check if duration is considered long (default: 1 hour,
    )."""
        return self.total_seconds >= threshold_seconds

    def estimate_transcription_time(self, processing_speed_factor: float = 0.1) -> "MediaDuration":
        """Estimate transcription processing time based on media duration."""
        estimated_seconds = self.total_seconds * processing_speed_factor
        return MediaDuration(total_seconds=estimated_seconds,
    )