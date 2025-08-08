"""Audio Data Validation Service Protocol.

This module defines the protocol for audio data validation services.
"""

from typing import Any, Protocol

from src_refactored.domain.audio.value_objects.audio_samples import (
    AudioSampleData,
    AudioValidationResult,
)


class AudioDataValidationServiceProtocol(Protocol):
    """Protocol for audio data validation service."""

    def validate_audio_data(self, data: AudioSampleData) -> bool:
        """Validate audio sample data.
        
        Args:
            data: Audio sample data
            
        Returns:
            True if data is valid
        """
        ...

    def validate_raw_data(self, data: Any, data_type: Any) -> bool:
        """Validate raw audio data.
        
        Args:
            data: Raw audio data
            data_type: Type of the raw data
            
        Returns:
            True if data is valid
        """
        ...

    def check_data_integrity(self, data: AudioSampleData) -> AudioValidationResult:
        """Check data integrity and return validation result.
        
        Args:
            data: Audio sample data
            
        Returns:
            Audio validation result with detailed information
        """
        ...