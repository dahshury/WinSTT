"""Audio Normalization Service Protocol.

This module defines the protocol for audio normalization services.
"""

from typing import Protocol

from src_refactored.domain.audio.value_objects.audio_samples import AudioSampleData


class AudioNormalizationServiceProtocol(Protocol):
    """Protocol for audio normalization service."""

    def normalize_for_speech(self, data: AudioSampleData, scaling_factor: float = 0.3) -> AudioSampleData:
        """Normalize audio data optimized for speech.
        
        Args:
            data: Audio sample data
            scaling_factor: Scaling factor for normalization
            
        Returns:
            Normalized audio data
        """
        ...

    def normalize_rms_based(
        self,
        data: AudioSampleData,
        target_rms: float,
        current_rms: float | None = None,
    ) -> AudioSampleData:
        """Normalize audio data based on RMS.
        
        Args:
            data: Audio sample data
            target_rms: Target RMS value
            current_rms: Current RMS value (calculated if not provided)
            
        Returns:
            RMS-normalized audio data
        """
        ...

    def normalize_peak_based(self, data: AudioSampleData, target_peak: float = 1.0) -> AudioSampleData:
        """Normalize audio data based on peak value.
        
        Args:
            data: Audio sample data
            target_peak: Target peak value
            
        Returns:
            Peak-normalized audio data
        """
        ...

    def apply_z_score_normalization(self, data: AudioSampleData, mean: float, std: float) -> AudioSampleData:
        """Apply z-score normalization to audio data.
        
        Args:
            data: Audio sample data
            mean: Mean value for normalization
            std: Standard deviation for normalization
            
        Returns:
            Z-score normalized audio data
        """
        ...

    def apply_min_max_normalization(self, data: AudioSampleData, min_val: float, max_val: float) -> AudioSampleData:
        """Apply min-max normalization to audio data.
        
        Args:
            data: Audio sample data
            min_val: Minimum value for normalization
            max_val: Maximum value for normalization
            
        Returns:
            Min-max normalized audio data
        """
        ...

    def calculate_rms(self, data: AudioSampleData) -> float:
        """Calculate RMS value of audio data.
        
        Args:
            data: Audio sample data
            
        Returns:
            RMS value
        """
        ...