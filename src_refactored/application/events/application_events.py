"""Application Domain Events.

This module defines domain events for the application layer,
implementing event-driven architecture patterns.
"""

import time
from typing import Any

from src_refactored.application.external_services.commands.call_external_service_command import (
    ServiceType,
)
from src_refactored.domain.common.events import DomainEvent
from src_refactored.domain.ui_text import UpdatePhase, UpdateResult
from src_refactored.domain.ui_widget_operations import HandlePhase, HandleResult, WidgetType


# UI-related Domain Events
class UITextUpdateRequested(DomainEvent):
    """Event raised when UI text update is requested."""
    def __init__(self, widget_id: str, text_content: str, update_type: str):
        super().__init__(
            event_id=f"ui_text_update_requested_{widget_id}_{time.time()}",
            timestamp=time.time(),
            source="ui_text_service",
        )
        self.widget_id = widget_id
        self.text_content = text_content
        self.update_type = update_type


# UI Text Update Events (centralized)
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


class UITextValidationCompleted(DomainEvent):
    """Event raised when UI text validation completes."""
    def __init__(self, widget_id: str, is_valid: bool, validation_errors: list[str]):
        super().__init__(
            event_id=f"ui_text_validation_completed_{widget_id}_{time.time()}",
            timestamp=time.time(),
            source="ui_text_service",
        )
        self.widget_id = widget_id
        self.is_valid = is_valid
        self.validation_errors = validation_errors


class UITextProcessingCompleted(DomainEvent):
    """Event raised when UI text processing completes."""
    def __init__(self, widget_id: str, processed_text: str, processing_duration: float):
        super().__init__(
            event_id=f"ui_text_processing_completed_{widget_id}_{time.time()}",
            timestamp=time.time(),
            source="ui_text_service",
        )
        self.widget_id = widget_id
        self.processed_text = processed_text
        self.processing_duration = processing_duration


class WidgetStateChanged(DomainEvent):
    """Event raised when widget state changes."""
    def __init__(self, widget_id: str, widget_type: WidgetType, old_state: dict[str, Any], new_state: dict[str, Any]):
        super().__init__(
            event_id=f"widget_state_changed_{widget_id}_{time.time()}",
            timestamp=time.time(),
            source="widget_service",
        )
        self.widget_id = widget_id
        self.widget_type = widget_type
        self.old_state = old_state
        self.new_state = new_state


# Widget Event Handling (centralized)
class WidgetEventHandlingStarted(DomainEvent):
    """Event raised when widget event handling starts."""
    def __init__(self, widget_id: str, event_type: str, widget_type: str):
        super().__init__(
            event_id=f"widget_event_handling_started_{widget_id}_{time.time()}",
            timestamp=time.time(),
            source="widget_event_service",
        )
        self.widget_id = widget_id
        self.event_type = event_type
        self.widget_type = widget_type


class WidgetEventHandlingCompleted(DomainEvent):
    """Event raised when widget event handling completes."""
    def __init__(self, widget_id: str, result: HandleResult, duration: float):
        super().__init__(
            event_id=f"widget_event_handling_completed_{widget_id}_{time.time()}",
            timestamp=time.time(),
            source="widget_event_service",
        )
        self.widget_id = widget_id
        self.result = result
        self.duration = duration


class WidgetEventHandlingFailed(DomainEvent):
    """Event raised when widget event handling fails."""
    def __init__(self, widget_id: str, error: str, phase: HandlePhase):
        super().__init__(
            event_id=f"widget_event_handling_failed_{widget_id}_{time.time()}",
            timestamp=time.time(),
            source="widget_event_service",
        )
        self.widget_id = widget_id
        self.error = error
        self.phase = phase


class WidgetEventProcessed(DomainEvent):
    """Event raised when widget event is processed."""
    def __init__(self, widget_id: str, event_type: str, processing_result: str, duration: float):
        super().__init__(
            event_id=f"widget_event_processed_{widget_id}_{time.time()}",
            timestamp=time.time(),
            source="widget_service",
        )
        self.widget_id = widget_id
        self.event_type = event_type
        self.processing_result = processing_result
        self.duration = duration


# External Service Events
class ExternalServiceIntegrationRequested(DomainEvent):
    """Event raised when external service integration is requested."""
    def __init__(self, service_type: ServiceType, service_name: str, operation: str, correlation_id: str):
        super().__init__(
            event_id=f"external_service_integration_requested_{correlation_id}",
            timestamp=time.time(),
            source="external_service_integration",
        )
        self.service_type = service_type
        self.service_name = service_name
        self.operation = operation
        self.correlation_id = correlation_id


class ExternalServiceResponseReceived(DomainEvent):
    """Event raised when external service response is received."""
    def __init__(self, correlation_id: str, service_name: str, response_size: int, duration: float):
        super().__init__(
            event_id=f"external_service_response_received_{correlation_id}",
            timestamp=time.time(),
            source="external_service_integration",
        )
        self.correlation_id = correlation_id
        self.service_name = service_name
        self.response_size = response_size
        self.duration = duration


class ExternalServiceErrorOccurred(DomainEvent):
    """Event raised when external service error occurs."""
    def __init__(self, correlation_id: str, service_name: str, error_type: str, error_message: str):
        super().__init__(
            event_id=f"external_service_error_occurred_{correlation_id}",
            timestamp=time.time(),
            source="external_service_integration",
        )
        self.correlation_id = correlation_id
        self.service_name = service_name
        self.error_type = error_type
        self.error_message = error_message


# Application Lifecycle Events
class ApplicationCommandExecutionStarted(DomainEvent):
    """Event raised when application command execution starts."""
    def __init__(self, command_type: str, command_id: str, user_context: dict[str, Any]):
        super().__init__(
            event_id=f"application_command_execution_started_{command_id}",
            timestamp=time.time(),
            source="application_service",
        )
        self.command_type = command_type
        self.command_id = command_id
        self.user_context = user_context


class ApplicationCommandExecutionCompleted(DomainEvent):
    """Event raised when application command execution completes."""
    def __init__(self, command_type: str, command_id: str, execution_duration: float, success: bool):
        super().__init__(
            event_id=f"application_command_execution_completed_{command_id}",
            timestamp=time.time(),
            source="application_service",
        )
        self.command_type = command_type
        self.command_id = command_id
        self.execution_duration = execution_duration
        self.success = success


class ApplicationQueryExecutionStarted(DomainEvent):
    """Event raised when application query execution starts."""
    def __init__(self, query_type: str, query_id: str, user_context: dict[str, Any]):
        super().__init__(
            event_id=f"application_query_execution_started_{query_id}",
            timestamp=time.time(),
            source="application_service",
        )
        self.query_type = query_type
        self.query_id = query_id
        self.user_context = user_context


class ApplicationQueryExecutionCompleted(DomainEvent):
    """Event raised when application query execution completes."""
    def __init__(self, query_type: str, query_id: str, execution_duration: float, result_size: int):
        super().__init__(
            event_id=f"application_query_execution_completed_{query_id}",
            timestamp=time.time(),
            source="application_service",
        )
        self.query_type = query_type
        self.query_id = query_id
        self.execution_duration = execution_duration
        self.result_size = result_size


# Business Process Events
class BusinessProcessStarted(DomainEvent):
    """Event raised when a business process starts."""
    def __init__(self, process_name: str, process_id: str, initiator: str, context: dict[str, Any]):
        super().__init__(
            event_id=f"business_process_started_{process_id}",
            timestamp=time.time(),
            source="business_process_service",
        )
        self.process_name = process_name
        self.process_id = process_id
        self.initiator = initiator
        self.context = context


class BusinessProcessStepCompleted(DomainEvent):
    """Event raised when a business process step completes."""
    def __init__(self, process_id: str, step_name: str, step_result: str, duration: float):
        super().__init__(
            event_id=f"business_process_step_completed_{process_id}_{step_name}_{time.time()}",
            timestamp=time.time(),
            source="business_process_service",
        )
        self.process_id = process_id
        self.step_name = step_name
        self.step_result = step_result
        self.duration = duration


class BusinessProcessCompleted(DomainEvent):
    """Event raised when a business process completes."""
    def __init__(self, process_id: str, process_name: str, total_duration: float, success: bool, result: dict[str, Any] | None = None):
        super().__init__(
            event_id=f"business_process_completed_{process_id}",
            timestamp=time.time(),
            source="business_process_service",
        )
        self.process_id = process_id
        self.process_name = process_name
        self.total_duration = total_duration
        self.success = success
        self.result = result or {}


class BusinessProcessFailed(DomainEvent):
    """Event raised when a business process fails."""
    def __init__(self, process_id: str, process_name: str, error_message: str, failed_step: str | None = None):
        super().__init__(
            event_id=f"business_process_failed_{process_id}",
            timestamp=time.time(),
            source="business_process_service",
        )
        self.process_id = process_id
        self.process_name = process_name
        self.error_message = error_message
        self.failed_step = failed_step


# Integration Events
class SystemIntegrationRequested(DomainEvent):
    """Event raised when system integration is requested."""
    def __init__(self, integration_type: str, target_system: str, operation: str, request_id: str):
        super().__init__(
            event_id=f"system_integration_requested_{request_id}",
            timestamp=time.time(),
            source="system_integration_service",
        )
        self.integration_type = integration_type
        self.target_system = target_system
        self.operation = operation
        self.request_id = request_id


class SystemIntegrationCompleted(DomainEvent):
    """Event raised when system integration completes."""
    def __init__(self, request_id: str, target_system: str, duration: float, data_transferred: int):
        super().__init__(
            event_id=f"system_integration_completed_{request_id}",
            timestamp=time.time(),
            source="system_integration_service",
        )
        self.request_id = request_id
        self.target_system = target_system
        self.duration = duration
        self.data_transferred = data_transferred


# Error and Monitoring Events
class ApplicationErrorOccurred(DomainEvent):
    """Event raised when application error occurs."""
    def __init__(self, error_type: str, error_message: str, context: dict[str, Any], severity: str = "error"):
        super().__init__(
            event_id=f"application_error_occurred_{time.time()}",
            timestamp=time.time(),
            source="application_error_handler",
        )
        self.error_type = error_type
        self.error_message = error_message
        self.context = context
        self.severity = severity


class PerformanceMetricRecorded(DomainEvent):
    """Event raised when performance metric is recorded."""
    def __init__(self, metric_name: str, metric_value: float, metric_unit: str, context: dict[str, Any]):
        super().__init__(
            event_id=f"performance_metric_recorded_{metric_name}_{time.time()}",
            timestamp=time.time(),
            source="performance_monitoring_service",
        )
        self.metric_name = metric_name
        self.metric_value = metric_value
        self.metric_unit = metric_unit
        self.context = context


class ResourceUsageThresholdExceeded(DomainEvent):
    """Event raised when resource usage threshold is exceeded."""
    def __init__(self, resource_type: str, current_usage: float, threshold: float, severity: str):
        super().__init__(
            event_id=f"resource_usage_threshold_exceeded_{resource_type}_{time.time()}",
            timestamp=time.time(),
            source="resource_monitoring_service",
        )
        self.resource_type = resource_type
        self.current_usage = current_usage
        self.threshold = threshold
        self.severity = severity