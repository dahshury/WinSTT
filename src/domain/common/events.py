"""Domain Events for the Domain Layer."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .domain_utils import DomainIdentityGenerator


@dataclass(frozen=True)
class DomainEvent:
    """Base class for all domain events."""
    event_id: str
    timestamp: float
    source: str

    def __post_init__(self) -> None:
        if not self.event_id:
            object.__setattr__(self, "event_id", DomainIdentityGenerator.generate_domain_id("event"))
        if not self.timestamp:
            object.__setattr__(self, "timestamp", DomainIdentityGenerator.generate_timestamp())


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
    RECORDING_KEY_CHANGED = "recording_key_changed"
    MODEL_CONFIGURATION_CHANGED = "model_configuration_changed"
    LLM_CONFIGURATION_CHANGED = "llm_configuration_changed"
    AUDIO_CONFIGURATION_CHANGED = "audio_configuration_changed"
    OUTPUT_SRT_TOGGLED = "output_srt_toggled"
    LLM_PROCESSING_ENABLED = "llm_processing_enabled"
    LLM_PROCESSING_DISABLED = "llm_processing_disabled"

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

    def __post_init__(self) -> None:
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "audio_session")


@dataclass(frozen=True)
class RecordingStopped(DomainEvent):
    """Event raised when audio recording stops."""
    session_id: str
    duration_seconds: float

    def __post_init__(self) -> None:
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "audio_session")


@dataclass(frozen=True)
class TranscriptionStarted(DomainEvent):
    """Event raised when transcription starts."""
    session_id: str
    model_name: str
    language: str

    def __post_init__(self) -> None:
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

    def __post_init__(self) -> None:
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "transcription_service")


@dataclass(frozen=True)
class ProgressUpdated(DomainEvent):
    """Event raised when progress is updated."""
    operation_id: str
    percentage: float
    message: str

    def __post_init__(self) -> None:
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "progress_tracker")


@dataclass(frozen=True)
class ErrorOccurred(DomainEvent):
    """Event raised when an error occurs."""
    operation_id: str
    error_message: str
    error_type: str

    def __post_init__(self) -> None:
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "error_handler")


# Settings Domain Events

@dataclass(frozen=True)
class RecordingKeyChanged(DomainEvent):
    """Event raised when recording key combination changes."""
    old_key: str
    new_key: str

    def __post_init__(self) -> None:
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "user_preferences")


@dataclass(frozen=True)
class ModelConfigurationChanged(DomainEvent):
    """Event raised when model configuration changes."""
    old_model: str
    new_model: str
    old_quantization: str
    new_quantization: str

    def __post_init__(self) -> None:
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "user_preferences")


@dataclass(frozen=True)
class LLMConfigurationChanged(DomainEvent):
    """Event raised when LLM configuration changes."""
    old_enabled: bool
    new_enabled: bool
    old_model: str
    new_model: str

    def __post_init__(self) -> None:
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "user_preferences")


@dataclass(frozen=True)
class AudioConfigurationChanged(DomainEvent):
    """Event raised when audio configuration changes."""
    old_sample_rate: int
    new_sample_rate: int
    old_recording_sound_enabled: bool
    new_recording_sound_enabled: bool

    def __post_init__(self) -> None:
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "user_preferences")


@dataclass(frozen=True)
class OutputSRTToggled(DomainEvent):
    """Event raised when SRT output setting is toggled."""
    old_value: bool
    new_value: bool

    def __post_init__(self) -> None:
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "user_preferences")


@dataclass(frozen=True)
class LLMProcessingEnabled(DomainEvent):
    """Event raised when LLM processing is enabled."""
    model_name: str

    def __post_init__(self) -> None:
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "user_preferences")


@dataclass(frozen=True)
class LLMProcessingDisabled(DomainEvent):
    """Event raised when LLM processing is disabled."""
    model_name: str

    def __post_init__(self) -> None:
        super().__post_init__()
        if not self.source:
            object.__setattr__(self, "source", "user_preferences")