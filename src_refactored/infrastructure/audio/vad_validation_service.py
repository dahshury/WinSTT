"""VAD Validation Service.

This module implements the VADValidationService for validating VAD operations.
"""


from src_refactored.domain.audio.value_objects import AudioChunk, VADConfiguration

from .vad_service import VADValidationServiceProtocol


class VADValidationService(VADValidationServiceProtocol):
    """Service for validating VAD operations."""

    def __init__(self):
        """Initialize the VAD validation service."""

    def validate_configuration(self, config: VADConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate VAD configuration."""
        try:
            # Validate sample rate
            if config.sample_rate <= 0:
                return False, "Sample rate must be positive"

            # Validate frame size
            if config.frame_size <= 0:
                return False, "Frame size must be positive"

            # Validate hop size
            if config.hop_size <= 0:
                return False, "Hop size must be positive"

            # Validate threshold
            if config.threshold < 0 or config.threshold > 1:
                return False, "Threshold must be between 0 and 1"

            # Validate frame size vs sample rate
            if config.frame_size > config.sample_rate:
                return False, "Frame size cannot be larger than sample rate"

            return True, None

        except Exception as e:
            return False, str(e)

    def validate_audio_chunk(self, chunk: AudioChunk,
    ) -> tuple[bool, str | None]:
        """Validate audio chunk for VAD processing."""
        try:
            if not chunk:
                return False, "Audio chunk is required"

            # Validate chunk has data
            if not hasattr(chunk, "data") or chunk.data is None:
                return False, "Audio chunk must have data"

            # Validate data is not empty
            if len(chunk.data) == 0:
                return False, "Audio chunk data cannot be empty"

            return True, None

        except Exception as e:
            return False, str(e)

    def validate_threshold(self, threshold: float,
    ) -> tuple[bool, str | None]:
        """Validate VAD threshold value."""
        try:
            if threshold < 0:
                return False, "Threshold cannot be negative"

            if threshold > 1:
                return False, "Threshold cannot be greater than 1"

            return True, None

        except Exception as e:
            return False, str(e)
