"""Audio Data Value Object.

This module contains the AudioData value object for representing
audio data for transcription processing.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class AudioData:
    """Audio data value object for transcription."""
    
    samples: Sequence[float]
    sample_rate: int
    duration_seconds: float
    channels: int = 1
    metadata: dict[str, Any] | None = None
    
    def __post_init__(self) -> None:
        """Validate audio data."""
        if len(self.samples) == 0:
            msg = "Audio samples cannot be empty"
            raise ValueError(msg)
        if self.sample_rate <= 0:
            msg = "Sample rate must be positive"
            raise ValueError(msg)
        if self.duration_seconds <= 0:
            msg = "Duration must be positive"
            raise ValueError(msg)
        if self.channels <= 0:
            msg = "Channel count must be positive"
            raise ValueError(msg)
        if self.duration_seconds > 300:  # 5 minutes max
            msg = "Audio duration too long (max 5 minutes)"
            raise ValueError(msg)
    
    @property
    def num_samples(self) -> int:
        """Get number of samples."""
        return len(self.samples)
    
    @property
    def is_mono(self) -> bool:
        """Check if audio is mono."""
        return self.channels == 1
    
    @property
    def is_stereo(self) -> bool:
        """Check if audio is stereo."""
        return self.channels == 2
    
    def __str__(self) -> str:
        return f"AudioData({self.duration_seconds:.2f}s, {self.sample_rate}Hz, {self.channels}ch)"
    
    def __repr__(self) -> str:
        return f"AudioData(samples={len(self.samples)}, sample_rate={self.sample_rate}, duration_seconds={self.duration_seconds})"
