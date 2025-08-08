"""
Audio Quality Value Objects

Represents audio quality settings and metrics.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common.value_object import ValueObject


class QualityLevel(Enum):
    """Audio quality levels."""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    ULTRA = "ultra"


@dataclass(frozen=True)
class AudioQuality(ValueObject):
    """Audio quality value object."""
    quality_level: QualityLevel
    sample_rate: int
    bit_depth: int
    compression_ratio: float | None = None

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            self.quality_level,
            self.sample_rate,
            self.bit_depth,
            self.compression_ratio,
        )

    def __post_init__(self):
        if not 0.0 <= self.compression_ratio <= 1.0:
            msg = f"Compression ratio must be between 0.0 and 1.0, got: {self.compression_ratio}"
            raise ValueError(msg)

        valid_sample_rates = [8000, 16000, 22050, 44100, 48000, 96000]
        if self.sample_rate not in valid_sample_rates:
            msg = f"Invalid sample rate: {self.sample_rate}"
            raise ValueError(msg)

        valid_bit_depths = [8, 16, 24, 32]
        if self.bit_depth not in valid_bit_depths:
            msg = f"Invalid bit depth: {self.bit_depth}"
            raise ValueError(msg)

    @property
    def is_lossless(self) -> bool:
        """Check if quality settings represent lossless audio."""
        return self.compression_ratio == 0.0

    @property
    def effective_compression_ratio(self) -> float:
        """Get the effective compression ratio."""
        if self.compression_ratio is None:
            return 1.0
        return self.compression_ratio

    @property
    def estimated_bitrate_kbps(self) -> float:
        """Calculate estimated bitrate in kbps."""
        base_bitrate = self.sample_rate * self.bit_depth / 1000
        return base_bitrate * self.effective_compression_ratio

    @classmethod
    def for_speech_recognition(cls) -> AudioQuality:
        """Create quality settings optimized for speech recognition."""
        return cls(
            quality_level=QualityLevel.MEDIUM,
            sample_rate=16000,
            bit_depth=16,
            compression_ratio=0.0,  # Lossless for accuracy
        )

    @classmethod
    def for_low_bandwidth(cls) -> AudioQuality:
        """Create quality settings for low bandwidth scenarios."""
        return cls(
            quality_level=QualityLevel.LOW,
            sample_rate=8000,
            bit_depth=16,
            compression_ratio=0.3,
        )

    @classmethod
    def for_archival(cls) -> AudioQuality:
        """Create quality settings for archival/preservation."""
        return cls(
            quality_level=QualityLevel.ULTRA,
            sample_rate=48000,
            bit_depth=24,
            compression_ratio=0.0,
        )

    @classmethod
    def create_high_quality(cls, sample_rate: int, bit_depth: int) -> AudioQuality:
        """Create a high quality audio configuration."""
        return cls(
            quality_level=QualityLevel.HIGH,
            sample_rate=sample_rate,
            bit_depth=bit_depth,
            compression_ratio=None,
        )

    @classmethod
    def create_medium_quality(cls, sample_rate: int, bit_depth: int) -> AudioQuality:
        """Create a medium quality audio configuration."""
        return cls(
            quality_level=QualityLevel.MEDIUM,
            sample_rate=sample_rate,
            bit_depth=bit_depth,
            compression_ratio=0.8,
        )

    @classmethod
    def create_low_quality(cls, sample_rate: int, bit_depth: int) -> AudioQuality:
        """Create a low quality audio configuration."""
        return cls(
            quality_level=QualityLevel.LOW,
            sample_rate=sample_rate,
            bit_depth=bit_depth,
            compression_ratio=0.6,
        )


@dataclass(frozen=True)
class NoiseLevel(ValueObject):
    """Value object for audio noise level measurement."""
    decibels: float

    def __post_init__(self):
        if self.decibels < 0 or self.decibels > 120:
            msg = f"Noise level must be between 0 and 120 dB, got: {self.decibels}"
            raise ValueError(msg)

    @property
    def is_quiet(self) -> bool:
        """Check if noise level is considered quiet."""
        return self.decibels < 30

    @property
    def is_moderate(self) -> bool:
        """Check if noise level is moderate."""
        return 30 <= self.decibels <= 60

    @property
    def is_loud(self) -> bool:
        """Check if noise level is loud."""
        return self.decibels > 60

    @property
    def description(self) -> str:
        """Get human-readable description of noise level."""
        if self.is_quiet:
            return "Quiet"
        if self.is_moderate:
            return "Moderate"
        return "Loud"