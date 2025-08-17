"""Handle Widget Event Presenter

This module implements the presenter for handling widget events
with state management and response coordination. Moved from application layer.
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from src.domain.ui_widget_operations import (
    EventPriority,
    WidgetType,
)
from src.presentation.ui_widgets.value_objects import (
    EventType,
    HandlePhase,
    HandleResult,
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
class HandleWidgetEventRequest:
    """Request to handle a widget event."""
    widget_id: str
    event_type: EventType
    event_data: dict[str, Any]
    widget_type: WidgetType
    configuration: EventHandlingConfiguration
    source_widget: Any | None = None
    timestamp: datetime | None = None


@dataclass
class HandleWidgetEventResponse:
    """Response from handling a widget event."""
    result: HandleResult
    widget_id: str
    event_handled: bool
    response_data: dict[str, Any] | None = None
    state_updated: bool = False
    events_emitted: list[str] | None = None
    error_message: str | None = None
    processing_time_ms: int | None = None
    phases_completed: list[HandlePhase] | None = None


class WidgetEventHandlerProtocol(Protocol):
    """Protocol for widget event handling."""
    
    def handle_event(self, widget: Any, event_type: EventType, event_data: dict[str, Any]) -> bool:
        """Handle a widget event."""
        ...


class HandleWidgetEventPresenter:
    """Presenter for handling widget events in the UI."""
    
    def __init__(self, event_handler: WidgetEventHandlerProtocol):
        """Initialize the presenter.
        
        Args:
            event_handler: Handler for widget events
        """
        self.event_handler = event_handler
    
    def present_event_handling(self, request: HandleWidgetEventRequest) -> HandleWidgetEventResponse:
        """Present widget event handling.
        
        Args:
            request: Request containing event details
            
        Returns:
            Response with handling results
        """
        start_time = datetime.now(UTC)
        
        try:
            # Validate event data if required
            if request.configuration.validate_event_data:
                validation_errors = self._validate_event_data(request.event_data, request.event_type)
                if validation_errors:
                    return HandleWidgetEventResponse(
                        result=HandleResult.VALIDATION_FAILED,
                        widget_id=request.widget_id,
                        event_handled=False,
                        error_message=f"Validation failed: {', '.join(validation_errors)}",
                    )
            
            # Handle the event
            success = self.event_handler.handle_event(
                request.source_widget,
                request.event_type, 
                request.event_data,
            )
            
            end_time = datetime.now(UTC)
            processing_time = int((end_time - start_time).total_seconds() * 1000)
            
            return HandleWidgetEventResponse(
                result=HandleResult.SUCCESS if success else HandleResult.FAILED,
                widget_id=request.widget_id,
                event_handled=success,
                state_updated=request.configuration.update_widget_state,
                processing_time_ms=processing_time,
                phases_completed=[HandlePhase.VALIDATION, HandlePhase.PROCESSING],
            )
            
        except Exception as e:
            end_time = datetime.now(UTC)
            processing_time = int((end_time - start_time).total_seconds() * 1000)
            
            return HandleWidgetEventResponse(
                result=HandleResult.FAILED,
                widget_id=request.widget_id,
                event_handled=False,
                error_message=str(e),
                processing_time_ms=processing_time,
            )
    
    def _validate_event_data(self, event_data: dict[str, Any], event_type: EventType) -> list[str]:
        """Validate event data.
        
        Args:
            event_data: Event data to validate
            event_type: Type of event
            
        Returns:
            List of validation errors
        """
        errors = []
        
        if event_type == EventType.CLICK and "position" not in event_data:
            errors.append("Click events require position data")
        
        if event_type == EventType.VALUE_CHANGED and "new_value" not in event_data:
            errors.append("Value changed events require new_value")
        
        return errors
