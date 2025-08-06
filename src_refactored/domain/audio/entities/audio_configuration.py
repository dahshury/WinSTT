"""
Audio Recorder Configuration Entity

Core entity for managing audio recorder configuration settings.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from src_refactored.domain.common.abstractions import Entity

if TYPE_CHECKING:
    from src_refactored.domain.audio.value_objects import (
        AudioFormat,
        BitDepth,
        ChannelCount,
        SampleRate,
    )


@dataclass
class AudioRecorderConfiguration(Entity):
    """
    Audio recorder configuration entity for managing recording settings.
    
    This entity encapsulates the configuration settings for audio recording
    operations including format, sample rate, channels, etc.
    """
    
    sample_rate: SampleRate | None = None
    channels: ChannelCount | None = None
    bit_depth: BitDepth | None = None
    audio_format: AudioFormat | None = None
    device_name: str = ""
    device_id: int | None = None
    chunk_size: int = 1024
    buffer_size: int = 1024
    max_duration: float = 300.0  # 5 minutes default
    
    def __post_init__(self):
        super().__post_init__()
    
    def is_valid(self) -> bool:
        """Check if the configuration is valid."""
        return (
            self.sample_rate is not None and
            self.channels is not None and
            self.bit_depth is not None and
            self.audio_format is not None
        )
    
    
    def get_bytes_per_second(self) -> int:
        """Calculate bytes per second for the current configuration."""
        if not self.is_valid():
            return 0
        
        # Basic calculation: sample_rate * channels * (bit_depth / 8)
        if self.sample_rate is None or self.channels is None or self.bit_depth is None:
            return 0
            
        return int(
            self.sample_rate.value * 
            self.channels.value * 
            (self.bit_depth.value / 8),
        )
    
    
    def get_max_file_size_bytes(self) -> int:
        """Calculate maximum file size in bytes."""
        return int(self.get_bytes_per_second() * self.max_duration) 