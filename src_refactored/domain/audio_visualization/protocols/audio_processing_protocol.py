"""Audio Processing Service Protocol.

This module defines the protocol for audio processing services.
"""

from typing import Protocol

import numpy as np


class AudioProcessingServiceProtocol(Protocol):
    """Protocol for audio processing service."""

    def apply_clipping(
        self,
        data: np.ndarray,
        threshold: float = 1.0,
    ) -> tuple[np.ndarray, bool]:
        """Apply clipping to audio data.
        
        Args:
            data: Audio data array
            threshold: Clipping threshold
            
        Returns:
            Tuple of (clipped_data, clipping_occurred)
        """
        ...

    def center_data(self, data: np.ndarray) -> np.ndarray:
        """Center audio data around zero.
        
        Args:
            data: Audio data array
            
        Returns:
            Centered audio data
        """
        ...

    def apply_scaling(self, data: np.ndarray, factor: float) -> np.ndarray:
        """Apply scaling factor to audio data.
        
        Args:
            data: Audio data array
            factor: Scaling factor
            
        Returns:
            Scaled audio data
        """
        ...

    def normalize_audio(self, audio_bytes: bytes) -> bytes:
        """Normalize audio levels.
        
        Args:
            audio_bytes: Raw audio data
            
        Returns:
            Normalized audio data
        """
        ...

    def remove_silence(self, audio_bytes: bytes) -> bytes:
        """Remove silence from audio.
        
        Args:
            audio_bytes: Raw audio data
            
        Returns:
            Audio data with silence removed
        """
        ...

    def get_audio_duration(self, audio_bytes: bytes, sample_rate: int) -> float:
        """Get audio duration in seconds.
        
        Args:
            audio_bytes: Raw audio data
            sample_rate: Audio sample rate
            
        Returns:
            Duration in seconds
        """
        ...