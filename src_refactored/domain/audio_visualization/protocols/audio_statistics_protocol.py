"""Audio Statistics Service Protocol.

This module defines the protocol for audio statistics services.
"""

from typing import Protocol

from src_refactored.domain.audio.value_objects.audio_samples import (
    AudioSampleData,
    AudioStatistics,
)


class AudioStatisticsServiceProtocol(Protocol):
    """Protocol for audio statistics service."""

    def calculate_rms(self, data: AudioSampleData) -> float:
        """Calculate RMS value of audio data.
        
        Args:
            data: Audio sample data
            
        Returns:
            RMS value
        """
        ...

    def calculate_peak(self, data: AudioSampleData) -> float:
        """Calculate peak value of audio data.
        
        Args:
            data: Audio sample data
            
        Returns:
            Peak value
        """
        ...

    def calculate_statistics(self, data: AudioSampleData) -> AudioStatistics:
        """Calculate comprehensive statistics.
        
        Args:
            data: Audio sample data
            
        Returns:
            Audio statistics value object
        """
        ...