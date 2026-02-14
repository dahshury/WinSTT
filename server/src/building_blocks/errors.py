from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from typing import Any


class DomainError(Exception):
    """Base exception for all domain errors.

    All domain exceptions should inherit from this to maintain a clear
    boundary between domain and infrastructure errors.
    """

    def __init__(self, message: str, **context: object) -> None:
        super().__init__(message)
        self.message = message
        self.context: dict[str, Any] = context

    def __str__(self) -> str:
        if self.context:
            context_str = ", ".join(f"{k}={v!r}" for k, v in self.context.items())
            return f"{self.message} ({context_str})"
        return self.message


class ApplicationError(DomainError):
    """Base exception for application-layer errors."""


class InfrastructureError(DomainError):
    """Base exception for infrastructure-layer errors."""


class ValidationError(DomainError):
    """Raised when input validation fails."""


class ResourceError(DomainError):
    """Base exception for resource-related errors."""


class AudioError(DomainError):
    """Base exception for audio-related errors."""


class TranscriptionError(DomainError):
    """Base exception for transcription-related errors."""


class VADError(DomainError):
    """Base exception for voice activity detection errors."""


class ConfigurationError(DomainError):
    """Raised when configuration is invalid or missing."""


class PipelineError(ApplicationError):
    """Raised when the recording pipeline encounters an error."""


class WakeWordError(DomainError):
    """Base exception for wake word detection errors."""


class NetworkError(InfrastructureError):
    """Raised when network operations fail."""


class IOError(InfrastructureError):
    """Raised when I/O operations fail."""


class ResourceExhaustedError(ResourceError):
    """Raised when a resource is exhausted (memory, disk, etc.)."""


class DeviceError(InfrastructureError):
    """Raised when audio device operations fail."""


class ModelError(InfrastructureError):
    """Raised when model operations fail (load, inference, etc.)."""


class ThreadError(ApplicationError):
    """Raised when thread operations fail."""


class ShutdownError(ApplicationError):
    """Raised when graceful shutdown fails."""
