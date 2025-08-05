"""Update Progress Use Case

This module implements the UpdateProgressUseCase for updating progress during
active sessions with visual feedback and state management.
"""

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Protocol


class UpdateResult(Enum):
    """Enumeration of possible progress update results."""
    SUCCESS = "success"
    SESSION_NOT_FOUND = "session_not_found"
    SESSION_INACTIVE = "session_inactive"
    INVALID_PROGRESS_VALUE = "invalid_progress_value"
    PROGRESS_BAR_ERROR = "progress_bar_error"
    VISUAL_UPDATE_ERROR = "visual_update_error"
    VALIDATION_ERROR = "validation_error"
    INTERNAL_ERROR = "internal_error"


class UpdatePhase(Enum):
    """Enumeration of progress update phases."""
    INITIALIZATION = "initialization"
    SESSION_VALIDATION = "session_validation"
    PROGRESS_VALIDATION = "progress_validation"
    PROGRESS_BAR_UPDATE = "progress_bar_update"
    VISUAL_FEEDBACK = "visual_feedback"
    STATE_SYNCHRONIZATION = "state_synchronization"
    COMPLETION = "completion"


class ProgressUpdateType(Enum):
    """Enumeration of progress update types."""
    PERCENTAGE = "percentage"
    ABSOLUTE_VALUE = "absolute_value"
    INCREMENT = "increment"
    DECREMENT = "decrement"
    RESET = "reset"


class VisualFeedbackType(Enum):
    """Enumeration of visual feedback types."""
    PROGRESS_BAR_ONLY = "progress_bar_only"
    TEXT_UPDATE = "text_update"
    COLOR_CHANGE = "color_change"
    ANIMATION = "animation"
    FULL_FEEDBACK = "full_feedback"


@dataclass
class ProgressUpdateConfiguration:
    """Configuration for progress updates."""
    update_type: ProgressUpdateType = ProgressUpdateType.PERCENTAGE
    visual_feedback_type: VisualFeedbackType = VisualFeedbackType.PROGRESS_BAR_ONLY
    animate_changes: bool = True
    update_text: bool = True
    validate_bounds: bool = True
    force_repaint: bool = False
    throttle_updates: bool = True
    throttle_interval_ms: int = 50


@dataclass
class ProgressValue:
    """Progress value with metadata."""
    value: float
    minimum: float = 0.0
    maximum: float = 100.0
    text: str | None = None
    format_string: str = "{:.1f}%"

    def __post_init__(self):
        if self.text is None:
            self.text = self.format_string.format(self.value,
    )


@dataclass
class UpdateProgressRequest:
    """Request for updating progress."""
    session_id: str
    progress_value: ProgressValue
    configuration: ProgressUpdateConfiguration = None
    message: str | None = None
    context_data: dict[str, Any] | None = None
    timestamp: datetime = None

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.utcnow()
        if self.configuration is None:
            self.configuration = ProgressUpdateConfiguration()
        if self.context_data is None:
            self.context_data = {}


@dataclass
class ProgressUpdateState:
    """State of progress update operation."""
    session_id: str
    previous_value: float
    current_value: float
    progress_delta: float
    update_count: int
    last_update_time: datetime
    visual_feedback_applied: bool
    text_updated: bool

    def __post_init__(self):
        self.progress_delta = self.current_value - self.previous_value


@dataclass
class UpdateProgressResponse:
    """Response from progress update operation."""
    result: UpdateResult
    update_state: ProgressUpdateState | None
    current_phase: UpdatePhase
    progress_percentage: float
    error_message: str | None = None
    warnings: list[str] = None
    execution_time_ms: float = 0.0
    throttled: bool = False

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class SessionLookupServiceProtocol(Protocol,
    ):
    """Protocol for session lookup operations."""

    def get_session(self, session_id: str,
    ) -> Any | None:
        """Get session by ID."""
        ...

    def is_session_active(self, session_id: str,
    ) -> bool:
        """Check if session is active."""
        ...

    def get_session_progress_bar(self, session_id: str,
    ) -> Any | None:
        """Get progress bar for session."""
        ...


class ProgressValidationServiceProtocol(Protocol):
    """Protocol for progress validation operations."""

    def validate_progress_value(self, progress_value: ProgressValue,
    ) -> list[str]:
        """Validate progress value and bounds."""
        ...

    def validate_progress_delta(self, previous: float, current: float, max_delta: float = 100.0,
    ) -> bool:
        """Validate progress change is reasonable."""
        ...

    def normalize_progress_value(self, value: float, minimum: float, maximum: float,
    ) -> float:
        """Normalize progress value to valid range."""
        ...


class ProgressBarUpdateServiceProtocol(Protocol):
    """Protocol for progress bar update operations."""

    def update_progress_bar_value(self, progress_bar: Any, value: float,
    ) -> bool:
        """Update progress bar value."""
        ...

    def update_progress_bar_range(self, progress_bar: Any, minimum: float, maximum: float,
    ) -> bool:
        """Update progress bar range."""
        ...

    def update_progress_bar_text(self, progress_bar: Any, text: str,
    ) -> bool:
        """Update progress bar text."""
        ...

    def force_progress_bar_repaint(self, progress_bar: Any,
    ) -> bool:
        """Force progress bar to repaint."""
        ...


class VisualFeedbackServiceProtocol(Protocol):
    """Protocol for visual feedback operations."""

    def apply_visual_feedback(self, widget: Any, feedback_type: VisualFeedbackType, value: float,
    ) -> bool:
        """Apply visual feedback to widget."""
        ...

def animate_progress_change(self, widget: Any, from_value: float, to_value: float, duration_ms: int = (
    200,),
    ) -> bool:
        """Animate progress change."""
        ...

    def update_progress_color(self, widget: Any, value: float,
    ) -> bool:
        """Update progress color based on value."""
        ...


class UpdateThrottlingServiceProtocol(Protocol):
    """Protocol for update throttling operations."""

    def should_throttle_update(self, session_id: str, interval_ms: int,
    ) -> bool:
        """Check if update should be throttled."""
        ...

    def record_update_time(self, session_id: str, timestamp: datetime,
    ) -> None:
        """Record update timestamp for throttling."""
        ...

    def get_last_update_time(self, session_id: str,
    ) -> datetime | None:
        """Get last update time for session."""
        ...


class StateManagementServiceProtocol(Protocol):
    """Protocol for state management operations."""

    def update_session_progress(self, session_id: str, progress_value: ProgressValue,
    ) -> bool:
        """Update session progress state."""
        ...

    def get_session_progress(self, session_id: str,
    ) -> float | None:
        """Get current session progress."""
        ...

    def increment_update_count(self, session_id: str,
    ) -> int:
        """Increment and return update count."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking operations."""

    def start_progress_session(self, session_id: str, total_phases: int,
    ) -> None:
        """Start a new progress tracking session."""
        ...

    def update_progress(self, session_id: str, phase: UpdatePhase, percentage: float,
    ) -> None:
        """Update progress for current phase."""
        ...

    def complete_progress_session(self, session_id: str,
    ) -> None:
        """Complete progress tracking session."""
        ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging operations."""

    def log_info(self, message: str, context: dict[str, Any] | None = None) -> None:
        """Log info message."""
        ...

    def log_warning(self, message: str, context: dict[str, Any] | None = None) -> None:
        """Log warning message."""
        ...

    def log_error(self, message: str, context: dict[str, Any] | None = None) -> None:
        """Log error message."""
        ...


class UpdateProgressUseCase:
    """Use case for updating progress during active sessions."""

    def __init__(
        self,
        session_lookup_service: SessionLookupServiceProtocol,
        progress_validation_service: ProgressValidationServiceProtocol,
        progress_bar_service: ProgressBarUpdateServiceProtocol,
        visual_feedback_service: VisualFeedbackServiceProtocol,
        throttling_service: UpdateThrottlingServiceProtocol,
        state_service: StateManagementServiceProtocol,
        progress_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self.session_lookup_service = session_lookup_service
        self.progress_validation_service = progress_validation_service
        self.progress_bar_service = progress_bar_service
        self.visual_feedback_service = visual_feedback_service
        self.throttling_service = throttling_service
        self.state_service = state_service
        self.progress_service = progress_service
        self.logger_service = logger_service

    def execute(self, request: UpdateProgressRequest,
    ) -> UpdateProgressResponse:
        """Execute the progress update operation."""
        start_time = datetime.utcnow()
        session_id = f"update_progress_{start_time.timestamp()}"

        try:
            # Phase 1: Initialization
            self.progress_service.start_progress_session(session_id, 7)
            self.progress_service.update_progress(session_id, UpdatePhase.INITIALIZATION, 0.0)

            self.logger_service.log_info(
                "Starting progress update",
                {
                    "session_id": request.session_id,
                    "progress_value": request.progress_value.value,
                    "message": request.message,
                },
            )

            # Check throttling first
            throttled = False
            if request.configuration.throttle_updates:
                if self.throttling_service.should_throttle_update(
                    request.session_id,
                    request.configuration.throttle_interval_ms,
                ):
                    throttled = True
                    self.logger_service.log_info(
                        "Progress update throttled",
                        {"session_id": request.session_id},
                    )

                    execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000
                    return UpdateProgressResponse(
                        result=UpdateResult.SUCCESS,
                        update_state=None,
                        current_phase=UpdatePhase.INITIALIZATION,
                        progress_percentage=0.0,
                        execution_time_ms=execution_time,
                        throttled=True,
                    )

            # Phase 2: Session Validation
            self.progress_service.update_progress(session_id, UpdatePhase.SESSION_VALIDATION, 14.3)

            # Check if session exists
            session = self.session_lookup_service.get_session(request.session_id)
            if not session:
                return self._create_error_response(
                    UpdateResult.SESSION_NOT_FOUND,
                    UpdatePhase.SESSION_VALIDATION,
                    14.3,
                    f"Session {request.session_id} not found",
                    start_time,
                )

            # Check if session is active
            if not self.session_lookup_service.is_session_active(request.session_id):
                return self._create_error_response(
                    UpdateResult.SESSION_INACTIVE,
                    UpdatePhase.SESSION_VALIDATION,
                    14.3,
                    f"Session {request.session_id} is not active",
                    start_time,
                )

            # Get progress bar
            progress_bar = self.session_lookup_service.get_session_progress_bar(request.session_id)
            if not progress_bar:
                return self._create_error_response(
                    UpdateResult.PROGRESS_BAR_ERROR,
                    UpdatePhase.SESSION_VALIDATION,
                    14.3,
                    "Progress bar not found for session",
                    start_time,
                )

            # Phase 3: Progress Validation
            self.progress_service.update_progress(session_id, UpdatePhase.PROGRESS_VALIDATION, 28.6)

            # Validate progress value
validation_errors = (
    self.progress_validation_service.validate_progress_value(request.progress_value))
            if validation_errors:
                return self._create_error_response(
                    UpdateResult.INVALID_PROGRESS_VALUE,
                    UpdatePhase.PROGRESS_VALIDATION,
                    28.6,
                    f"Progress validation failed: {'; '.join(validation_errors)}",
                    start_time,
                )

            # Get previous progress value
            previous_progress = self.state_service.get_session_progress(request.session_id) or 0.0

            # Validate progress delta
            if request.configuration.validate_bounds:
                if not self.progress_validation_service.validate_progress_delta(
                    previous_progress,
                    request.progress_value.value,
                ):
                    self.logger_service.log_warning(
                        "Large progress delta detected",
                        {
                            "session_id": request.session_id,
                            "previous": previous_progress,
                            "current": request.progress_value.value,
                        },
                    )

            # Normalize progress value
            normalized_value = self.progress_validation_service.normalize_progress_value(
                request.progress_value.value,
                request.progress_value.minimum,
                request.progress_value.maximum,
            )

            # Phase 4: Progress Bar Update
            self.progress_service.update_progress(session_id, UpdatePhase.PROGRESS_BAR_UPDATE, 42.9)

            try:
                # Update progress bar range if needed
                if not self.progress_bar_service.update_progress_bar_range(
                    progress_bar,
                    request.progress_value.minimum,
                    request.progress_value.maximum,
                ):
                    self.logger_service.log_warning(
                        "Failed to update progress bar range",
                        {"session_id": request.session_id},
                    )

                # Update progress bar value
                if not self.progress_bar_service.update_progress_bar_value(progress_bar, normalized_value):
                    return self._create_error_response(
                        UpdateResult.PROGRESS_BAR_ERROR,
                        UpdatePhase.PROGRESS_BAR_UPDATE,
                        42.9,
                        "Failed to update progress bar value",
                        start_time,
                    )

                # Update progress bar text if configured
                text_updated = False
                if request.configuration.update_text and request.progress_value.text:
                    if self.progress_bar_service.update_progress_bar_text(
                        progress_bar,
                        request.progress_value.text,
                    ):
                        text_updated = True
                    else:
                        self.logger_service.log_warning(
                            "Failed to update progress bar text",
                            {"session_id": request.session_id},
                        )

                # Force repaint if configured
                if request.configuration.force_repaint:
                    self.progress_bar_service.force_progress_bar_repaint(progress_bar)

            except Exception as e:
                return self._create_error_response(
                    UpdateResult.PROGRESS_BAR_ERROR,
                    UpdatePhase.PROGRESS_BAR_UPDATE,
                    42.9,
                    f"Progress bar update failed: {e!s}",
                    start_time,
                )

            # Phase 5: Visual Feedback
            self.progress_service.update_progress(session_id, UpdatePhase.VISUAL_FEEDBACK, 57.2)

            visual_feedback_applied = False
            try:
                # Apply visual feedback
                if self.visual_feedback_service.apply_visual_feedback(
                    progress_bar,
                    request.configuration.visual_feedback_type,
                    normalized_value,
                ):
                    visual_feedback_applied = True

                # Apply animation if configured
                if request.configuration.animate_changes and abs(normalized_value -
    previous_progress) > 0.1:
                    self.visual_feedback_service.animate_progress_change(
                        progress_bar,
                        previous_progress,
                        normalized_value,
                    )

                # Update color based on progress
                self.visual_feedback_service.update_progress_color(progress_bar, normalized_value)

            except Exception as e:
                self.logger_service.log_warning(
                    "Visual feedback update warning",
                    {"session_id": request.session_id, "error": str(e)},
                )

            # Phase 6: State Synchronization
            self.progress_service.update_progress(session_id, UpdatePhase.STATE_SYNCHRONIZATION, 71.5)

            try:
                # Update session progress state
                self.state_service.update_session_progress(request.session_id, request.progress_value)

                # Increment update count
                update_count = self.state_service.increment_update_count(request.session_id)

                # Record update time for throttling
                if request.configuration.throttle_updates:
                    self.throttling_service.record_update_time(request.session_id, request.timestamp)

            except Exception as e:
                self.logger_service.log_warning(
                    "State synchronization warning",
                    {"session_id": request.session_id, "error": str(e)},
                )
                update_count = 0

            # Phase 7: Completion
            self.progress_service.update_progress(session_id, UpdatePhase.COMPLETION, 100.0)
            self.progress_service.complete_progress_session(session_id)

            # Create update state
            update_state = ProgressUpdateState(
                session_id=request.session_id,
                previous_value=previous_progress,
                current_value=normalized_value,
                progress_delta=normalized_value - previous_progress,
                update_count=update_count,
                last_update_time=request.timestamp,
                visual_feedback_applied=visual_feedback_applied,
                text_updated=text_updated,
            )

            execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

            self.logger_service.log_info(
                "Progress updated successfully",
                {
                    "session_id": request.session_id,
                    "previous_value": previous_progress,
                    "current_value": normalized_value,
                    "execution_time_ms": execution_time,
                },
            )

            return UpdateProgressResponse(
                result=UpdateResult.SUCCESS,
                update_state=update_state,
                current_phase=UpdatePhase.COMPLETION,
                progress_percentage=100.0,
                execution_time_ms=execution_time,
                throttled=throttled,
            )

        except Exception as e:
            self.logger_service.log_error(
                "Unexpected error during progress update",
                {"session_id": request.session_id, "error": str(e)},
            )

            return self._create_error_response(
                UpdateResult.INTERNAL_ERROR,
                UpdatePhase.INITIALIZATION,
                0.0,
                f"Unexpected error: {e!s}",
                start_time,
            )

    def _create_error_response(
        self,
        result: UpdateResult,
        phase: UpdatePhase,
        progress: float,
        error_message: str,
        start_time: datetime,
    ) -> UpdateProgressResponse:
        """Create an error response with timing information."""
        execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

        return UpdateProgressResponse(
            result=result,
            update_state=None,
            current_phase=phase,
            progress_percentage=progress,
            error_message=error_message,
            execution_time_ms=execution_time,
        )