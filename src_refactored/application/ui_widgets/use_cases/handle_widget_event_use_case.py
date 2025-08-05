"""Handle Widget Event Use Case

This module implements the HandleWidgetEventUseCase for handling widget events
with state management and response coordination.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from ....domain.ui_widgets.value_objects.ui_widget_operations import (
    EventPriority,
    EventType,
    HandlePhase,
    HandleResult,
    WidgetType,
)


@dataclass
class EventHandlingConfiguration:
    """Configuration for event handling operation."""
    update_widget_state: bool
    emit_response_events: bool
    validate_event_data: bool
    handle_asynchronously: bool
    timeout_ms: int = 5000
    priority: EventPriority = EventPriority.NORMAL
    propagate_event: bool = True


@dataclass
class WidgetEvent:
    """Information about widget event."""
    event_type: EventType
    widget_type: WidgetType
    event_data: dict[str, Any]
    timestamp: datetime
    source_widget_id: str | None = None
    modifiers: list[str] = None
    position: tuple[int, int] | None = None

    def __post_init__(self):
        if self.modifiers is None:
            self.modifiers = []


@dataclass
class HandleWidgetEventRequest:
    """Request for handling widget event."""
    widget: Any  # QWidget
    widget_type: WidgetType
    event: WidgetEvent
    configuration: EventHandlingConfiguration
    custom_handler: Callable | None = None
    context_data: dict[str, Any] | None = None
    timestamp: datetime = None

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.utcnow(,
    )
        if self.context_data is None:
            self.context_data = {}


@dataclass
class EventHandlingResult:
    """Result of event handling operation."""
    event_handled: bool
    widget_id: str
    event_type: EventType
    widget_type: WidgetType
    state_changes: dict[str, Any]
    response_events: list[str]
    processing_time_ms: float
    handler_used: str
    context_updates: dict[str, Any] = None

    def __post_init__(self):
        if self.context_updates is None:
            self.context_updates = {}


@dataclass
class HandleWidgetEventResponse:
    """Response from widget event handling operation."""
    result: HandleResult
    handling_result: EventHandlingResult | None
    current_phase: HandlePhase
    progress_percentage: float
    error_message: str | None = None
    warnings: list[str] = None
    execution_time_ms: float = 0.0

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class EventValidationServiceProtocol(Protocol,
    ):
    """Protocol for event validation operations."""

    def validate_event_data(self, event: WidgetEvent, widget_type: WidgetType,
    ) -> list[str]:
        """Validate event data for widget type."""
        ...

    def validate_event_type_support(self, event_type: EventType, widget_type: WidgetType,
    ) -> bool:
        """Validate if event type is supported for widget type."""
        ...

    def validate_widget_event_compatibility(self, widget: Any, event: WidgetEvent,
    ) -> bool:
        """Validate widget and event compatibility."""
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

    def get_widget_id(self, widget: Any,
    ) -> str:
        """Get unique identifier for widget."""
        ...


class EventHandlerServiceProtocol(Protocol):
    """Protocol for event handler operations."""

    def get_handler_for_event(self, event_type: EventType, widget_type: WidgetType,
    ) -> Callable | None:
        """Get appropriate handler for event and widget type."""
        ...

    def handle_toggle_click_event(self, widget: Any, event_data: dict[str, Any]) -> dict[str, Any]:
        """Handle toggle switch click event."""
        ...

    def handle_value_change_event(self, widget: Any, event_data: dict[str, Any]) -> dict[str, Any]:
        """Handle value change event."""
        ...

    def handle_generic_event(self, widget: Any, event: WidgetEvent,
    ) -> dict[str, Any]:
        """Handle generic widget event."""
        ...


class StateManagementServiceProtocol(Protocol):
    """Protocol for state management operations."""

    def update_widget_state_from_event(self,
    widget: Any, widget_type: WidgetType, event_result: dict[str, Any]) -> bool:
        """Update widget state based on event handling result."""
        ...

    def get_state_changes(self,
    widget: Any, before_state: dict[str, Any], after_state: dict[str, Any]) -> dict[str, Any]:
        """Get state changes between before and after states."""
        ...

    def validate_state_change(self, widget: Any, state_changes: dict[str, Any]) -> list[str]:
        """Validate state changes."""
        ...


class ResponseCoordinationServiceProtocol(Protocol):
    """Protocol for response coordination operations."""

    def emit_response_events(self,
    widget: Any, event_result: dict[str, Any], state_changes: dict[str, Any]) -> list[str]:
        """Emit response events based on handling result."""
        ...

    def coordinate_async_response(
    self,
    widget: Any,
    event: WidgetEvent,
    handler_result: dict[str,
    Any]) -> bool:
        """Coordinate asynchronous response handling."""
        ...

    def propagate_event(self, widget: Any, event: WidgetEvent,
    ) -> bool:
        """Propagate event to parent or related widgets."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking operations."""

    def start_progress_session(self, session_id: str, total_phases: int,
    ) -> None:
        """Start a new progress tracking session."""
        ...

    def update_progress(self, session_id: str, phase: HandlePhase, percentage: float,
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


class HandleWidgetEventUseCase:
    """Use case for handling widget events with state management and response coordination."""

    def __init__(
        self,
        event_validation_service: EventValidationServiceProtocol,
        widget_validation_service: WidgetValidationServiceProtocol,
        event_handler_service: EventHandlerServiceProtocol,
        state_management_service: StateManagementServiceProtocol,
        response_coordination_service: ResponseCoordinationServiceProtocol,
        progress_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self.event_validation_service = event_validation_service
        self.widget_validation_service = widget_validation_service
        self.event_handler_service = event_handler_service
        self.state_management_service = state_management_service
        self.response_coordination_service = response_coordination_service
        self.progress_service = progress_service
        self.logger_service = logger_service

    def execute(self, request: HandleWidgetEventRequest,
    ) -> HandleWidgetEventResponse:
        """Execute the widget event handling operation."""
        start_time = datetime.utcnow()
        session_id = f"handle_event_{start_time.timestamp()}"

        try:
            # Phase 1: Initialization
            self.progress_service.start_progress_session(session_id, 8)
            self.progress_service.update_progress(session_id, HandlePhase.INITIALIZATION, 0.0)

            self.logger_service.log_info(
                "Starting widget event handling",
                {
                    "session_id": session_id,
                    "event_type": request.event.event_type.value,
                    "widget_type": request.widget_type.value,
                },
            )

            # Phase 2: Event Validation
            self.progress_service.update_progress(session_id, HandlePhase.EVENT_VALIDATION, 12.5)

            # Validate event type support
            if not self.event_validation_service.validate_event_type_support(request.event.event_type,
            request.widget_type):
                return self._create_error_response(
                    HandleResult.EVENT_NOT_SUPPORTED,
                    HandlePhase.EVENT_VALIDATION,
                    12.5,
                    f"Event type {request.event.event_type.value} not supported for widget type {request.widget_type.value}",
                    start_time,
                )

            # Validate event data
            if request.configuration.validate_event_data:
event_errors = (
    self.event_validation_service.validate_event_data(request.event, request.widget_type))
                if event_errors:
                    return self._create_error_response(
                        HandleResult.VALIDATION_ERROR,
                        HandlePhase.EVENT_VALIDATION,
                        12.5,
                        f"Event validation failed: {'; '.join(event_errors)}",
                        start_time,
                    )

            # Phase 3: Widget Validation
            self.progress_service.update_progress(session_id, HandlePhase.WIDGET_VALIDATION, 25.0)

            if not self.widget_validation_service.validate_widget(request.widget):
                return self._create_error_response(
                    HandleResult.WIDGET_NOT_FOUND,
                    HandlePhase.WIDGET_VALIDATION,
                    25.0,
                    "Widget not found or not accessible",
                    start_time,
                )

            if not self.widget_validation_service.validate_widget_type(request.widget, request.widget_type):
                return self._create_error_response(
                    HandleResult.VALIDATION_ERROR,
                    HandlePhase.WIDGET_VALIDATION,
                    25.0,
                    f"Widget type mismatch. Expected: {request.widget_type.value}",
                    start_time,
                )

            # Validate widget-event compatibility
            if not self.event_validation_service.validate_widget_event_compatibility(request.widget, request.event):
                return self._create_error_response(
                    HandleResult.VALIDATION_ERROR,
                    HandlePhase.WIDGET_VALIDATION,
                    25.0,
                    "Widget and event are not compatible",
                    start_time,
                )

            widget_id = self.widget_validation_service.get_widget_id(request.widget)

            # Phase 4: Handler Lookup
            self.progress_service.update_progress(session_id, HandlePhase.HANDLER_LOOKUP, 37.5)

            # Get appropriate handler
            handler = request.custom_handler
            handler_name = "custom"

            if not handler:
                handler = self.event_handler_service.get_handler_for_event(request.event.event_type,
                request.widget_type)
                handler_name = f"{request.event.event_type.value}_{request.widget_type.value}"

            if not handler:
                return self._create_error_response(
                    HandleResult.HANDLER_ERROR,
                    HandlePhase.HANDLER_LOOKUP,
                    37.5,
                    f"No handler found for event type {request.event.event_type.value} and widget type {request.widget_type.value}",
                    start_time,
                )

            # Phase 5: Event Processing
            self.progress_service.update_progress(session_id, HandlePhase.EVENT_PROCESSING, 50.0)

            # Get current state before processing
            current_state = self._get_widget_current_state(request.widget, request.widget_type)

            try:
                # Process event with appropriate handler
if request.widget_type = (
    = WidgetType.TOGGLE_SWITCH and request.event.event_type == EventType.MOUSE_CLICK:)
event_result = (
    self.event_handler_service.handle_toggle_click_event(request.widget,)
                    request.event.event_data)
                elif request.event.event_type == EventType.VALUE_CHANGED:
event_result = (
    self.event_handler_service.handle_value_change_event(request.widget,)
                    request.event.event_data)
                else:
event_result = (
    self.event_handler_service.handle_generic_event(request.widget, request.event))

            except Exception as e:
                return self._create_error_response(
                    HandleResult.HANDLER_ERROR,
                    HandlePhase.EVENT_PROCESSING,
                    50.0,
                    f"Error processing event: {e!s}",
                    start_time,
                )

            # Phase 6: State Management
            self.progress_service.update_progress(session_id, HandlePhase.STATE_MANAGEMENT, 62.5)

            state_changes = {}
            if request.configuration.update_widget_state:
                try:
                    if self.state_management_service.update_widget_state_from_event(
                        request.widget, request.widget_type, event_result,
                    ):
new_state = (
    self._get_widget_current_state(request.widget, request.widget_type))
                        state_changes = self.state_management_service.get_state_changes(
                            request.widget, current_state, new_state,
                        )

                        # Validate state changes
state_errors = (
    self.state_management_service.validate_state_change(request.widget,)
                        state_changes)
                        if state_errors:
                            self.logger_service.log_warning(
                                "State change validation warnings",
                                {"session_id": session_id, "warnings": state_errors},
                            )

                except Exception as e:
                    return self._create_error_response(
                        HandleResult.STATE_UPDATE_ERROR,
                        HandlePhase.STATE_MANAGEMENT,
                        62.5,
                        f"Error updating widget state: {e!s}",
                        start_time,
                    )

            # Phase 7: Response Coordination
            self.progress_service.update_progress(session_id, HandlePhase.RESPONSE_COORDINATION, 75.0)

            response_events = []
            if request.configuration.emit_response_events:
                try:
                    response_events = self.response_coordination_service.emit_response_events(
                        request.widget, event_result, state_changes,
                    )

                    # Handle asynchronous response if configured
                    if request.configuration.handle_asynchronously:
                        self.response_coordination_service.coordinate_async_response(
                            request.widget, request.event, event_result,
                        )

                    # Propagate event if configured
                    if request.configuration.propagate_event:
                        self.response_coordination_service.propagate_event(request.widget, request.event)

                except Exception as e:
                    self.logger_service.log_warning(
                        "Failed to coordinate some responses",
                        {"session_id": session_id, "error": str(e)},
                    )

            # Phase 8: Completion
            self.progress_service.update_progress(session_id, HandlePhase.COMPLETION, 100.0)
            self.progress_service.complete_progress_session(session_id)

            processing_time = (datetime.utcnow() - start_time).total_seconds() * 1000

            handling_result = EventHandlingResult(
                event_handled=True,
                widget_id=widget_id,
                event_type=request.event.event_type,
                widget_type=request.widget_type,
                state_changes=state_changes,
                response_events=response_events,
                processing_time_ms=processing_time,
                handler_used=handler_name,
                context_updates=request.context_data,
            )

            execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

            self.logger_service.log_info(
                "Widget event handling completed successfully",
                {
                    "session_id": session_id,
                    "widget_id": widget_id,
                    "execution_time_ms": execution_time,
                },
            )

            return HandleWidgetEventResponse(
                result=HandleResult.SUCCESS,
                handling_result=handling_result,
                current_phase=HandlePhase.COMPLETION,
                progress_percentage=100.0,
                execution_time_ms=execution_time,
            )

        except Exception as e:
            self.logger_service.log_error(
                "Unexpected error during widget event handling",
                {"session_id": session_id, "error": str(e)},
            )

            return self._create_error_response(
                HandleResult.INTERNAL_ERROR,
                HandlePhase.INITIALIZATION,
                0.0,
                f"Unexpected error: {e!s}",
                start_time,
            )

    def _get_widget_current_state(self, widget: Any, widget_type: WidgetType,
    ) -> dict[str, Any]:
        """Get current state of widget."""
        state = {}

        try:
            if widget_type == WidgetType.TOGGLE_SWITCH:
                state["value"] = getattr(widget, "value", lambda: 0,
    )()
                state["checked"] = getattr(widget, "isChecked", lambda: False,
    )()
                state["enabled"] = getattr(widget, "isEnabled", lambda: True,
    )()
            # Add more widget types as needed

        except Exception:
            # Return empty state if unable to get current state
            pass

        return state

    def _create_error_response(
        self,
        result: HandleResult,
        phase: HandlePhase,
        progress: float,
        error_message: str,
        start_time: datetime,
    ) -> HandleWidgetEventResponse:
        """Create an error response with timing information."""
        execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

        return HandleWidgetEventResponse(
            result=result,
            handling_result=None,
            current_phase=phase,
            progress_percentage=progress,
            error_message=error_message,
            execution_time_ms=execution_time,
        )