"""Audio Data Conversion Service Protocol.

This module defines the protocol for audio data conversion services.
"""

from typing import Protocol

import numpy as np


class AudioDataConversionServiceProtocol(Protocol):
    """Protocol for audio data conversion service."""

    def convert_to_float32(self, data: np.ndarray) -> np.ndarray:
        """Convert audio data to float32 format.
        
        Args:
            data: Audio data array
            
        Returns:
            Audio data in float32 format
        """
        ...

    def convert_sample_rate(self, data: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
        """Convert audio data sample rate.
        
        Args:
            data: Audio data array
            source_rate: Source sample rate
            target_rate: Target sample rate
            
        Returns:
            Audio data with converted sample rate
        """
        ...

    def convert_to_mono(self, data: np.ndarray) -> np.ndarray:
        """Convert stereo audio to mono.
        
        Args:
            data: Audio data array
            
        Returns:
            Mono audio data
        """
        ...

    def normalize_bit_depth(self, data: np.ndarray, target_depth: int) -> np.ndarray:
        """Normalize audio bit depth.
        
        Args:
            data: Audio data array
            target_depth: Target bit depth
            
        Returns:
            Audio data with normalized bit depth
        """
        ...