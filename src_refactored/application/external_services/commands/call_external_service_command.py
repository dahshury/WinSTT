"""Call External Service Command.

This module implements commands for abstracting external service calls
from use cases, following CQRS pattern.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

from src_refactored.domain.common.abstractions import ICommand


class ServiceType(Enum):
    """Types of external services."""
    AUDIO_PROCESSING = "audio_processing"
    MODEL_INFERENCE = "model_inference"
    FILE_SYSTEM = "file_system"
    SYSTEM_INTEGRATION = "system_integration"
    NETWORK = "network"
    DATABASE = "database"
    LOGGING = "logging"
    CONFIGURATION = "configuration"
    VALIDATION = "validation"
    NOTIFICATION = "notification"


class CallPriority(Enum):
    """Priority levels for external service calls."""
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class ServiceCallConfiguration:
    """Configuration for external service calls."""
    timeout_seconds: float = 30.0
    retry_count: int = 3
    retry_delay_seconds: float = 1.0
    enable_circuit_breaker: bool = True
    enable_logging: bool = True
    enable_metrics: bool = True
    enable_caching: bool = False
    cache_ttl_seconds: float = 300.0
    enable_async_execution: bool = False
    priority: CallPriority = CallPriority.NORMAL

    def __post_init__(self):
        """Validate configuration parameters."""
        if self.timeout_seconds <= 0:
            msg = "Timeout must be positive"
            raise ValueError(msg)
        if self.retry_count < 0:
            msg = "Retry count cannot be negative"
            raise ValueError(msg)
        if self.retry_delay_seconds < 0:
            msg = "Retry delay cannot be negative"
            raise ValueError(msg)
        if self.cache_ttl_seconds <= 0:
            msg = "Cache TTL must be positive"
            raise ValueError(msg)


@dataclass
class CallExternalServiceCommand(ICommand[dict[str, Any]]):
    """Command for calling external services.
    
    This command abstracts external service calls from use cases,
    providing consistent error handling, retry logic, and monitoring.
    """
    service_type: ServiceType
    service_name: str
    operation_name: str
    parameters: dict[str, Any]
    configuration: ServiceCallConfiguration = field(default_factory=ServiceCallConfiguration)
    correlation_id: str = ""
    user_context: dict[str, Any] = field(default_factory=dict)
    success_callback: Callable[[dict[str, Any]], None] | None = None
    error_callback: Callable[[str, Exception], None] | None = None
    progress_callback: Callable[[float, str], None] | None = None
    timestamp: datetime = field(default_factory=datetime.utcnow)

    def __post_init__(self):
        """Validate command parameters."""
        if not self.service_name:
            msg = "Service name is required"
            raise ValueError(msg)
        if not self.operation_name:
            msg = "Operation name is required"
            raise ValueError(msg)
        if self.parameters is None:
            msg = "Parameters cannot be None"
            raise ValueError(msg)
        if not self.correlation_id:
            import uuid
            object.__setattr__(self, "correlation_id", str(uuid.uuid4()))


@dataclass
class BatchCallExternalServicesCommand(ICommand[list[dict[str, Any]]]):
    """Command for calling multiple external services in batch.
    
    This command allows efficient batch processing of multiple
    external service calls with coordinated error handling.
    """
    service_calls: list[CallExternalServiceCommand]
    batch_configuration: ServiceCallConfiguration = field(default_factory=ServiceCallConfiguration)
    execute_parallel: bool = True
    fail_fast: bool = False
    max_concurrent_calls: int = 5
    batch_timeout_seconds: float = 120.0
    correlation_id: str = ""
    completion_callback: Callable[[list[dict[str, Any]]], None] | None = None
    error_callback: Callable[[str, Exception], None] | None = None
    progress_callback: Callable[[float, str], None] | None = None
    timestamp: datetime = field(default_factory=datetime.utcnow)

    def __post_init__(self):
        """Validate batch command parameters."""
        if not self.service_calls:
            msg = "At least one service call is required"
            raise ValueError(msg)
        if self.max_concurrent_calls < 1:
            msg = "Max concurrent calls must be positive"
            raise ValueError(msg)
        if self.batch_timeout_seconds <= 0:
            msg = "Batch timeout must be positive"
            raise ValueError(msg)
        if not self.correlation_id:
            import uuid
            object.__setattr__(self, "correlation_id", str(uuid.uuid4()))


@dataclass
class CancelServiceCallCommand(ICommand[None]):
    """Command for canceling an ongoing external service call."""
    correlation_id: str
    service_type: ServiceType
    reason: str = "User requested cancellation"
    force_cancel: bool = False
    timestamp: datetime = field(default_factory=datetime.utcnow)

    def __post_init__(self):
        """Validate cancellation command parameters."""
        if not self.correlation_id:
            msg = "Correlation ID is required"
            raise ValueError(msg)
        if not self.reason:
            msg = "Cancellation reason is required"
            raise ValueError(msg)