"""
Audio Format Value Object

Represents audio format specifications with validation.
Extracted from utils/listener.py recording configuration.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common.value_object import ValueObject


class AudioFormatType(Enum):
    """Supported audio format types."""
    WAV = "wav"
    MP3 = "mp3"
    FLAC = "flac"
    OGG = "ogg"


class BitDepth(Enum):
    """Supported bit depths for audio."""
    BIT_16 = 16
    BIT_24 = 24
    BIT_32 = 32


@dataclass(frozen=True)
class AudioFormat(ValueObject):
    """
    Value object for audio format configuration.
    Extracted from Recorder class initialization parameters.
    """
    format_type: AudioFormatType
    sample_rate: int
    channels: int
    bit_depth: BitDepth
    chunk_size: int

    def __post_init__(self):
        # Validate sample rate (common rates used in speech recognition)
        valid_sample_rates = [8000, 16000, 22050, 44100, 48000]
        if self.sample_rate not in valid_sample_rates:
            msg = f"Invalid sample rate: {self.sample_rate}. Must be one of {valid_sample_rates}"
            raise ValueError(msg)

        # Validate channels (mono or stereo)
        if self.channels not in [1, 2]:
            msg = f"Invalid channels: {self.channels}. Must be 1 (mono) or 2 (stereo)"
            raise ValueError(msg)

        # Validate chunk size (power of 2, reasonable range)
        if self.chunk_size < 64 or self.chunk_size > 8192:
            msg = f"Invalid chunk size: {self.chunk_size}. Must be between 64 and 8192"
            raise ValueError(msg)

        # Check if chunk size is power of 2
        if self.chunk_size & (self.chunk_size - 1,
    ) != 0:
            msg = f"Chunk size must be a power of 2, got: {self.chunk_size}"
            raise ValueError(msg)

    @property
    def is_mono(self) -> bool:
        """Check if audio format is mono."""
        return self.channels == 1

    @property
    def is_stereo(self) -> bool:
        """Check if audio format is stereo."""
        return self.channels == 2

    @property
    def bytes_per_sample(self) -> int:
        """Calculate bytes per sample."""
        return self.bit_depth.value // 8

    @property
    def bytes_per_frame(self) -> int:
        """Calculate bytes per frame (sample * channels)."""
        return self.bytes_per_sample * self.channels

    @property
    def bytes_per_second(self) -> int:
        """Calculate bytes per second for this format."""
        return self.sample_rate * self.bytes_per_frame

    @classmethod
    def for_speech_recognition(cls) -> AudioFormat:
        """Create standard format for speech recognition (16kHz, mono, 16-bit)."""
        return cls(
            format_type=AudioFormatType.WAV,
            sample_rate=16000,
            channels=1,
            bit_depth=BitDepth.BIT_16,
            chunk_size=256,
        )

    @classmethod
    def for_high_quality(cls) -> AudioFormat:
        """Create high-quality format (48kHz, stereo, 24-bit)."""
        return cls(
            format_type=AudioFormatType.WAV,
            sample_rate=48000,
            channels=2,
            bit_depth=BitDepth.BIT_24,
            chunk_size=1024,
        )


@dataclass(frozen=True)
class SampleRate(ValueObject):
    """Value object for audio sample rate with validation."""
    value: int

    def __post_init__(self):
        valid_rates = [8000, 16000, 22050, 44100, 48000, 96000]
        if self.value not in valid_rates:
            msg = f"Invalid sample rate: {self.value}. Must be one of {valid_rates}"
            raise ValueError(msg)

    @property
    def is_speech_rate(self,
    ) -> bool:
        """Check if this is a typical speech recognition rate."""
        return self.value in [8000, 16000]

    @property
    def is_music_rate(self) -> bool:
        """Check if this is a typical music rate."""
        return self.value in [44100, 48000, 96000]

    @property
    def nyquist_frequency(self) -> float:
        """Get Nyquist frequency (half the sample rate)."""
        return self.value / 2.0


@dataclass(frozen=True)
class Duration(ValueObject):
    """Value object for audio duration with business rules."""
    seconds: float

    def __post_init__(self):
        if self.seconds < 0:
            msg = f"Duration cannot be negative: {self.seconds}"
            raise ValueError(msg)
        if self.seconds > 24 * 3600:  # 24 hours max
            msg = f"Duration too long: {self.seconds}. Maximum 24 hours allowed"
            raise ValueError(msg)

    @property
    def milliseconds(self) -> float:
        """Duration in milliseconds."""
        return self.seconds * 1000

    @property
    def minutes(self) -> float:
        """Duration in minutes."""
        return self.seconds / 60

    @property
    def hours(self) -> float:
        """Duration in hours."""
        return self.seconds / 3600

    @property
    def is_minimum_duration(self) -> bool:
        """Check if duration meets minimum recording requirement (0.5s)."""
        return self.seconds >= 0.5

    def format_human_readable(self) -> str:
        """Format duration as human-readable string."""
        if self.seconds < 60:
            return f"{self.seconds:.1f}s"
        if self.seconds < 3600:
            minutes = int(self.seconds // 60)
            seconds = self.seconds % 60
            return f"{minutes}m {seconds:.1f}s"
        hours = int(self.seconds // 3600)
        minutes = int((self.seconds % 3600) // 60,
    )
        seconds = self.seconds % 60
        return f"{hours}h {minutes}m {seconds:.1f}s"

    @classmethod
    def from_milliseconds(cls, ms: float,
    ) -> Duration:
        """Create duration from milliseconds."""
        return cls(ms / 1000.0)

    @classmethod
    def from_minutes(cls, minutes: float,
    ) -> Duration:
        """Create duration from minutes."""
        return cls(minutes * 60.0)