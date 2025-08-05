"""Transcription Status Value Object.

Defines status states for transcription operations.
Extracted from infrastructure/transcription/onnx_transcription_service.py
"""

from enum import Enum


class TranscriptionStatus(Enum):
    """Transcription operation status.
    
    Represents the current state of a transcription operation.
    """
    IDLE = "idle"
    INITIALIZING = "initializing"
    DOWNLOADING = "downloading"
    PROCESSING = "processing"
    COMPLETED = "completed"
    ERROR = "error"

    def __str__(self) -> str:
        return self.value

    @property
    def is_active(self) -> bool:
        """Check if transcription is actively running."""
        return self in (TranscriptionStatus.INITIALIZING,
                       TranscriptionStatus.DOWNLOADING,
                       TranscriptionStatus.PROCESSING)

    @property
    def is_finished(self) -> bool:
        """Check if transcription has finished (success or error)."""
        return self in (TranscriptionStatus.COMPLETED, TranscriptionStatus.ERROR)

    @property
    def is_successful(self) -> bool:
        """Check if transcription completed successfully."""
        return self == TranscriptionStatus.COMPLETED

    @property
    def has_error(self) -> bool:
        """Check if transcription encountered an error."""
        return self == TranscriptionStatus.ERROR