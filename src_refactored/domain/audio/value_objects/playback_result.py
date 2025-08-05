"""Playback Result Value Object

Represents the result status of audio playback operations.
Business domain concept for audio playback outcomes.
"""

from enum import Enum


class PlaybackResult(Enum):
    """Result status for playback operations."""
    SUCCESS = "success"
    FAILED = "failed"
    DEVICE_ERROR = "device_error"
    FORMAT_ERROR = "format_error"
    FILE_ERROR = "file_error"
    PERMISSION_ERROR = "permission_error"
    BUFFER_ERROR = "buffer_error"
    TIMEOUT_ERROR = "timeout_error"

    @property
    def is_success(self) -> bool:
        """Check if the result indicates success."""
        return self == PlaybackResult.SUCCESS

    @property
    def is_device_related(self) -> bool:
        """Check if the result is related to device issues."""
        return self in [PlaybackResult.DEVICE_ERROR, PlaybackResult.BUFFER_ERROR]

    @property
    def is_file_related(self) -> bool:
        """Check if the result is related to file issues."""
        return self in [PlaybackResult.FILE_ERROR, PlaybackResult.FORMAT_ERROR, PlaybackResult.PERMISSION_ERROR]

    @property
    def is_recoverable(self) -> bool:
        """Check if the error is potentially recoverable."""
        return self in [PlaybackResult.TIMEOUT_ERROR, PlaybackResult.BUFFER_ERROR]