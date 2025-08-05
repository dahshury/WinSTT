"""Recording Result Value Object

Represents the result status of audio recording operations.
Business domain concept for audio recording outcomes.
"""

from enum import Enum


class RecordingResult(Enum):
    """Result status for recording operations."""
    SUCCESS = "success"
    FAILED = "failed"
    DEVICE_ERROR = "device_error"
    FORMAT_ERROR = "format_error"
    PERMISSION_ERROR = "permission_error"
    STORAGE_ERROR = "storage_error"
    BUFFER_ERROR = "buffer_error"
    TIMEOUT_ERROR = "timeout_error"
    QUALITY_ERROR = "quality_error"

    @property
    def is_success(self) -> bool:
        """Check if the result indicates success."""
        return self == RecordingResult.SUCCESS

    @property
    def is_device_related(self) -> bool:
        """Check if the result is related to device issues."""
        return self in [RecordingResult.DEVICE_ERROR, RecordingResult.BUFFER_ERROR]

    @property
    def is_permission_related(self) -> bool:
        """Check if the result is related to permission issues."""
        return self in [RecordingResult.PERMISSION_ERROR, RecordingResult.STORAGE_ERROR]

    @property
    def is_configuration_related(self) -> bool:
        """Check if the result is related to configuration issues."""
        return self in [RecordingResult.FORMAT_ERROR, RecordingResult.QUALITY_ERROR]

    @property
    def is_recoverable(self) -> bool:
        """Check if the error is potentially recoverable."""
        return self in [RecordingResult.TIMEOUT_ERROR, RecordingResult.BUFFER_ERROR]

    @property
    def requires_user_action(self) -> bool:
        """Check if the error requires user intervention."""
        return self in [
            RecordingResult.PERMISSION_ERROR,
            RecordingResult.DEVICE_ERROR,
            RecordingResult.STORAGE_ERROR,
        ]