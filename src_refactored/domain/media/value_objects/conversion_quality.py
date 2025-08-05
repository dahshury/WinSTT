"""Conversion quality value object for media processing."""

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common.value_object import ValueObject


class QualityPreset(Enum):
    """Predefined quality presets for conversion."""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    TRANSCRIPTION_OPTIMIZED = "transcription_optimized"


@dataclass(frozen=True)
class ConversionQuality(ValueObject):
    """Value object representing conversion quality settings."""

    sample_rate: int  # Hz
    channels: int     # 1 for mono, 2 for stereo
    bit_rate: int     # kbps
    format: str       # Output format (wav, mp3, etc.)
    preset: QualityPreset

    # Quality presets
    PRESETS = {
        QualityPreset.LOW: {
            "sample_rate": 8000,
            "channels": 1,
            "bit_rate": 64,
            "format": "wav",
        },
        QualityPreset.MEDIUM: {
            "sample_rate": 22050,
            "channels": 1,
            "bit_rate": 128,
            "format": "wav",
        },
        QualityPreset.HIGH: {
            "sample_rate": 44100,
            "channels": 2,
            "bit_rate": 320,
            "format": "wav",
        },
        QualityPreset.TRANSCRIPTION_OPTIMIZED: {
            "sample_rate": 16000,
            "channels": 1,
            "bit_rate": 128,
            "format": "wav",
        },
    }

    def __post_init__(self):
        """Validate conversion quality settings."""
        if self.sample_rate <= 0:
            msg = "Sample rate must be positive"
            raise ValueError(msg)

        if self.channels not in [1, 2]:
            msg = "Channels must be 1 (mono) or 2 (stereo)"
            raise ValueError(msg)

        if self.bit_rate <= 0:
            msg = "Bit rate must be positive"
            raise ValueError(msg)

        if not self.format:
            msg = "Format cannot be empty"
            raise ValueError(msg)

        if self.preset not in QualityPreset:
            msg = f"Invalid preset: {self.preset}"
            raise ValueError(msg)

    @classmethod
    def from_preset(cls, preset: QualityPreset,
    ) -> "ConversionQuality":
        """Create conversion quality from a preset."""
        if preset not in cls.PRESETS:
            msg = f"Unknown preset: {preset}"
            raise ValueError(msg)

        settings = cls.PRESETS[preset]
        return cls(
            sample_rate=settings["sample_rate"],
            channels=settings["channels"],
            bit_rate=settings["bit_rate"],
            format=settings["format"],
            preset=preset,
        )

    @classmethod
    def create_default(cls) -> "ConversionQuality":
        """Create default conversion quality (transcription optimized)."""
        return cls.from_preset(QualityPreset.TRANSCRIPTION_OPTIMIZED)

    @classmethod
    def create_high_quality(cls) -> "ConversionQuality":
        """Create high quality conversion settings."""
        return cls.from_preset(QualityPreset.HIGH)

    @classmethod
    def create_low_quality(cls) -> "ConversionQuality":
        """Create low quality conversion settings for faster processing."""
        return cls.from_preset(QualityPreset.LOW)

    def get_ffmpeg_args(self) -> list[str]:
        """Get FFmpeg command line arguments for this quality setting."""
        args = [
            "-f", self.format,
            "-ar", str(self.sample_rate),
            "-ac", str(self.channels),
        ]

        # Add bit rate for compressed formats
        if self.format != "wav":
            args.extend(["-b:a", f"{self.bit_rate}k"])

        return args

    def estimate_file_size_mb(self, duration_seconds: float,
    ) -> float:
        """Estimate output file size in MB based on duration and quality."""
        if self.format == "wav":
            # Uncompressed WAV: sample_rate * channels * 2 bytes per sample
            bytes_per_second = self.sample_rate * self.channels * 2
        else:
            # Compressed format: use bit rate
            bytes_per_second = (self.bit_rate * 1000) / 8

        total_bytes = bytes_per_second * duration_seconds
        return total_bytes / (1024 * 1024)  # Convert to MB

    def estimate_processing_time(self, duration_seconds: float, cpu_factor: float = 0.1,
    ) -> float:
        """Estimate processing time based on quality and duration."""
        # Higher quality generally takes longer to process
        quality_factor = {
            QualityPreset.LOW: 0.5,
            QualityPreset.MEDIUM: 1.0,
            QualityPreset.HIGH: 2.0,
            QualityPreset.TRANSCRIPTION_OPTIMIZED: 0.8,
        }.get(self.preset, 1.0)

        return duration_seconds * cpu_factor * quality_factor

    def is_mono(self) -> bool:
        """Check if output is mono (single channel)."""
        return self.channels == 1

    def is_stereo(self) -> bool:
        """Check if output is stereo (two channels)."""
        return self.channels == 2

    def is_high_quality(self) -> bool:
        """Check if this is considered high quality."""
        return self.preset in [QualityPreset.HIGH, QualityPreset.TRANSCRIPTION_OPTIMIZED]

    def is_optimized_for_transcription(self) -> bool:
        """Check if settings are optimized for speech transcription."""
        return (
            self.preset == QualityPreset.TRANSCRIPTION_OPTIMIZED or
            (self.sample_rate == 16000 and self.channels == 1)
        )

    def with_sample_rate(self, sample_rate: int,
    ) -> "ConversionQuality":
        """Create a new instance with different sample rate."""
        return ConversionQuality(
            sample_rate=sample_rate,
            channels=self.channels,
            bit_rate=self.bit_rate,
            format=self.format,
            preset=QualityPreset.MEDIUM,  # Reset to medium for custom settings
        )

    def with_channels(self, channels: int,
    ) -> "ConversionQuality":
        """Create a new instance with different channel count."""
        return ConversionQuality(
            sample_rate=self.sample_rate,
            channels=channels,
            bit_rate=self.bit_rate,
            format=self.format,
            preset=QualityPreset.MEDIUM,  # Reset to medium for custom settings
        )

    def to_dict(self) -> dict[str, object]:
        """Convert to dictionary representation."""
        return {
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "bit_rate": self.bit_rate,
            "format": self.format,
            "preset": self.preset.value,
        }

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> "ConversionQuality":
        """Create from dictionary representation."""
        return cls(
            sample_rate=data["sample_rate"],
            channels=data["channels"],
            bit_rate=data["bit_rate"],
            format=data["format"],
            preset=QualityPreset(data["preset"]),
        )