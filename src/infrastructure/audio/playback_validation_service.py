"""Playback Validation Service.

This module implements the PlaybackValidationService for validating playback operations.
"""

import numpy as np

from src.domain.audio.value_objects.audio_configuration import PlaybackConfiguration

from .audio_playback_service import PlaybackValidationServiceProtocol


class PlaybackValidationService(PlaybackValidationServiceProtocol):
    """Service for validating playback operations."""

    def __init__(self):
        """Initialize the playback validation service."""

    def validate_configuration(self, config: PlaybackConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate playback configuration."""
        try:
            # Validate sample rate
            if config.sample_rate <= 0:
                return False, "Sample rate must be positive"

            # Validate channels
            if config.channels <= 0:
                return False, "Number of channels must be positive"

            # Validate volume
            if config.volume < 0 or config.volume > 1:
                return False, "Volume must be between 0 and 1"

            # Validate speed
            if config.speed <= 0:
                return False, "Playback speed must be positive"

            # Validate buffer size
            if config.buffer_size <= 0:
                return False, "Buffer size must be positive"

            return True, None

        except Exception as e:
            return False, str(e)

    def validate_audio_data(self, data: np.ndarray, config: PlaybackConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate audio data for playback."""
        try:
            if data is None:
                return False, "Audio data is required"

            if len(data.shape) == 0:
                return False, "Audio data cannot be empty"

            # Check if data is numeric
            if not np.issubdtype(data.dtype, np.number):
                return False, "Audio data must be numeric"

            # Check for NaN or infinite values
            if np.any(np.isnan(data)) or np.any(np.isinf(data)):
                return False, "Audio data contains NaN or infinite values"

            # Check data range (should be between -1 and 1 for normalized audio)
            if np.any(data < -1) or np.any(data > 1):
                return False, "Audio data values should be between -1 and 1"

            return True, None

        except Exception as e:
            return False, str(e)

    def validate_device_compatibility(self, device_id: int, config: PlaybackConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate device compatibility with configuration."""
        try:
            # For now, we'll assume all devices are compatible
            # In a real implementation, this would check device capabilities
            return True, None

        except Exception as e:
            return False, str(e)
