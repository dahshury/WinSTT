"""Recording Validation Service.

This module implements the RecordingValidationService for validating
recording configurations according to the protocol requirements.
"""

from pathlib import Path

from src_refactored.domain.audio.value_objects.audio_configuration import RecordingConfiguration
from src_refactored.infrastructure.audio.audio_recording_service import (
    RecordingValidationServiceProtocol,
)


class RecordingValidationService(RecordingValidationServiceProtocol):
    """Service for validating recording configurations."""

    def validate_configuration(self, config: RecordingConfiguration) -> tuple[bool, str | None]:
        """Validate recording configuration."""
        try:
            # Check sample rate
            if config.sample_rate not in [8000, 16000, 22050, 44100, 48000]:
                return False, f"Unsupported sample rate: {config.sample_rate}"
            
            # Check channels
            if config.channels not in [1, 2]:
                return False, f"Invalid channels: {config.channels}"
            
            # Check bit depth
            if config.bit_depth not in [16, 24, 32]:
                return False, f"Invalid bit depth: {config.bit_depth}"
            
            # Check buffer size
            if config.buffer_size < 64 or config.buffer_size > 8192:
                return False, f"Invalid buffer size: {config.buffer_size}"
            
            return True, None
            
        except Exception as e:
            return False, f"Configuration validation failed: {e}"

    def validate_file_path(self, file_path: Path) -> tuple[bool, str | None]:
        """Validate file path for recording."""
        try:
            # Check if directory exists or can be created
            if not file_path.parent.exists():
                try:
                    file_path.parent.mkdir(parents=True, exist_ok=True)
                except Exception:
                    return False, f"Cannot create directory: {file_path.parent}"
            
            # Check if file extension is supported
            if file_path.suffix.lower() not in [".wav", ".mp3", ".flac"]:
                return False, f"Unsupported file format: {file_path.suffix}"
            
            return True, None
            
        except Exception as e:
            return False, f"File path validation failed: {e}"

    def validate_device_compatibility(self, device_id: int, config: RecordingConfiguration) -> tuple[bool, str | None]:
        """Validate device compatibility."""
        try:
            # Basic validation - in a real implementation, you would check
            # actual device capabilities against the configuration
            
            # For now, just validate the configuration itself
            config_valid, config_error = self.validate_configuration(config)
            if not config_valid:
                return False, config_error
            
            # Check if device_id is reasonable
            if device_id < 0:
                return False, f"Invalid device ID: {device_id}"
            
            return True, None
            
        except Exception as e:
            return False, f"Device compatibility validation failed: {e}"
