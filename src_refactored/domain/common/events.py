"""Domain Events for the Domain Layer."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


@dataclass(frozen=True)
class DomainEvent:
    """Base class for all domain events."""
    event_id: str
    timestamp: float
    source: str

    def __post_init__(self):
        import time
        import uuid
        if not self.event_id:
            object.__setattr__(self, "event_id", str(uuid.uuid4()))
        if not self.timestamp:
            object.__setattr__(self, "timestamp", time.time())


class DomainEventType(Enum):
    """Enumeration of domain event types."""
    # Audio Domain Events
    RECORDING_STARTED = "recording_started"
    RECORDING_STOPPED = "recording_stopped"
    AUDIO_PROCESSED = "audio_processed"
    AUDIO_VALIDATION_FAILED = "audio_validation_failed"

    # Transcription Domain Events
    TRANSCRIPTION_STARTED = "transcription_started"
    TRANSCRIPTION_COMPLETED = "transcription_completed"
    TRANSCRIPTION_FAILED = "transcription_failed"
    MODEL_LOADED = "model_loaded"
    MODEL_UNLOADED = "model_unloaded"

    # Settings Domain Events
    SETTINGS_UPDATED = "settings_updated"
    HOTKEY_CHANGED = "hotkey_changed"
    PREFERENCES_SAVED = "preferences_saved"

    # Common Domain Events
    PROGRESS_UPDATED = "progress_updated"
    PROCESSING_STARTED = "processing_started"
    PROCESSING_COMPLETED = "processing_completed"
    ERROR_OCCURRED = "error_occurred"
    VALIDATION_FAILED = "validation_failed"


# Specific Domain Events

@dataclass(frozen=True)
class RecordingStarted(DomainEvent):
    """Event raised when audio recording starts."""
    session_id: str
    audio_device: str
    sample_rate: int

    def __post_init__(self):
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "audio_session")


@dataclass(frozen=True)
class RecordingStopped(DomainEvent):
    """Event raised when audio recording stops."""
    session_id: str
    duration_seconds: float

    def __post_init__(self):
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "audio_session")


@dataclass(frozen=True)
class TranscriptionStarted(DomainEvent):
    """Event raised when transcription starts."""
    session_id: str
    model_name: str
    language: str

    def __post_init__(self):
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "transcription_service")


@dataclass(frozen=True)
class TranscriptionCompleted(DomainEvent):
    """Event raised when transcription completes."""
    session_id: str
    text: str
    confidence_score: float
    processing_time_ms: int

    def __post_init__(self):
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "transcription_service")


@dataclass(frozen=True)
class ProgressUpdated(DomainEvent):
    """Event raised when progress is updated."""
    operation_id: str
    percentage: float
    message: str

    def __post_init__(self):
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "progress_tracker")


@dataclass(frozen=True)
class ErrorOccurred(DomainEvent):
    """Event raised when an error occurs."""
    operation_id: str
    error_message: str
    error_type: str

    def __post_init__(self):
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "error_handler")