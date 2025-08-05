"""Initialize Workers Use Case

This module implements the InitializeWorkersUseCase for initializing application
workers (VAD, Model, LLM) with progress tracking and proper error handling.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from src_refactored.domain.audio.value_objects.model_name import ModelName
from src_refactored.domain.audio.value_objects.quantization_level import QuantizationLevel
from src_refactored.domain.common.progress_callback import ProgressCallback
from src_refactored.domain.common.result import Result
from src_refactored.domain.llm.value_objects.llm_model_name import LLMModelName
from src_refactored.domain.llm.value_objects.llm_quantization_level import LLMQuantizationLevel
from src_refactored.domain.worker_management.value_objects.worker_configuration import (
    WorkerConfiguration,
)
from src_refactored.domain.worker_management.value_objects.worker_operations import (
    InitializationPhase,
    InitializationResult,
    InitializationStrategy,
    WorkerType,
)

# WorkerConfiguration is now imported from domain layer


@dataclass(frozen=True)
class InitializeWorkersRequest:
    """Request for initializing workers"""
    worker_configurations: list[WorkerConfiguration]
    strategy: InitializationStrategy = InitializationStrategy.DEPENDENCY_BASED
    cleanup_existing: bool = True
    validate_dependencies: bool = True
    enable_progress_tracking: bool = True
    progress_callback: ProgressCallback | None = None
    timestamp: datetime = field(default_factory=datetime.utcnow,
    )


@dataclass
class WorkerInitializationStatus:
    """Status of individual worker initialization"""
    worker_type: WorkerType
    result: InitializationResult
    initialized: bool = False
    started: bool = False
    error_message: str | None = None
    initialization_time_ms: int = 0
    worker_id: str | None = None
    thread_id: str | None = None
    memory_usage_mb: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class InitializeWorkersResponse:
    """Response from initialize workers operation"""
    result: InitializationResult
    worker_statuses: list[WorkerInitializationStatus] = field(default_factory=list)
    total_initialization_time_ms: int = 0
    successful_workers: list[WorkerType] = field(default_factory=list)
    failed_workers: list[WorkerType] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list,
    )
    error_message: str | None = None
    cleanup_performed: bool = False
    dependencies_validated: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


class WorkerFactoryProtocol(Protocol):
    """Protocol for creating workers"""

    def create_vad_worker(self) -> Result[Any]:
        """Create VAD worker instance"""
        ...

    def create_model_worker(self, model_name: ModelName, quantization: QuantizationLevel,
    ) -> Result[Any]:
        """Create model worker instance"""
        ...

    def create_llm_worker(self, model_name: LLMModelName, quantization: LLMQuantizationLevel,
    ) -> Result[Any]:
        """Create LLM worker instance"""
        ...

    def create_listener_worker(self) -> Result[Any]:
        """Create listener worker instance"""
        ...

    def create_visualizer_worker(self) -> Result[Any]:
        """Create voice visualizer instance"""
        ...


class ThreadManagementServiceProtocol(Protocol):
    """Protocol for thread management operations"""

    def create_thread(self, thread_name: str,
    ) -> Result[Any]:
        """Create a new thread"""
        ...

    def move_worker_to_thread(self, worker: Any, thread: Any,
    ) -> Result[None]:
        """Move worker to specified thread"""
        ...

    def start_thread(self, thread: Any,
    ) -> Result[None]:
        """Start thread execution"""
        ...

    def stop_thread(self, thread: Any, timeout_ms: int = 5000,
    ) -> Result[None]:
        """Stop thread execution"""
        ...

    def is_thread_running(self, thread: Any,
    ) -> bool:
        """Check if thread is running"""
        ...

    def cleanup_thread(self, thread: Any,
    ) -> Result[None]:
        """Clean up thread resources"""
        ...


class SignalConnectionServiceProtocol(Protocol):
    """Protocol for signal connection management"""

    def connect_worker_signals(self, worker: Any, worker_type: WorkerType,
    ) -> Result[None]:
        """Connect worker signals to appropriate handlers"""
        ...

    def disconnect_worker_signals(self, worker: Any,
    ) -> Result[None]:
        """Disconnect worker signals"""
        ...

    def create_safe_signal_handler(self, handler_func: callable,
    ) -> callable:
        """Create a safe signal handler that catches exceptions"""
        ...


class WorkerCleanupServiceProtocol(Protocol):
    """Protocol for worker cleanup operations"""

    def cleanup_existing_workers(self, worker_types: list[WorkerType]) -> Result[None]:
        """Clean up existing workers before initialization"""
        ...

    def cleanup_worker(self, worker: Any, worker_type: WorkerType,
    ) -> Result[None]:
        """Clean up specific worker"""
        ...

    def force_garbage_collection(self) -> None:
        """Force garbage collection to free memory"""
        ...

    def get_memory_usage(self) -> Result[float]:
        """Get current memory usage in MB"""
        ...


class DependencyValidationServiceProtocol(Protocol):
    """Protocol for dependency validation"""

    def validate_worker_dependencies(self, worker_type: WorkerType, config: WorkerConfiguration,
    ) -> Result[None]:
        """Validate dependencies for worker type"""
        ...

    def get_initialization_order(self, worker_types: list[WorkerType]) -> Result[list[WorkerType]]:
        """Get optimal initialization order based on dependencies"""
        ...

    def check_system_requirements(self, worker_type: WorkerType,
    ) -> Result[None]:
        """Check system requirements for worker type"""
        ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging operations"""

    def log_info(self, message: str, **kwargs) -> None:
        """Log info message"""
        ...

    def log_warning(self, message: str, **kwargs) -> None:
        """Log warning message"""
        ...

    def log_error(self, message: str, **kwargs) -> None:
        """Log error message"""
        ...

    def log_debug(self, message: str, **kwargs) -> None:
        """Log debug message"""
        ...


class InitializeWorkersUseCase:
    """Use case for initializing application workers"""

    def __init__(
        self,
        worker_factory: WorkerFactoryProtocol,
        thread_management_service: ThreadManagementServiceProtocol,
        signal_connection_service: SignalConnectionServiceProtocol,
        worker_cleanup_service: WorkerCleanupServiceProtocol,
        dependency_validation_service: DependencyValidationServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self._worker_factory = worker_factory
        self._thread_management = thread_management_service
        self._signal_connection = signal_connection_service
        self._worker_cleanup = worker_cleanup_service
        self._dependency_validation = dependency_validation_service
        self._logger = logger_service

    def execute(self, request: InitializeWorkersRequest,
    ) -> InitializeWorkersResponse:
        """Execute the initialize workers operation"""
        start_time = datetime.utcnow()
        response = InitializeWorkersResponse(result=InitializationResult.FAILED)

        try:
            self._logger.log_info(
                "Starting worker initialization",
                worker_count=len(request.worker_configurations)
                strategy=request.strategy.value,
                cleanup_existing=request.cleanup_existing,
            )

            # Phase 1: Initialize
            if not self._update_progress(request.progress_callback, InitializationPhase.INITIALIZING, 0):
                response.result = InitializationResult.CANCELLED
                return response

            # Phase 2: Validate configuration and dependencies
            if not self._update_progress(request.progress_callback, InitializationPhase.VALIDATING_CONFIGURATION, 5):
                response.result = InitializationResult.CANCELLED
                return response

            if request.validate_dependencies:
                validation_result = self._validate_all_dependencies(request.worker_configurations,
    )
                if not validation_result.is_success:
response.error_message = (
    f"Dependency validation failed: {validation_result.error_message}")
                    response.result = InitializationResult.DEPENDENCY_FAILED
                    return response
                response.dependencies_validated = True

            # Phase 3: Clean up existing workers
            if not self._update_progress(request.progress_callback, InitializationPhase.CLEANING_UP_EXISTING, 10):
                response.result = InitializationResult.CANCELLED
                return response

            if request.cleanup_existing:
                worker_types = [config.worker_type for config in request.worker_configurations]
                cleanup_result = self._worker_cleanup.cleanup_existing_workers(worker_types)
                if cleanup_result.is_success:
                    response.cleanup_performed = True
                    self._worker_cleanup.force_garbage_collection()
                else:
                    response.warnings.append(f"Cleanup failed: {cleanup_result.error_message}")

            # Determine initialization order
            worker_types = [config.worker_type for config in request.worker_configurations]
            if request.strategy == InitializationStrategy.DEPENDENCY_BASED:
                order_result = self._dependency_validation.get_initialization_order(worker_types)
                if order_result.is_success:
                    initialization_order = order_result.value
                else:
                    initialization_order = worker_types
                    response.warnings.append(f"Could not determine optimal order: {order_result.error_message}",
    )
            else:
                initialization_order = worker_types

            # Initialize workers based on strategy
            if request.strategy == InitializationStrategy.PARALLEL:
                init_result = self._initialize_workers_parallel(request.worker_configurations,
                request.progress_callback)
            else:
                init_result = self._initialize_workers_sequential(
                    request.worker_configurations, initialization_order, request.progress_callback,
                )

            response.worker_statuses = init_result.worker_statuses
            response.successful_workers
             =  [status.worker_type for status in init_result.worker_statuses if status.initialized]
            response.failed_workers
 = (
    [status.worker_type for status in init_result.worker_statuses if not status.initialized])
            response.warnings.extend(init_result.warnings)

            # Phase 11: Verify initialization
            if not self._update_progress(request.progress_callback, InitializationPhase.VERIFYING_INITIALIZATION, 95):
                response.result = InitializationResult.CANCELLED
                return response

            # Determine overall result
            if len(response.failed_workers) == 0:
                response.result = InitializationResult.SUCCESS
            elif len(response.successful_workers) > 0:
                response.result = InitializationResult.PARTIAL_SUCCESS
            else:
                response.result = InitializationResult.FAILED
                response.error_message = "All worker initializations failed"

            # Phase 12: Complete
            if not self._update_progress(request.progress_callback, InitializationPhase.COMPLETED, 100):
                response.result = InitializationResult.CANCELLED
                return response

            # Set final response data
response.total_initialization_time_ms = (
    int((datetime.utcnow() - start_time).total_seconds() * 1000))

            # Add metadata
            response.metadata = {
                "initialization_timestamp": start_time.isoformat()
                "strategy_used": request.strategy.value,
                "total_workers_requested": len(request.worker_configurations)
                "successful_count": len(response.successful_workers)
                "failed_count": len(response.failed_workers)
                "cleanup_performed": response.cleanup_performed,
                "dependencies_validated": response.dependencies_validated,
                "memory_usage_mb": self._get_current_memory_usage()
            }

            self._logger.log_info(
                "Worker initialization completed",
                result=response.result.value,
                successful_workers=[wt.value for wt in response.successful_workers],
                failed_workers=[wt.value for wt in response.failed_workers],
                duration_ms=response.total_initialization_time_ms,
            )

        except Exception as e:
            self._logger.log_error(f"Unexpected error during worker initialization: {e!s}")
            response.error_message = f"Unexpected error: {e!s}"
            response.result = InitializationResult.FAILED

        return response

    def _validate_all_dependencies(self, configurations: list[WorkerConfiguration]) -> Result[None]:
        """Validate dependencies for all worker configurations"""
        try:
            for config in configurations:
                if config.enabled:
validation_result = (
    self._dependency_validation.validate_worker_dependencies(config.worker_type,)
                    config)
                    if not validation_result.is_success:
                        return Result.failure(f"Validation failed for {config.worker_type.value}: {v\
    alidation_result.error_message}")
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Dependency validation error: {e!s}")

    def _initialize_workers_sequential(
        self,
        configurations: list[WorkerConfiguration],
        initialization_order: list[WorkerType],
        progress_callback: ProgressCallback | None,
    ) -> "InitializationResult":
        """Initialize workers sequentially"""
        worker_statuses = []
        warnings = []

        # Create a mapping of worker type to configuration
        config_map = {config.worker_type: config for config in configurations}

        base_progress = 15  # Starting after cleanup
        progress_per_worker = 70 // len(initialization_order)  # 70% for worker init, ending at 85%

        for i, worker_type in enumerate(initialization_order):
            if worker_type not in config_map:
                continue

            config = config_map[worker_type]
            if not config.enabled:
                continue

            current_progress = base_progress + (i * progress_per_worker)

            # Update progress for this worker
            phase_name = f"initializing_{worker_type.value}"
            if not self._update_progress(progress_callback, InitializationPhase(phase_name), current_progress):
                # If cancelled, mark remaining workers as failed
                for remaining_type in initialization_order[i:]:
                    if remaining_type in config_map and config_map[remaining_type].enabled:
                        worker_statuses.append(WorkerInitializationStatus(
                            worker_type=remaining_type,
                            result=InitializationResult.CANCELLED,
                        ))
                break

            # Initialize this worker
            status = self._initialize_single_worker(config)
            worker_statuses.append(status)

            if not status.initialized and not config.cleanup_on_failure:
                warnings.append(f"Worker {worker_type.value} failed but cleanup was skipped")

        return type("InitializationResult", (), {
            "worker_statuses": worker_statuses,
            "warnings": warnings,
        })()

    def _initialize_workers_parallel(
        self,
        configurations: list[WorkerConfiguration],
        progress_callback: ProgressCallback | None,
    ) -> "InitializationResult":
        """Initialize workers in parallel (simplified implementation)"""
        # For this implementation, we'll fall back to sequential
        # A full parallel implementation would use threading or async
        worker_types = [config.worker_type for config in configurations if config.enabled]
        return self._initialize_workers_sequential(configurations, worker_types, progress_callback)

    def _initialize_single_worker(self, config: WorkerConfiguration,
    ) -> WorkerInitializationStatus:
        """Initialize a single worker"""
        start_time = datetime.utcnow()
        status = WorkerInitializationStatus(
            worker_type=config.worker_type,
            result=InitializationResult.FAILED,
        )

        try:
            self._logger.log_debug(f"Initializing {config.worker_type.value} worker")

            # Create worker based on type
            worker_result = self._create_worker_by_type(config)
            if not worker_result.is_success:
                status.error_message = f"Worker creation failed: {worker_result.error_message}"
                return status

            worker = worker_result.value

            # Create and setup thread
thread_result = (
    self._thread_management.create_thread(f"{config.worker_type.value}_thread"))
            if not thread_result.is_success:
                status.error_message = f"Thread creation failed: {thread_result.error_message}"
                return status

            thread = thread_result.value

            # Move worker to thread
            move_result = self._thread_management.move_worker_to_thread(worker, thread)
            if not move_result.is_success:
status.error_message = (
    f"Failed to move worker to thread: {move_result.error_message}")
                return status

            # Connect signals
signal_result = (
    self._signal_connection.connect_worker_signals(worker, config.worker_type))
            if not signal_result.is_success:
                status.error_message = f"Signal connection failed: {signal_result.error_message}"
                return status

            # Start thread if auto_start is enabled
            if config.auto_start:
                start_result = self._thread_management.start_thread(thread)
                if start_result.is_success:
                    status.started = True
                else:
                    status.error_message = f"Thread start failed: {start_result.error_message}"
                    return status

            # Mark as successful
            status.initialized = True
            status.result = InitializationResult.SUCCESS
status.initialization_time_ms = (
    int((datetime.utcnow() - start_time).total_seconds() * 1000))

            # Get memory usage if available
            memory_result = self._worker_cleanup.get_memory_usage(,
    )
            if memory_result.is_success:
                status.memory_usage_mb = memory_result.value

            self._logger.log_debug(
                f"{config.worker_type.value} worker initialized successfully",
                initialization_time_ms=status.initialization_time_ms,
            )

        except Exception as e:
            status.error_message = f"Unexpected error: {e!s}"
            self._logger.log_error(f"Error initializing {config.worker_type.value} worker: {e!s}")

        return status

    def _create_worker_by_type(self, config: WorkerConfiguration,
    ) -> Result[Any]:
        """Create worker based on worker type"""
        try:
            if config.worker_type == WorkerType.VAD:
                return self._worker_factory.create_vad_worker()
            if config.worker_type == WorkerType.MODEL:
                if not config.model_name or not config.quantization_level:
                    return Result.failure("Model name and
    quantization level required for model worker")
                return self._worker_factory.create_model_worker(config.model_name, config.quantization_level)
            if config.worker_type == WorkerType.LLM:
                if not config.llm_model_name or not config.llm_quantization_level:
                    return Result.failure("LLM model name and
    quantization level required for LLM worker")
                return self._worker_factory.create_llm_worker(config.llm_model_name, config.llm_quantization_level)
            if config.worker_type == WorkerType.LISTENER:
                return self._worker_factory.create_listener_worker()
            if config.worker_type == WorkerType.VISUALIZER:
                return self._worker_factory.create_visualizer_worker()
            return Result.failure(f"Unknown worker type: {config.worker_type}")
        except Exception as e:
            return Result.failure(f"Worker creation error: {e!s}")

    def _get_current_memory_usage(self) -> float | None:
        """Get current memory usage"""
        try:
            memory_result = self._worker_cleanup.get_memory_usage(,
    )
            return memory_result.value if memory_result.is_success else None
        except Exception:
            return None

    def _update_progress(self, callback: ProgressCallback | None, phase: InitializationPhase, percentage: int,
    ) -> bool:
        """Update progress and check for cancellation"""
        if callback:
            return callback.update_progress(
                percentage=percentage,
                message=f"Initialization phase: {phase.value}",
                phase=phase.value,
            )
        return True