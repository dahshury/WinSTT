"""Audio Listener Operations Value Objects

This module contains enums and value objects related to audio listener operations,
including listener states, events, and lifecycle management.
"""

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any

from src_refactored.domain.common.value_object import ValueObject


class ListenerState(Enum):
    """States of the audio listener."""
    IDLE = "idle"
    RECORDING = "recording"
    PROCESSING = "processing"
    TRANSCRIBING = "transcribing"
    ERROR = "error"
    SHUTTING_DOWN = "shutting_down"
    SHUTDOWN = "shutdown"


class ListenerEvent(Enum):
    """Events that can occur in the audio listener."""
    RECORDING_STARTED = "recording_started"
    RECORDING_STOPPED = "recording_stopped"
    TRANSCRIPTION_STARTED = "transcription_started"
    TRANSCRIPTION_COMPLETED = "transcription_completed"
    ERROR_OCCURRED = "error_occurred"
    STATE_CHANGED = "state_changed"
    AUDIO_PROCESSED = "audio_processed"
    HOTKEY_PRESSED = "hotkey_pressed"
    HOTKEY_RELEASED = "hotkey_released"


@dataclass(frozen=True)
class ListenerEventData(ValueObject):
    """Data associated with listener events."""
    event_type: ListenerEvent
    timestamp: datetime
    state_before: ListenerState | None = None
    state_after: ListenerState | None = None
    error_message: str | None = None
    audio_data: Any | None = None
    transcription_text: str | None = None
    metadata: dict[str, Any] | None = None

    def _get_equality_components(self) -> tuple[object, ...]:
        """Get components for equality comparison."""
        return (
            self.event_type,
            self.timestamp,
            self.state_before,
            self.state_after,
            self.error_message,
            self.transcription_text,
            tuple(sorted(self.metadata.items())) if self.metadata else (),
        )

    def __invariants__(self) -> None:
        """Validate listener event data invariants."""
        if self.event_type == ListenerEvent.STATE_CHANGED:
            if self.state_before is None or self.state_after is None:
                msg = "State change events must have before and after states"
                raise ValueError(msg)
        if self.event_type == ListenerEvent.ERROR_OCCURRED and not self.error_message:
            msg = "Error events must have an error message"
            raise ValueError(msg)
        if self.event_type == ListenerEvent.TRANSCRIPTION_COMPLETED:
            if not self.transcription_text:
                msg = "Transcription completed events must have transcription text"
                raise ValueError(msg)

    def is_state_transition(self) -> bool:
        """Check if this event represents a state transition."""
        return self.event_type == ListenerEvent.STATE_CHANGED

    def is_error_event(self) -> bool:
        """Check if this event represents an error."""
        return self.event_type == ListenerEvent.ERROR_OCCURRED

    def is_recording_event(self,
    ) -> bool:
        """Check if this event is related to recording."""
        return self.event_type in [
            ListenerEvent.RECORDING_STARTED,
            ListenerEvent.RECORDING_STOPPED,
        ]

    def is_transcription_event(self) -> bool:
        """Check if this event is related to transcription."""
        return self.event_type in [
            ListenerEvent.TRANSCRIPTION_STARTED,
            ListenerEvent.TRANSCRIPTION_COMPLETED,
        ]