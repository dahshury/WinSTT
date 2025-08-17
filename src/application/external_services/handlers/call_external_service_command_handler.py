"""Call External Service Command Handler.

This module implements the command handler for external service calls,
abstracting service interactions from use cases.
"""

from typing import Any, Protocol

from src.application.events.application_events import (
    ExternalServiceErrorOccurred as ExternalServiceCallFailed,
)
from src.application.events.application_events import (
    ExternalServiceIntegrationRequested as ExternalServiceCallStarted,
)
from src.application.events.application_events import (
    ExternalServiceResponseReceived as ExternalServiceCallCompleted,
)
from src.domain.common.abstractions import ICommandHandler
from src.domain.common.events import DomainEvent
from src.domain.common.ports.cache_key_port import ICacheKeyPort
from src.domain.common.ports.time_port import ITimePort
from src.domain.common.result import Result

from ..commands.call_external_service_command import (
    CallExternalServiceCommand,
    CancelServiceCallCommand,
    ServiceType,
)


# Service Protocols (Ports)
class ServiceRegistryProtocol(Protocol):
    """Protocol for service registry."""
    def get_service(self, service_type: ServiceType, service_name: str) -> Any: ...
    def is_service_available(self, service_type: ServiceType, service_name: str) -> bool: ...
    def get_service_health(self, service_type: ServiceType, service_name: str) -> dict[str, Any]: ...


class CircuitBreakerProtocol(Protocol):
    """Protocol for circuit breaker pattern."""
    def is_open(self, service_name: str) -> bool: ...
    def record_success(self, service_name: str) -> None: ...
    def record_failure(self, service_name: str) -> None: ...


class CacheServiceProtocol(Protocol):
    """Protocol for caching service."""
    def get(self, key: str) -> Any: ...
    def set(self, key: str, value: Any, ttl_seconds: float) -> None: ...
    def delete(self, key: str) -> None: ...
    def exists(self, key: str) -> bool: ...


class MetricsServiceProtocol(Protocol):
    """Protocol for metrics collection."""
    def record_call_duration(self, service_name: str, operation: str, duration: float) -> None: ...
    def increment_call_count(self, service_name: str, operation: str, status: str) -> None: ...
    def record_error(self, service_name: str, operation: str, error_type: str) -> None: ...


class DomainEventPublisherProtocol(Protocol):
    """Protocol for publishing domain events."""
    def publish(self, event: DomainEvent) -> None: ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging service."""
    def log_info(self, message: str, **kwargs: Any) -> None: ...
    def log_error(self, message: str, **kwargs: Any) -> None: ...
    def log_warning(self, message: str, **kwargs: Any) -> None: ...


class CallExternalServiceCommandHandler(ICommandHandler[CallExternalServiceCommand]):
    """Command handler for external service calls.
    
    This handler abstracts external service interactions from use cases,
    providing consistent error handling, retry logic, and monitoring.
    """

    def __init__(
        self,
        service_registry: ServiceRegistryProtocol,
        circuit_breaker: CircuitBreakerProtocol,
        cache_service: CacheServiceProtocol,
        metrics_service: MetricsServiceProtocol,
        event_publisher: DomainEventPublisherProtocol,
        logger_service: LoggerServiceProtocol,
        time_port: ITimePort,
        cache_key_port: ICacheKeyPort | None = None,
    ):
        self._service_registry = service_registry
        self._circuit_breaker = circuit_breaker
        self._cache_service = cache_service
        self._metrics_service = metrics_service
        self._event_publisher = event_publisher
        self._logger = logger_service
        self._active_calls: dict[str, bool] = {}
        self._time = time_port
        self._cache_key = cache_key_port

    def handle(self, command: CallExternalServiceCommand) -> Result[None]:
        """Handle external service call command.
        
        Args:
            command: The external service call command
            
        Returns:
            Result containing service response or error
        """
        start_time = self._time.get_current_time()
        
        try:
            # Mark call as active
            self._active_calls[command.correlation_id] = True
            
            # Publish domain event for call started
            self._event_publisher.publish(
                ExternalServiceCallStarted(
                    command.service_type,
                    command.service_name,
                    command.operation_name,
                    command.correlation_id,
                ),
            )
            
            self._logger.log_info(
                "Starting external service call",
                correlation_id=command.correlation_id,
                service_name=command.service_name,
                operation=command.operation_name,
                service_type=command.service_type.value,
            )

            # Check if call was cancelled
            if not self._active_calls.get(command.correlation_id, False):
                return Result.failure("Service call was cancelled")

            # Check cache if enabled
            if command.configuration.enable_caching:
                cache_result = self._check_cache(command)
                if cache_result.is_success and cache_result.value is not None:
                    self._logger.log_info(
                        "Service call result retrieved from cache",
                        correlation_id=command.correlation_id,
                    )
                    # Call success callback with cached data
                    if command.success_callback:
                        command.success_callback(cache_result.value)
                    return Result.success(None)

            # Check circuit breaker
            if command.configuration.enable_circuit_breaker:
                if self._circuit_breaker.is_open(command.service_name):
                    error_msg = f"Circuit breaker is open for service {command.service_name}"
                    self._publish_failure_event(command, error_msg, 0)
                    return Result.failure(error_msg)

            # Validate service availability
            if not self._service_registry.is_service_available(command.service_type, command.service_name):
                error_msg = f"Service {command.service_name} is not available"
                self._publish_failure_event(command, error_msg, 0)
                return Result.failure(error_msg)

            # Execute service call with retry logic
            result = self._execute_with_retry(command)
            
            if result.is_success and result.value is not None:
                # Record success metrics
                end_time = self._time.get_current_time()
                duration = end_time - start_time
                self._record_success_metrics(command, duration, result.value)
                
                # Cache result if enabled
                if command.configuration.enable_caching:
                    self._cache_result(command, result.value)
                
                # Publish success event
                result_size = len(str(result.value)) if result.value else 0
                self._event_publisher.publish(
                    ExternalServiceCallCompleted(
                        command.correlation_id,
                        command.service_name,
                        result_size,
                        duration,
                    ),
                )
                
                # Call success callback if provided
                if command.success_callback:
                    command.success_callback(result.value)
                    
                self._logger.log_info(
                    "External service call completed successfully",
                    correlation_id=command.correlation_id,
                    duration=duration,
                )
                return Result.success(None)
            # Record failure metrics
            error_msg = result.error or "Unknown error"
            self._record_failure_metrics(command, error_msg)

            # Call error callback if provided
            if command.error_callback:
                command.error_callback(error_msg, Exception(error_msg))

            return Result.failure(error_msg)
            
        except Exception as e:
            error_msg = f"Unexpected error in external service call: {e!s}"
            self._logger.log_error(error_msg, correlation_id=command.correlation_id)
            self._publish_failure_event(command, error_msg, 0)
            
            # Call error callback if provided
            if command.error_callback:
                command.error_callback(error_msg, e)
            
            return Result.failure(error_msg)
        finally:
            # Clean up active call tracking
            self._active_calls.pop(command.correlation_id, None)

    def _execute_with_retry(self, command: CallExternalServiceCommand) -> Result[dict[str, Any]]:
        """Execute service call with retry logic."""
        last_error = ""
        
        for attempt in range(command.configuration.retry_count + 1):
            try:
                # Check if call was cancelled
                if not self._active_calls.get(command.correlation_id, False):
                    return Result.failure("Service call was cancelled")
                
                # Get service instance
                service = self._service_registry.get_service(
                    command.service_type,
                    command.service_name,
                )
                
                # Execute operation
                if hasattr(service, command.operation_name):
                    operation = getattr(service, command.operation_name)
                    
                    # Call with progress callback if provided
                    if command.progress_callback:
                        command.progress_callback(0.5, f"Executing {command.operation_name}")
                    
                    result = operation(**command.parameters)
                    
                    if command.progress_callback:
                        command.progress_callback(1.0, "Operation completed")
                    
                    # Record circuit breaker success
                    if command.configuration.enable_circuit_breaker:
                        self._circuit_breaker.record_success(command.service_name)
                    
                    # Ensure result is a dict
                    if isinstance(result, dict):
                        return Result.success(result)
                    # Convert to dict if it's not already
                    return Result.success({"result": result})
                return Result.failure(f"Operation {command.operation_name} not found on service {command.service_name}")
                    
            except Exception as e:
                last_error = str(e)
                
                # Record circuit breaker failure
                if command.configuration.enable_circuit_breaker:
                    self._circuit_breaker.record_failure(command.service_name)
                
                self._logger.log_warning(
                    f"Service call attempt {attempt + 1} failed",
                    correlation_id=command.correlation_id,
                    error=last_error,
                    attempt=attempt + 1,
                    max_attempts=command.configuration.retry_count + 1,
                )
                
                # Wait before retry (except on last attempt)
                if attempt < command.configuration.retry_count:
                    self._time.sleep(command.configuration.retry_delay_seconds)
        
        # All retries exhausted
        self._publish_failure_event(command, last_error, command.configuration.retry_count)
        return Result.failure(f"Service call failed after {command.configuration.retry_count + 1} attempts: {last_error}")

    def _check_cache(self, command: CallExternalServiceCommand) -> Result[dict[str, Any]]:
        """Check cache for existing result."""
        cache_key = self._generate_cache_key(command)
        
        if self._cache_service.exists(cache_key):
            cached_result = self._cache_service.get(cache_key)
            if cached_result is not None:
                return Result.success(cached_result)
        
        return Result.failure("No cached result found")

    def _cache_result(self, command: CallExternalServiceCommand, result: dict[str, Any]) -> None:
        """Cache service call result."""
        cache_key = self._generate_cache_key(command)
        self._cache_service.set(cache_key, result, command.configuration.cache_ttl_seconds)

    def _generate_cache_key(self, command: CallExternalServiceCommand) -> str:
        """Generate cache key for service call using injected strategy when available."""
        if self._cache_key is not None:
            return self._cache_key.generate_key(
                service_name=command.service_name,
                operation_name=command.operation_name,
                parameters=command.parameters,
            )
        # Fallback: stable JSON + blake2b to avoid insecure hashes
        import hashlib
        import json
        key_data = {
            "service_name": command.service_name,
            "operation": command.operation_name,
            "parameters": command.parameters,
        }
        key_string = json.dumps(key_data, sort_keys=True, separators=(",", ":"))
        return hashlib.blake2b(key_string.encode(), digest_size=16).hexdigest()

    def _record_success_metrics(self, command: CallExternalServiceCommand, duration: float, result: dict[str, Any]) -> None:
        """Record success metrics."""
        if command.configuration.enable_metrics:
            self._metrics_service.record_call_duration(
                command.service_name,
                command.operation_name,
                duration,
            )
            self._metrics_service.increment_call_count(
                command.service_name,
                command.operation_name,
                "success",
            )

    def _record_failure_metrics(self, command: CallExternalServiceCommand, error: str) -> None:
        """Record failure metrics."""
        if command.configuration.enable_metrics:
            self._metrics_service.increment_call_count(
                command.service_name,
                command.operation_name,
                "failure",
            )
            self._metrics_service.record_error(
                command.service_name,
                command.operation_name,
                "service_error",
            )

    def _publish_failure_event(self, command: CallExternalServiceCommand, error: str, retry_count: int) -> None:
        """Publish failure domain event."""
        self._event_publisher.publish(
            ExternalServiceCallFailed(
                command.correlation_id,
                command.service_name,
                "service_error",
                error,
            ),
        )


class CancelServiceCallCommandHandler(ICommandHandler[CancelServiceCallCommand]):
    """Command handler for cancelling external service calls."""

    def __init__(
        self,
        call_handler: CallExternalServiceCommandHandler,
        event_publisher: DomainEventPublisherProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self._call_handler = call_handler
        self._event_publisher = event_publisher
        self._logger = logger_service

    def handle(self, command: CancelServiceCallCommand) -> Result[None]:
        """Handle service call cancellation command."""
        try:
            # Mark call as cancelled
            if command.correlation_id in self._call_handler._active_calls:
                self._call_handler._active_calls[command.correlation_id] = False
                
                # Publish cancellation event
                # Emit a generic error event to signal cancellation in the central events module
                self._event_publisher.publish(
                    ExternalServiceCallFailed(
                        command.correlation_id,
                        "unknown",
                        "cancelled",
                        command.reason,
                    ),
                )
                
                self._logger.log_info(
                    "Service call cancelled",
                    correlation_id=command.correlation_id,
                    reason=command.reason,
                )
                
                return Result.success(None)
            return Result.failure(f"No active call found with correlation ID {command.correlation_id}")
                
        except Exception as e:
            error_msg = f"Error cancelling service call: {e!s}"
            self._logger.log_error(error_msg, correlation_id=command.correlation_id)
            return Result.failure(error_msg)