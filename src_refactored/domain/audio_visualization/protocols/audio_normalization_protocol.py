"""Audio Normalization Service Protocol.

This module defines the protocol for audio normalization services.
"""

from typing import Protocol

import numpy as np


class AudioNormalizationServiceProtocol(Protocol):
    """Protocol for audio normalization service."""

    def normalize_for_speech(self, data: np.ndarray, scaling_factor: float = 0.3) -> np.ndarray:
        """Normalize audio data optimized for speech.
        
        Args:
            data: Audio data array
            scaling_factor: Scaling factor for normalization
            
        Returns:
            Normalized audio data
        """
        ...

    def normalize_rms_based(
        self,
        data: np.ndarray,
        target_rms: float,
        current_rms: float | None = None,
    ) -> np.ndarray:
        """Normalize audio data based on RMS.
        
        Args:
            data: Audio data array
            target_rms: Target RMS value
            current_rms: Current RMS value (calculated if not provided)
            
        Returns:
            RMS-normalized audio data
        """
        ...

    def normalize_peak_based(self, data: np.ndarray, target_peak: float = 1.0) -> np.ndarray:
        """Normalize audio data based on peak value.
        
        Args:
            data: Audio data array
            target_peak: Target peak value
            
        Returns:
            Peak-normalized audio data
        """
        ...

    def calculate_rms(self, data: np.ndarray) -> float:
        """Calculate RMS value of audio data.
        
        Args:
            data: Audio data array
            
        Returns:
            RMS value
        """
        ...