from __future__ import annotations

from src.building_blocks.errors import ApplicationError, AudioError, DomainError, ResourceError, TranscriptionError


class InvalidStateTransition(DomainError):
    """Raised when an invalid state machine transition is attempted."""


class RecordingError(AudioError):
    """Raised when recording operations fail."""


class AudioSourceError(AudioError):
    """Raised when audio source operations fail."""


class BufferOverflowError(ResourceError):
    """Raised when audio buffer overflows."""


class TranscriberNotReady(TranscriptionError):
    """Raised when transcriber is not ready for inference."""


class ServiceNotInitialized(ApplicationError):
    """Raised when service is used before initialization."""


class DownloadCancelledError(DomainError):
    """Raised when a model download is cancelled by the user."""
