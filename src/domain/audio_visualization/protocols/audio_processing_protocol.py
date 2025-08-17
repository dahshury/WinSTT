"""Audio Processing Service Protocol.

This module defines the protocol for audio processing services.
"""

from dataclasses import dataclass, field
from typing import Any, Protocol

from src.domain.audio.value_objects.audio_samples import AudioSampleData


@dataclass(frozen=True)
class AudioProcessingResult:
    """Result of audio processing operation."""
    
    processed_data: AudioSampleData
    processing_applied: bool
    metadata: dict[str, Any] = field(default_factory=dict)


class AudioProcessingServiceProtocol(Protocol):
    """Protocol for audio processing service."""

    def apply_clipping(
        self,
        data: AudioSampleData,
        threshold: float = 1.0,
    ) -> AudioProcessingResult:
        """Apply clipping to audio data.
        
        Args:
            data: Audio sample data
            threshold: Clipping threshold
            
        Returns:
            Processing result with clipped data and metadata
        """
        ...

    def center_data(self, data: AudioSampleData) -> AudioSampleData:
        """Center audio data around zero.
        
        Args:
            data: Audio sample data
            
        Returns:
            Centered audio data
        """
        ...

    def apply_scaling(self, data: AudioSampleData, factor: float) -> AudioSampleData:
        """Apply scaling factor to audio data.
        
        Args:
            data: Audio sample data
            factor: Scaling factor
            
        Returns:
            Scaled audio data
        """
        ...

    def normalize_audio(self, data: AudioSampleData) -> AudioSampleData:
        """Normalize audio levels.
        
        Args:
            data: Audio sample data
            
        Returns:
            Normalized audio data
        """
        ...

    def remove_silence(self, data: AudioSampleData, threshold: float = 0.01) -> AudioSampleData:
        """Remove silence from audio.
        
        Args:
            data: Audio sample data
            threshold: Silence detection threshold
            
        Returns:
            Audio data with silence removed
        """
        ...

    def get_audio_duration(self, data: AudioSampleData) -> float:
        """Get audio duration in seconds.
        
        Args:
            data: Audio sample data
            
        Returns:
            Duration in seconds
        """
        ...