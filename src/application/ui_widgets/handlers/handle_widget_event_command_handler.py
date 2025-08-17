"""Handle Widget Event Command Handler.

This module implements the command handler for widget events,
focusing purely on business logic without UI concerns.
"""

import time
from typing import Protocol

from src.application.events.application_events import (
    WidgetEventHandlingCompleted,
    WidgetEventHandlingFailed,
    WidgetEventHandlingStarted,
)
from src.application.ui_widgets.commands.handle_widget_event_command import (
    HandleWidgetEventCommand,
)
from src.domain.common.abstractions import ICommandHandler
from src.domain.common.events import DomainEvent
from src.domain.common.result import Result
from src.domain.ui_widget_operations import (
    HandlePhase,
    HandleResult,
)


# Service Protocols (Ports)
class EventValidationServiceProtocol(Protocol):
    """Protocol for event validation service."""
    def validate_event_type_support(self, event_type, widget_type) -> bool: ...
    def validate_event_data(self, event, widget_type) -> list[str]: ...


class WidgetValidationServiceProtocol(Protocol):
    """Protocol for widget validation service."""
    def validate_widget_state(self, widget_type, widget_id: str) -> Result[None]: ...
    def validate_widget_accessibility(self, widget_type, widget_id: str) -> Result[None]: ...


class EventProcessingServiceProtocol(Protocol):
    """Protocol for event processing service."""
    def process_event(self, event, widget_type, config) -> Result[dict]: ...
    def coordinate_response(self, event_result: dict, config) -> Result[None]: ...


class DomainEventPublisherProtocol(Protocol):
    """Protocol for publishing domain events."""
    def publish(self, event: DomainEvent) -> None: ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging service."""
    def log_info(self, message: str, **kwargs) -> None: ...
    def log_error(self, message: str, **kwargs) -> None: ...
    def log_warning(self, message: str, **kwargs) -> None: ...


class HandleWidgetEventCommandHandler(ICommandHandler[HandleWidgetEventCommand]):
    """Command handler for widget events.
    
    This handler focuses on business logic and domain rules,
    delegating UI operations to infrastructure services.
    """

    def __init__(
        self,
        event_validation_service: EventValidationServiceProtocol,
        widget_validation_service: WidgetValidationServiceProtocol,
        event_processing_service: EventProcessingServiceProtocol,
        event_publisher: DomainEventPublisherProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self._event_validation = event_validation_service
        self._widget_validation = widget_validation_service
        self._event_processing = event_processing_service
        self._event_publisher = event_publisher
        self._logger = logger_service

    def handle(self, command: HandleWidgetEventCommand) -> Result[None]:
        """Handle widget event command.
        
        Args:
            command: The widget event command
            
        Returns:
            Result indicating success or failure
        """
        start_time = time.time()
        widget_id = command.event.source_widget_id or "unknown"
        
        try:
            # Publish domain event for handling started
            self._event_publisher.publish(
                WidgetEventHandlingStarted(
                    widget_id,
                    command.event.event_type.value,
                    command.widget_type.value,
                ),
            )
            
            self._logger.log_info(
                "Starting widget event handling",
                widget_id=widget_id,
                event_type=command.event.event_type.value,
                widget_type=command.widget_type.value,
            )

            # Phase 1: Event Validation
            validation_result = self._validate_event(command)
            if not validation_result.is_success:
                self._publish_failure_event(widget_id, validation_result.get_error(), HandlePhase.EVENT_VALIDATION)
                return validation_result

            # Phase 2: Widget Validation
            widget_validation_result = self._validate_widget(command, widget_id)
            if not widget_validation_result.is_success:
                self._publish_failure_event(widget_id, widget_validation_result.get_error(), HandlePhase.WIDGET_VALIDATION)
                return widget_validation_result

            # Phase 3: Event Processing
            processing_result = self._event_processing.process_event(
                command.event,
                command.widget_type,
                command.configuration,
            )
            if not processing_result.is_success:
                self._publish_failure_event(widget_id, processing_result.get_error(), HandlePhase.EVENT_PROCESSING)
                return Result.failure(processing_result.get_error())

            # Phase 4: Response Coordination
            if command.configuration.enable_response_coordination and processing_result.value is not None:
                coordination_result = self._event_processing.coordinate_response(
                    processing_result.value,
                    command.configuration,
                )
                if not coordination_result.is_success:
                    self._publish_failure_event(widget_id, coordination_result.get_error(), HandlePhase.RESPONSE_COORDINATION)
                    return Result.failure(coordination_result.get_error())

            # Publish success event
            duration = time.time() - start_time
            self._event_publisher.publish(
                WidgetEventHandlingCompleted(
                    widget_id,
                    HandleResult.SUCCESS,
                    duration,
                ),
            )
            
            self._logger.log_info(
                "Widget event handling completed successfully",
                widget_id=widget_id,
                duration=duration,
            )

            # Call completion callback if provided
            if command.completion_callback:
                # Callback signature: Callable[[bool, str], None]
                success = True
                message = "Event handled successfully"
                command.completion_callback(success, message)

            return Result.success(None)
            
        except (ValueError, TypeError, AttributeError, RuntimeError) as e:
            error_msg = f"Unexpected error in widget event handling: {e!s}"
            self._logger.log_error(error_msg, widget_id=widget_id)
            self._publish_failure_event(widget_id, error_msg, HandlePhase.EVENT_PROCESSING)
            
            # Call error callback if provided
            if command.error_callback:
                command.error_callback(error_msg, e)
            
            return Result.failure(error_msg)
        except Exception as e:
            # Last resort for any other unexpected exceptions
            error_msg = f"Critical error in widget event handling: {e!s}"
            self._logger.log_error(error_msg, widget_id=widget_id)
            self._publish_failure_event(widget_id, error_msg, HandlePhase.EVENT_PROCESSING)
            
            # Call error callback if provided
            if command.error_callback:
                command.error_callback(error_msg, e)
            
            return Result.failure(error_msg)

    def _validate_event(self, command: HandleWidgetEventCommand) -> Result[None]:
        """Validate the event data."""
        # Check event type support
        if not self._event_validation.validate_event_type_support(
            command.event.event_type,
            command.widget_type,
        ):
            return Result.failure(
                f"Event type {command.event.event_type.value} not supported for widget type {command.widget_type.value}",
            )

        # Validate event data if enabled
        if command.configuration.validate_event_data:
            event_errors = self._event_validation.validate_event_data(
                command.event,
                command.widget_type,
            )
            if event_errors:
                return Result.failure(f"Event validation errors: {', '.join(event_errors)}")

        return Result.success(None)

    def _validate_widget(self, command: HandleWidgetEventCommand, widget_id: str) -> Result[None]:
        """Validate the widget state."""
        # Validate widget state
        state_validation = self._widget_validation.validate_widget_state(
            command.widget_type,
            widget_id,
        )
        if not state_validation.is_success:
            return state_validation

        # Validate widget accessibility
        accessibility_validation = self._widget_validation.validate_widget_accessibility(
            command.widget_type,
            widget_id,
        )
        if not accessibility_validation.is_success:
            return accessibility_validation

        return Result.success(None)

    def _publish_failure_event(self, widget_id: str, error: str, phase: HandlePhase) -> None:
        """Publish failure domain event."""
        self._event_publisher.publish(
            WidgetEventHandlingFailed(widget_id, error, phase),
        )
        self._logger.log_error(
            f"Widget event handling failed in {phase.value} phase",
            widget_id=widget_id,
            error=error,
            phase=phase.value,
        )