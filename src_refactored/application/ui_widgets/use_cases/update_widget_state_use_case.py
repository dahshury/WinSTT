"""Update Widget State Use Case

This module implements the UpdateWidgetStateUseCase for updating widget states
with visual feedback and validation.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from ....domain.ui_widgets.value_objects.ui_widget_operations import (
    StateChangeType,
    UpdatePhase,
    UpdateResult,
    WidgetType,
)


@dataclass
class WidgetStateConfiguration:
    """Configuration for widget state update operation."""
    apply_visual_feedback: bool
    emit_change_events: bool
    validate_state_transition: bool
    animate_transition: bool
    transition_duration_ms: int = 200
    force_update: bool = False


@dataclass
class UpdateWidgetStateRequest:
    """Request for updating widget state."""
    widget: Any  # QWidget
    widget_type: WidgetType
    new_state: dict[str, Any]
    change_type: StateChangeType
    configuration: WidgetStateConfiguration
    previous_state: dict[str, Any] | None = None
    timestamp: datetime = None

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.utcnow(,
    )


@dataclass
class WidgetStateChange:
    """Information about widget state change."""
    widget_id: str
    widget_type: WidgetType
    change_type: StateChangeType
    previous_state: dict[str, Any]
    new_state: dict[str, Any]
    change_timestamp: datetime
    visual_feedback_applied: bool
    events_emitted: list[str] = None

    def __post_init__(self):
        if self.events_emitted is None:
            self.events_emitted = []


@dataclass
class UpdateWidgetStateResponse:
    """Response from widget state update operation."""
    result: UpdateResult
    state_change: WidgetStateChange | None
    current_phase: UpdatePhase
    progress_percentage: float
    error_message: str | None = None
    warnings: list[str] = None
    execution_time_ms: float = 0.0

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class WidgetStateServiceProtocol(Protocol,
    ):
    """Protocol for widget state management operations."""

    def get_current_state(self, widget: Any, widget_type: WidgetType,
    ) -> dict[str, Any]:
        """Get current state of widget."""
        ...

    def set_widget_state(self, widget: Any, widget_type: WidgetType, state: dict[str, Any]) -> bool:
        """Set widget state."""
        ...

    def validate_state_transition(self,
    widget: Any, current_state: dict[str, Any], new_state: dict[str, Any]) -> list[str]:
        """Validate state transition and return errors."""
        ...


class WidgetValidationServiceProtocol(Protocol):
    """Protocol for widget validation operations."""

    def validate_widget(self, widget: Any,
    ) -> bool:
        """Validate widget exists and is accessible."""
        ...

    def validate_widget_type(self, widget: Any, expected_type: WidgetType,
    ) -> bool:
        """Validate widget matches expected type."""
        ...

    def validate_state_data(self, state: dict[str, Any], widget_type: WidgetType,
    ) -> list[str]:
        """Validate state data for widget type."""
        ...


class VisualFeedbackServiceProtocol(Protocol):
    """Protocol for visual feedback operations."""

    def apply_toggle_visual_feedback(self, widget: Any, new_value: int,
    ) -> bool:
        """Apply visual feedback for toggle switch state change."""
        ...

    def apply_generic_visual_feedback(
    self,
    widget: Any,
    widget_type: WidgetType,
    state: dict[str,
    Any]) -> bool:
        """Apply generic visual feedback for widget state change."""
        ...

    def animate_state_transition(self, widget: Any, duration_ms: int,
    ) -> bool:
        """Animate state transition."""
        ...


class EventEmissionServiceProtocol(Protocol):
    """Protocol for event emission operations."""

    def emit_state_change_events(self,
    widget: Any, widget_type: WidgetType, change_type: StateChangeType,
    ) -> list[str]:
        """Emit appropriate events for state change."""
        ...

    def emit_custom_event(self, widget: Any, event_name: str, event_data: dict[str, Any]) -> bool:
        """Emit custom event with data."""
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


class UpdateWidgetStateUseCase:
    """Use case for updating widget states with visual feedback and validation."""

    def __init__(
        self,
        state_service: WidgetStateServiceProtocol,
        validation_service: WidgetValidationServiceProtocol,
        visual_feedback_service: VisualFeedbackServiceProtocol,
        event_service: EventEmissionServiceProtocol,
        progress_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self.state_service = state_service
        self.validation_service = validation_service
        self.visual_feedback_service = visual_feedback_service
        self.event_service = event_service
        self.progress_service = progress_service
        self.logger_service = logger_service

    def execute(self, request: UpdateWidgetStateRequest,
    ) -> UpdateWidgetStateResponse:
        """Execute the widget state update operation."""
        start_time = datetime.utcnow()
        session_id = f"update_state_{start_time.timestamp()}"

        try:
            # Phase 1: Initialization
            self.progress_service.start_progress_session(session_id, 7)
            self.progress_service.update_progress(session_id, UpdatePhase.INITIALIZATION, 0.0)

            self.logger_service.log_info(
                "Starting widget state update",
                {
                    "session_id": session_id,
                    "widget_type": request.widget_type.value,
                    "change_type": request.change_type.value,
                },
            )

            # Phase 2: Widget Validation
            self.progress_service.update_progress(session_id, UpdatePhase.WIDGET_VALIDATION, 15.0)

            if not self.validation_service.validate_widget(request.widget):
                return self._create_error_response(
                    UpdateResult.WIDGET_NOT_FOUND,
                    UpdatePhase.WIDGET_VALIDATION,
                    15.0,
                    "Widget not found or not accessible",
                    start_time,
                )

            if not self.validation_service.validate_widget_type(request.widget, request.widget_type):
                return self._create_error_response(
                    UpdateResult.VALIDATION_ERROR,
                    UpdatePhase.WIDGET_VALIDATION,
                    15.0,
                    f"Widget type mismatch. Expected: {request.widget_type.value}",
                    start_time,
                )

            # Phase 3: State Validation
            self.progress_service.update_progress(session_id, UpdatePhase.STATE_VALIDATION, 30.0)

            # Validate new state data
state_errors = (
    self.validation_service.validate_state_data(request.new_state, request.widget_type))
            if state_errors:
                return self._create_error_response(
                    UpdateResult.VALIDATION_ERROR,
                    UpdatePhase.STATE_VALIDATION,
                    30.0,
                    f"State validation failed: {'; '.join(state_errors)}",
                    start_time,
                )

            # Get current state
current_state = (
    self.state_service.get_current_state(request.widget, request.widget_type))

            # Validate state transition if required
            if request.configuration.validate_state_transition:
                transition_errors = self.state_service.validate_state_transition(
                    request.widget, current_state, request.new_state,
                )
                if transition_errors and not request.configuration.force_update:
                    return self._create_error_response(
                        UpdateResult.STATE_CONFLICT,
                        UpdatePhase.STATE_VALIDATION,
                        30.0,
                        f"State transition validation failed: {'; '.join(transition_errors)}",
                        start_time,
                    )

            # Phase 4: State Update
            self.progress_service.update_progress(session_id, UpdatePhase.STATE_UPDATE, 50.0)

            try:
                if not self.state_service.set_widget_state(request.widget, request.widget_type, request.new_state):
                    return self._create_error_response(
                        UpdateResult.INTERNAL_ERROR,
                        UpdatePhase.STATE_UPDATE,
                        50.0,
                        "Failed to update widget state",
                        start_time,
                    )
            except Exception as e:
                return self._create_error_response(
                    UpdateResult.INTERNAL_ERROR,
                    UpdatePhase.STATE_UPDATE,
                    50.0,
                    f"Error updating widget state: {e!s}",
                    start_time,
                )

            # Phase 5: Visual Feedback
            self.progress_service.update_progress(session_id, UpdatePhase.VISUAL_FEEDBACK, 70.0)

            visual_feedback_applied = False
            if request.configuration.apply_visual_feedback:
                try:
if request.widget_type = (
    = WidgetType.TOGGLE_SWITCH and "value" in request.new_state:)
visual_feedback_applied = (
    self.visual_feedback_service.apply_toggle_visual_feedback()
                            request.widget, request.new_state["value"],
                        )
                    else:
visual_feedback_applied = (
    self.visual_feedback_service.apply_generic_visual_feedback()
                            request.widget, request.widget_type, request.new_state,
                        )

                    # Apply animation if requested
                    if request.configuration.animate_transition:
                        self.visual_feedback_service.animate_state_transition(
                            request.widget, request.configuration.transition_duration_ms,
                        )

                except Exception as e:
                    self.logger_service.log_warning(
                        "Failed to apply visual feedback",
                        {"session_id": session_id, "error": str(e)},
                    )

            # Phase 6: Event Emission
            self.progress_service.update_progress(session_id, UpdatePhase.EVENT_EMISSION, 85.0)

            emitted_events = []
            if request.configuration.emit_change_events:
                try:
                    emitted_events = self.event_service.emit_state_change_events(
                        request.widget, request.widget_type, request.change_type,
                    )
                except Exception as e:
                    self.logger_service.log_warning(
                        "Failed to emit some events",
                        {"session_id": session_id, "error": str(e)},
                    )

            # Phase 7: Completion
            self.progress_service.update_progress(session_id, UpdatePhase.COMPLETION, 100.0)
            self.progress_service.complete_progress_session(session_id)

            widget_id = f"widget_{id(request.widget)}"

            state_change = WidgetStateChange(
                widget_id=widget_id,
                widget_type=request.widget_type,
                change_type=request.change_type,
                previous_state=current_state,
                new_state=request.new_state,
                change_timestamp=datetime.utcnow()
                visual_feedback_applied=visual_feedback_applied,
                events_emitted=emitted_events,
            )

            execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

            self.logger_service.log_info(
                "Widget state update completed successfully",
                {
                    "session_id": session_id,
                    "widget_id": widget_id,
                    "execution_time_ms": execution_time,
                },
            )

            return UpdateWidgetStateResponse(
                result=UpdateResult.SUCCESS,
                state_change=state_change,
                current_phase=UpdatePhase.COMPLETION,
                progress_percentage=100.0,
                execution_time_ms=execution_time,
            )

        except Exception as e:
            self.logger_service.log_error(
                "Unexpected error during widget state update",
                {"session_id": session_id, "error": str(e)},
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
    ) -> UpdateWidgetStateResponse:
        """Create an error response with timing information."""
        execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

        return UpdateWidgetStateResponse(
            result=result,
            state_change=None,
            current_phase=phase,
            progress_percentage=progress,
            error_message=error_message,
            execution_time_ms=execution_time,
        )