"""Update UI Text Command Handler.

This module implements the command handler for UI text updates,
focusing purely on business logic without UI concerns.
"""

import time
from typing import Protocol

from src_refactored.domain.common.abstractions import ICommandHandler
from src_refactored.domain.common.events import DomainEvent
from src_refactored.domain.common.result import Result
from src_refactored.domain.main_window.value_objects.ui_text import (
    UpdatePhase,
    UpdateResult,
)

from ..commands.update_ui_text_command import UpdateUITextCommand


# Domain Events for UI Text Updates
class UITextUpdateStarted(DomainEvent):
    """Event raised when UI text update starts."""
    def __init__(self, operation_id: str, text_count: int, widget_count: int):
        super().__init__(
            event_id=f"ui_text_update_started_{operation_id}",
            timestamp=time.time(),
            source="ui_text_service",
        )
        self.operation_id = operation_id
        self.text_count = text_count
        self.widget_count = widget_count


class UITextUpdateCompleted(DomainEvent):
    """Event raised when UI text update completes."""
    def __init__(self, operation_id: str, result: UpdateResult, duration: float):
        super().__init__(
            event_id=f"ui_text_update_completed_{operation_id}",
            timestamp=time.time(),
            source="ui_text_service",
        )
        self.operation_id = operation_id
        self.result = result
        self.duration = duration


class UITextUpdateFailed(DomainEvent):
    """Event raised when UI text update fails."""
    def __init__(self, operation_id: str, error: str, phase: UpdatePhase):
        super().__init__(
            event_id=f"ui_text_update_failed_{operation_id}",
            timestamp=time.time(),
            source="ui_text_service",
        )
        self.operation_id = operation_id
        self.error = error
        self.phase = phase


# Service Protocols (Ports)
class TextValidationServiceProtocol(Protocol):
    """Protocol for text validation service."""
    def validate_text_content(self, text_updates: list, config) -> Result[None]: ...
    def validate_widget_targets(self, targets: list) -> Result[None]: ...


class TextProcessingServiceProtocol(Protocol):
    """Protocol for text processing service."""
    def prepare_text_content(self, text_updates: list, config) -> Result[dict]: ...
    def format_text_content(self, content: dict, config) -> Result[dict]: ...
    def translate_text_content(self, content: dict, config) -> Result[dict]: ...


class DomainEventPublisherProtocol(Protocol):
    """Protocol for publishing domain events."""
    def publish(self, event: DomainEvent) -> None: ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging service."""
    def log_info(self, message: str, **kwargs) -> None: ...
    def log_error(self, message: str, **kwargs) -> None: ...
    def log_warning(self, message: str, **kwargs) -> None: ...


class UpdateUITextCommandHandler(ICommandHandler[UpdateUITextCommand]):
    """Command handler for UI text updates.
    
    This handler focuses on business logic and domain rules,
    delegating UI operations to infrastructure services.
    """

    def __init__(
        self,
        text_validation_service: TextValidationServiceProtocol,
        text_processing_service: TextProcessingServiceProtocol,
        event_publisher: DomainEventPublisherProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self._text_validation = text_validation_service
        self._text_processing = text_processing_service
        self._event_publisher = event_publisher
        self._logger = logger_service

    def handle(self, command: UpdateUITextCommand) -> Result[None]:
        """Handle UI text update command.
        
        Args:
            command: The UI text update command
            
        Returns:
            Result indicating success or failure
        """
        start_time = time.time()
        
        try:
            # Publish domain event for update started
            self._event_publisher.publish(
                UITextUpdateStarted(
                    command.operation_id,
                    len(command.text_updates),
                    len(command.target_widgets),
                ),
            )
            
            self._logger.log_info(
                f"Starting UI text update for operation {command.operation_id}",
                operation_id=command.operation_id,
                text_count=len(command.text_updates),
                widget_count=len(command.target_widgets),
            )

            # Phase 1: Validation
            validation_result = self._validate_command(command)
            if not validation_result.is_success:
                self._publish_failure_event(command.operation_id, validation_result.error, UpdatePhase.VALIDATION)
                return validation_result

            # Phase 2: Text Preparation
            preparation_result = self._text_processing.prepare_text_content(
                command.text_updates, 
                command.validation_config,
            )
            if not preparation_result.is_success:
                self._publish_failure_event(command.operation_id, preparation_result.error, UpdatePhase.TEXT_PREPARATION)
                return Result.failure(preparation_result.error)

            # Phase 3: Text Formatting
            if command.formatting_config:
                formatting_result = self._text_processing.format_text_content(
                    preparation_result.value,
                    command.formatting_config,
                )
                if not formatting_result.is_success:
                    self._publish_failure_event(command.operation_id, formatting_result.error, UpdatePhase.TEXT_FORMATTING)
                    return Result.failure(formatting_result.error)

            # Phase 4: Translation
            if command.translation_config:
                translation_result = self._text_processing.translate_text_content(
                    preparation_result.value,
                    command.translation_config,
                )
                if not translation_result.is_success:
                    self._publish_failure_event(command.operation_id, translation_result.error, UpdatePhase.TRANSLATION)
                    return Result.failure(translation_result.error)

            # Publish success event
            duration = time.time() - start_time
            self._event_publisher.publish(
                UITextUpdateCompleted(
                    command.operation_id,
                    UpdateResult.SUCCESS,
                    duration,
                ),
            )
            
            self._logger.log_info(
                f"UI text update completed successfully for operation {command.operation_id}",
                operation_id=command.operation_id,
                duration=duration,
            )

            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Unexpected error in UI text update: {e!s}"
            self._logger.log_error(error_msg, operation_id=command.operation_id)
            self._publish_failure_event(command.operation_id, error_msg, UpdatePhase.EXECUTION)
            return Result.failure(error_msg)

    def _validate_command(self, command: UpdateUITextCommand) -> Result[None]:
        """Validate the command data."""
        # Validate text content
        text_validation = self._text_validation.validate_text_content(
            command.text_updates,
            command.validation_config,
        )
        if not text_validation.is_success:
            return text_validation

        # Validate widget targets
        widget_validation = self._text_validation.validate_widget_targets(
            command.target_widgets,
        )
        if not widget_validation.is_success:
            return widget_validation

        return Result.success(None)

    def _publish_failure_event(self, operation_id: str, error: str, phase: UpdatePhase) -> None:
        """Publish failure domain event."""
        self._event_publisher.publish(
            UITextUpdateFailed(operation_id, error, phase),
        )
        self._logger.log_error(
            f"UI text update failed in {phase.value} phase",
            operation_id=operation_id,
            error=error,
            phase=phase.value,
        )