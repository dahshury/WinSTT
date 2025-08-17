"""Pure Domain Audio Sample Value Objects.

This module provides audio data representations that are completely independent
of external libraries like numpy, following hexagonal architecture principles.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from typing import Any

from src.domain.common.value_object import ValueObject

from .sample_rate import SampleRate


class AudioDataType(Enum):
    """Audio data type enumeration."""
    FLOAT32 = "float32"
    FLOAT64 = "float64"
    INT16 = "int16"
    INT32 = "int32"


@dataclass(frozen=True)
class AudioSampleData(ValueObject):
    """Pure domain representation of audio sample data.
    
    This abstraction allows the domain to work with audio data without
    depending on external libraries like numpy.
    """
    
    samples: Sequence[float]
    sample_rate: SampleRate
    channels: int
    data_type: AudioDataType = AudioDataType.FLOAT32
    timestamp: datetime | None = None
    duration: timedelta | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def _get_equality_components(self) -> tuple[object, ...]:
        return (
            tuple(self.samples),
            self.sample_rate,
            self.channels,
            self.data_type,
            self.timestamp,
            self.duration,
            tuple(sorted(self.metadata.items())),
        )

    def __invariants__(self) -> None:
        if not self.samples:
            msg = "Audio samples cannot be empty"
            raise ValueError(msg)
        if self.channels <= 0:
            msg = "Channels must be positive"
            raise ValueError(msg)
        if len(self.samples) % self.channels != 0:
            msg = "Sample count must be divisible by channel count"
            raise ValueError(msg)
        if self.duration and self.duration.total_seconds() <= 0:
            msg = "Duration must be positive"
            raise ValueError(msg)

    @property
    def frame_count(self) -> int:
        """Get number of audio frames."""
        return len(self.samples) // self.channels

    @property
    def calculated_duration(self) -> timedelta:
        """Calculate duration from frame count and sample rate."""
        seconds = self.frame_count / self.sample_rate.value
        return timedelta(seconds=seconds)

    @property
    def is_mono(self) -> bool:
        """Check if audio is mono."""
        return self.channels == 1

    @property
    def is_stereo(self) -> bool:
        """Check if audio is stereo."""
        stereo_channels = 2
        return self.channels == stereo_channels

    def get_channel_samples(self, channel: int) -> Sequence[float]:
        """Get samples for specific channel."""
        if channel >= self.channels:
            msg = f"Channel {channel} not available (max: {self.channels - 1})"
            raise ValueError(msg)

        if self.is_mono:
            return self.samples

        # Extract interleaved channel data
        return [self.samples[i] for i in range(channel, len(self.samples), self.channels)]

    def to_mono(self) -> "AudioSampleData":
        """Convert to mono by averaging channels."""
        if self.is_mono:
            return self

        # Average channels for each frame
        mono_samples = []
        for frame_start in range(0, len(self.samples), self.channels):
            frame_samples = self.samples[frame_start:frame_start + self.channels]
            mono_sample = sum(frame_samples) / len(frame_samples)
            mono_samples.append(mono_sample)

        return AudioSampleData(
            samples=mono_samples,
            sample_rate=self.sample_rate,
            channels=1,
            data_type=self.data_type,
            timestamp=self.timestamp,
            duration=self.duration,
            metadata=self.metadata,
        )

    def get_rms(self) -> float:
        """Calculate RMS (Root Mean Square) value."""
        if not self.samples:
            return 0.0
        
        # Make types explicit to satisfy type checker
        sum_squares: float = float(sum(sample * sample for sample in self.samples))
        mean_square: float = sum_squares / float(len(self.samples))
        rms: float = mean_square ** 0.5
        return rms

    def get_peak(self) -> float:
        """Get peak (maximum absolute) value."""
        if not self.samples:
            return 0.0
        
        return max(abs(sample) for sample in self.samples)

    def get_statistics(self) -> dict[str, float]:
        """Get comprehensive audio statistics."""
        if not self.samples:
            return {
                "rms": 0.0,
                "peak": 0.0,
                "mean": 0.0,
                "min": 0.0,
                "max": 0.0,
            }

        peak = self.get_peak()
        rms = self.get_rms()
        mean = sum(self.samples) / len(self.samples)
        min_val = min(self.samples)
        max_val = max(self.samples)

        return {
            "rms": rms,
            "peak": peak,
            "mean": mean,
            "min": min_val,
            "max": max_val,
        }


@dataclass(frozen=True)
class AudioStatistics(ValueObject):
    """Audio statistics value object."""
    
    rms: float
    peak: float
    mean: float
    min_value: float
    max_value: float
    sample_count: int
    duration_seconds: float

    def _get_equality_components(self) -> tuple[object, ...]:
        return (
            self.rms,
            self.peak,
            self.mean,
            self.min_value,
            self.max_value,
            self.sample_count,
            self.duration_seconds,
        )

    def __invariants__(self) -> None:
        if self.rms < 0:
            msg = "RMS cannot be negative"
            raise ValueError(msg)
        if self.peak < 0:
            msg = "Peak cannot be negative"
            raise ValueError(msg)
        if self.sample_count < 0:
            msg = "Sample count cannot be negative"
            raise ValueError(msg)
        if self.duration_seconds < 0:
            msg = "Duration cannot be negative"
            raise ValueError(msg)

    @property
    def signal_to_noise_ratio(self) -> float:
        """Calculate signal-to-noise ratio estimate."""
        if self.rms == 0:
            return 0.0
        return 20 * (self.peak / self.rms)

    @property
    def dynamic_range(self) -> float:
        """Calculate dynamic range."""
        return self.max_value - self.min_value

    @property
    def is_silent(self) -> bool:
        """Check if audio is effectively silent."""
        silence_threshold = 0.001  # -60dB threshold
        return self.peak < silence_threshold


@dataclass(frozen=True)
class AudioValidationResult(ValueObject):
    """Result of audio data validation."""
    
    is_valid: bool
    error_messages: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    integrity_score: float = 1.0  # 0.0 to 1.0
    metadata: dict[str, Any] = field(default_factory=dict)

    def _get_equality_components(self) -> tuple[object, ...]:
        return (
            self.is_valid,
            self.error_messages,
            self.warnings,
            self.integrity_score,
            tuple(sorted(self.metadata.items())),
        )

    def __invariants__(self) -> None:
        if not (0.0 <= self.integrity_score <= 1.0):
            msg = "Integrity score must be between 0.0 and 1.0"
            raise ValueError(msg)

    @property
    def has_warnings(self) -> bool:
        """Check if validation has warnings."""
        return len(self.warnings) > 0

    @property
    def has_errors(self) -> bool:
        """Check if validation has errors."""
        return len(self.error_messages) > 0

    def add_error(self, message: str) -> "AudioValidationResult":
        """Add an error message."""
        return AudioValidationResult(
            is_valid=False,
            error_messages=(*self.error_messages, message),
            warnings=self.warnings,
            integrity_score=min(self.integrity_score - 0.2, 0.0),
            metadata=self.metadata,
        )

    def add_warning(self, message: str) -> "AudioValidationResult":
        """Add a warning message."""
        return AudioValidationResult(
            is_valid=self.is_valid,
            error_messages=self.error_messages,
            warnings=(*self.warnings, message),
            integrity_score=max(self.integrity_score - 0.1, 0.0),
            metadata=self.metadata,
        )
