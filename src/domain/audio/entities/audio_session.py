"""
Audio Session Aggregate

Core aggregate for managing audio recording sessions with business rules.
Extracted from utils/listener.py AudioToText class.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING

from src.domain.audio.value_objects.audio_format import AudioFormat, Duration
from src.domain.common.abstractions import AggregateRoot
from src.domain.common.errors import (
    AudioDomainException,
    DomainError,
    ErrorCategory,
    ErrorSeverity,
)
from src.domain.common.events import DomainEvent
from src.domain.common.value_object import ProgressPercentage

if TYPE_CHECKING:
    from src.domain.audio.value_objects.audio_quality import AudioQuality
    from src.domain.common.ports.time_management_port import TimeManagementPort
    from src.domain.common.value_objects import Timestamp


class SessionState(Enum):
    """States for audio recording session."""
    IDLE = "idle"
    PREPARING = "preparing"
    RECORDING = "recording"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class RecordingStartedEvent(DomainEvent):
    """Domain event fired when recording starts."""
    session_id: str
    audio_format: AudioFormat
    expected_duration: Duration | None = None


@dataclass(frozen=True)
class RecordingStoppedEvent(DomainEvent):
    """Domain event fired when recording stops."""
    session_id: str
    duration: Duration
    data_size_bytes: int


@dataclass(frozen=True)
class AudioCapturedEvent(DomainEvent):
    """Domain event fired when audio data is captured."""
    session_id: str
    chunk_size_bytes: int
    total_size_bytes: int


@dataclass(frozen=True)
class SessionFailedEvent(DomainEvent):
    """Domain event fired when session fails."""
    session_id: str
    error_message: str
    error_code: str


@dataclass
class AudioSession(AggregateRoot):
    """
    Aggregate root for audio recording sessions.
    
    Manages the lifecycle of recording sessions with business rules
    extracted from the AudioToText class.
    """
    session_id: str
    audio_format: AudioFormat
    quality_settings: AudioQuality
    time_provider: TimeManagementPort
    state: SessionState = SessionState.IDLE
    started_at: Timestamp | None = None
    completed_at: Timestamp | None = None
    recorded_data_size: int = 0
    minimum_duration: Duration = field(default_factory=lambda: Duration(0.5))
    maximum_duration: Duration = field(default_factory=lambda: Duration(300.0))  # 5 minutes
    error_message: str | None = None

    def __post_init__(self) -> None:
        super().__init__(self.session_id)

    def start_recording(self) -> None:
        """
        Start recording session.
        Business rule: Can only start from IDLE state.
        """
        if self.state != SessionState.IDLE:
            error = DomainError(
                code="AUDIO_SESSION_INVALID_STATE_TRANSITION",
                message=f"Cannot start recording from state: {self.state}",
                category=ErrorCategory.BUSINESS_RULE,
                severity=ErrorSeverity.ERROR,
                context={"current_state": self.state.value, "session_id": self.session_id},
            )
            raise AudioDomainException(error)

        self.state = SessionState.PREPARING
        current_time_result = self.time_provider.get_current_time()
        if current_time_result.is_success is False:
            error = DomainError(
                code="AUDIO_SESSION_TIME_ERROR",
                message="Failed to get current time",
                category=ErrorCategory.OPERATION,
                severity=ErrorSeverity.ERROR,
                context={"session_id": self.session_id},
            )
            raise AudioDomainException(error)
        
        self.started_at = current_time_result.value
        self.recorded_data_size = 0
        self.error_message = None

        # Transition to recording state
        self.state = SessionState.RECORDING

        # Raise domain event
        event = RecordingStartedEvent(
            event_id="",
            timestamp=0.0,
            source="AudioSession",
            session_id=self.session_id,
            audio_format=self.audio_format,
        )
        self.add_domain_event(event)
        self.increment_version()

    def add_audio_data(self, data_size_bytes: int,
    ) -> None:
        """
        Add captured audio data.
        Business rule: Can only add data while recording.
        """
        if self.state != SessionState.RECORDING:
            msg = f"Cannot add audio data in state: {self.state}"
            raise ValueError(msg)

        self.recorded_data_size += data_size_bytes

        # Check maximum size limit (prevent excessive memory usage)
        max_size_bytes = int(self.maximum_duration.seconds * self.audio_format.bytes_per_second)
        if self.recorded_data_size > max_size_bytes:
            self.fail_session("Recording exceeded maximum duration",
    )
            return

        # Raise domain event for progress tracking
        event = AudioCapturedEvent(
            event_id="",
            timestamp=0.0,
            source="AudioSession",
            session_id=self.session_id,
            chunk_size_bytes=data_size_bytes,
            total_size_bytes=self.recorded_data_size,
        )
        self.add_domain_event(event)

    def stop_recording(self) -> None:
        """
        Stop recording session.
        Business rule: Can only stop from RECORDING state.
        """
        if self.state != SessionState.RECORDING:
            msg = f"Cannot stop recording from state: {self.state}"
            raise ValueError(msg)

        self.state = SessionState.PROCESSING

        # Calculate actual duration
        if self.started_at:
            current_time_result = self.time_provider.get_current_time()
            if current_time_result.is_success is False:
                self.fail_session("Failed to get current time for duration calculation")
                return
            
            current_time = current_time_result.value
            if self.started_at is None:
                return  # Can't calculate duration without start time
            if current_time is None or self.started_at is None:
                return
            duration_seconds = (current_time.value - self.started_at.value).total_seconds()
            actual_duration = Duration(duration_seconds)

            # Business rule: Check minimum duration
            if not actual_duration.is_minimum_duration:
                min_duration_msg = f"Recording too short: {actual_duration.seconds}s. Minimum: {self.minimum_duration.seconds}s"
                self.fail_session(min_duration_msg)
                return

            # Business rule: Check if we have sufficient data
            if self.recorded_data_size < 1024:  # Minimum 1KB
                self.fail_session("Insufficient audio data recorded")
                return

            # Success - complete the session
            completion_time_result = self.time_provider.get_current_time()
            if completion_time_result.is_success:
                self.completed_at = completion_time_result.value
            self.state = SessionState.COMPLETED

            # Raise domain event
            event = RecordingStoppedEvent(
                event_id="",
                timestamp=0.0,
                source="AudioSession",
                session_id=self.session_id,
                duration=actual_duration,
                data_size_bytes=self.recorded_data_size,
            )
            self.add_domain_event(event)
            self.increment_version()

    def fail_session(self, error_message: str, error_code: str = "RECORDING_ERROR") -> None:
        """Fail the session with an error."""
        self.state = SessionState.FAILED
        self.error_message = error_message
        completion_time_result = self.time_provider.get_current_time()
        if completion_time_result.is_success:
            self.completed_at = completion_time_result.value

        # Raise domain event
        event = SessionFailedEvent(
            event_id="",
            timestamp=0.0,
            source="AudioSession",
            session_id=self.session_id,
            error_message=error_message,
            error_code=error_code,
        )
        self.add_domain_event(event)
        self.increment_version()

    def cancel_session(self) -> None:
        """Cancel the recording session."""
        if self.state in [SessionState.COMPLETED, SessionState.FAILED]:
            error = DomainError(
                code="AUDIO_SESSION_CANCEL_INVALID_STATE",
                message=f"Cannot cancel session in final state: {self.state}",
                category=ErrorCategory.BUSINESS_RULE,
                severity=ErrorSeverity.ERROR,
                context={"current_state": self.state.value, "session_id": self.session_id},
            )
            raise AudioDomainException(error)

        self.state = SessionState.CANCELLED
        completion_time_result = self.time_provider.get_current_time()
        if completion_time_result.is_success:
            self.completed_at = completion_time_result.value
        self.increment_version()

    @property
    def duration(self) -> Duration | None:
        """Get session duration if available."""
        if not self.started_at:
            return None

        end_time = self.completed_at
        if not end_time:
            current_time_result = self.time_provider.get_current_time()
            if current_time_result.is_success is False:
                return None
            end_time = current_time_result.value
        
        if self.started_at is None or end_time is None:
            return None
        duration_seconds = (end_time.value - self.started_at.value).total_seconds()
        return Duration(duration_seconds)

    @property
    def is_active(self) -> bool:
        """Check if session is actively recording."""
        return self.state == SessionState.RECORDING

    @property
    def is_finished(self) -> bool:
        """Check if session is in a final state."""
        return self.state in [SessionState.COMPLETED, SessionState.FAILED, SessionState.CANCELLED]

    @property
    def recording_progress(self) -> ProgressPercentage:
        """Get recording progress based on duration."""
        if not self.duration:
            return ProgressPercentage(0.0)

        progress_ratio = min(self.duration.seconds / self.maximum_duration.seconds, 1.0)
        return ProgressPercentage.from_ratio(progress_ratio)

    @property
    def estimated_file_size_mb(self) -> float:
        """Estimate final file size in MB."""
        if not self.duration:
            return 0.0

        bytes_estimate = self.duration.seconds * self.audio_format.bytes_per_second
        return bytes_estimate / (1024 * 1024)

    def validate_session_requirements(self) -> bool:
        """
        Validate that session meets all business requirements.
        
        Returns:
            True if session is valid for processing.
        """
        if self.state != SessionState.COMPLETED:
            return False

        if not self.duration or not self.duration.is_minimum_duration:
            return False

        return not self.recorded_data_size < 1024