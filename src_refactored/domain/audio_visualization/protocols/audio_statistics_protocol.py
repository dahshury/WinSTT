"""Audio Statistics Service Protocol.

This module defines the protocol for audio statistics services.
"""

from typing import Protocol

import numpy as np


class AudioStatisticsServiceProtocol(Protocol):
    """Protocol for audio statistics service."""

    def calculate_rms(self, data: np.ndarray) -> float:
        """Calculate RMS value of audio data.
        
        Args:
            data: Audio data array
            
        Returns:
            RMS value
        """
        ...

    def calculate_peak(self, data: np.ndarray) -> float:
        """Calculate peak value of audio data.
        
        Args:
            data: Audio data array
            
        Returns:
            Peak value
        """
        ...

    def calculate_statistics(self, data: np.ndarray) -> dict[str, float]:
        """Calculate comprehensive statistics.
        
        Args:
            data: Audio data array
            
        Returns:
            Dictionary with statistics
        """
        ...