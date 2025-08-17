"""Audio Data Conversion Service Protocol.

This module defines the protocol for audio data conversion services.
"""

from typing import Any, Protocol

from src.domain.audio.value_objects.audio_samples import AudioDataType, AudioSampleData
from src.domain.audio.value_objects.sample_rate import SampleRate


class AudioDataConversionServiceProtocol(Protocol):
    """Protocol for audio data conversion service."""

    def convert_data_type(self, data: AudioSampleData, target_type: AudioDataType) -> AudioSampleData:
        """Convert audio data to specified format.
        
        Args:
            data: Audio sample data
            target_type: Target data type
            
        Returns:
            Audio data in target format
        """
        ...

    def convert_sample_rate(self, data: AudioSampleData, target_rate: SampleRate) -> AudioSampleData:
        """Convert audio data sample rate.
        
        Args:
            data: Audio sample data
            target_rate: Target sample rate
            
        Returns:
            Audio data with converted sample rate
        """
        ...

    def convert_to_mono(self, data: AudioSampleData) -> AudioSampleData:
        """Convert stereo audio to mono.
        
        Args:
            data: Audio sample data
            
        Returns:
            Mono audio data
        """
        ...

    def convert_to_numpy(self, data: Any, data_type: Any) -> Any:
        """Convert raw data to numpy array.
        
        Args:
            data: Raw audio data
            data_type: Type of the raw data
            
        Returns:
            Numpy array representation
        """
        ...

    def normalize_amplitude(self, data: AudioSampleData, target_peak: float = 1.0) -> AudioSampleData:
        """Normalize audio amplitude.
        
        Args:
            data: Audio sample data
            target_peak: Target peak amplitude
            
        Returns:
            Audio data with normalized amplitude
        """
        ...