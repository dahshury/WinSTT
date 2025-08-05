"""Initialize LLM Worker Use Case

This module implements the InitializeLLMWorkerUseCase for initializing
LLM workers with progress tracking and proper error handling.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from src_refactored.domain.common.progress_callback import ProgressCallback
from src_refactored.domain.common.result import Result
from src_refactored.domain.llm.value_objects.llm_model_name import LLMModelName
from src_refactored.domain.llm.value_objects.llm_prompt import LLMPrompt
from src_refactored.domain.llm.value_objects.llm_quantization_level import LLMQuantizationLevel
from src_refactored.domain.worker_management.value_objects.worker_operations import (
    LLMInitializationPhase,
    LLMInitializationResult,
    LLMWorkerStrategy,
)


@dataclass(frozen=True)
class LLMWorkerConfiguration:
    """Configuration for LLM worker initialization"""
    model_name: LLMModelName
    quantization_level: LLMQuantizationLevel
    prompt: LLMPrompt | None = None
    enabled: bool = True
    auto_start: bool = True
    use_gpu: bool = True
    max_memory_mb: int | None = None
    timeout_seconds: int = 60
    retry_count: int = 2
    cleanup_on_failure: bool = True
    preload_model: bool = False
    custom_parameters: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class InitializeLLMWorkerRequest:
    """Request for initializing LLM worker"""
    configuration: LLMWorkerConfiguration
    strategy: LLMWorkerStrategy = LLMWorkerStrategy.STANDARD
    cleanup_existing: bool = True
    validate_dependencies: bool = True
    enable_progress_tracking: bool = True
    progress_callback: ProgressCallback | None = None
    timestamp: datetime = field(default_factory=datetime.utcnow)


@dataclass
class InitializeLLMWorkerResponse:
    """Response from initialize LLM worker operation"""
    result: LLMInitializationResult
    worker_id: str | None = None
    thread_id: str | None = None
    model_loaded: bool = False
    signals_connected: bool = False
    worker_started: bool = False
    initialization_time_ms: int = 0
    model_load_time_ms: int = 0
    memory_usage_mb: float | None = None
    gpu_memory_usage_mb: float | None = None
    warnings: list[str] = field(default_factory=list,
    )
    error_message: str | None = None
    cleanup_performed: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


class LLMWorkerFactoryProtocol(Protocol):
    """Protocol for creating LLM workers"""

    def create_llm_worker(
        self,
        model_name: LLMModelName,
        quantization: LLMQuantizationLevel,
        prompt: LLMPrompt | None = None,
        use_gpu: bool = True,
    ) -> Result[Any]:
        """Create LLM worker instance"""
        ...

    def validate_model_compatibility(
        self,
        model_name: LLMModelName,
        quantization: LLMQuantizationLevel,
    ) -> Result[None]:
        """Validate model and quantization compatibility"""
        ...

    def estimate_memory_requirements(
        self,
        model_name: LLMModelName,
        quantization: LLMQuantizationLevel,
    ) -> Result[int]:
        """Estimate memory requirements in MB"""
        ...


class LLMThreadManagementServiceProtocol(Protocol):
    """Protocol for LLM thread management operations"""

    def create_llm_thread(self, thread_name: str,
    ) -> Result[Any]:
        """Create a new thread for LLM worker"""
        ...

    def move_llm_worker_to_thread(self, worker: Any, thread: Any,
    ) -> Result[None]:
        """Move LLM worker to specified thread"""
        ...

    def start_llm_thread(self, thread: Any,
    ) -> Result[None]:
        """Start LLM thread execution"""
        ...

    def stop_llm_thread(self, thread: Any, timeout_ms: int = 5000,
    ) -> Result[None]:
        """Stop LLM thread execution"""
        ...

    def is_llm_thread_running(self, thread: Any,
    ) -> bool:
        """Check if LLM thread is running"""
        ...


class LLMSignalConnectionServiceProtocol(Protocol):
    """Protocol for LLM signal connection management"""

    def connect_llm_worker_signals(self, worker: Any,
    ) -> Result[None]:
        """Connect LLM worker signals to appropriate handlers"""
        ...

    def disconnect_llm_worker_signals(self, worker: Any,
    ) -> Result[None]:
        """Disconnect LLM worker signals"""
        ...

    def create_safe_llm_signal_handler(self, handler_func: callable,
    ) -> callable:
        """Create a safe LLM signal handler that catches exceptions"""
        ...

    def verify_signal_connections(self, worker: Any,
    ) -> Result[bool]:
        """Verify all required signals are connected"""
        ...


class LLMWorkerCleanupServiceProtocol(Protocol):
    """Protocol for LLM worker cleanup operations"""

    def cleanup_existing_llm_worker(self) -> Result[None]:
        """Clean up existing LLM worker before initialization"""
        ...

    def cleanup_llm_worker(self, worker: Any,
    ) -> Result[None]:
        """Clean up specific LLM worker"""
        ...

    def release_llm_memory(self) -> Result[float]:
        """Release LLM memory and return amount freed"""
        ...

    def get_llm_memory_usage(self) -> Result[float]:
        """Get current LLM memory usage in MB"""
        ...

    def get_gpu_memory_usage(self) -> Result[float]:
        """Get current GPU memory usage in MB"""
        ...


class LLMDependencyValidationServiceProtocol(Protocol):
    """Protocol for LLM dependency validation"""

    def validate_llm_dependencies(self, config: LLMWorkerConfiguration,
    ) -> Result[None]:
        """Validate LLM dependencies and requirements"""
        ...

    def check_gpu_availability(self) -> Result[bool]:
        """Check if GPU is available for LLM processing"""
        ...

    def check_memory_availability(self, required_mb: int,
    ) -> Result[bool]:
        """Check if sufficient memory is available"""
        ...

    def validate_model_files(self, model_name: LLMModelName,
    ) -> Result[None]:
        """Validate that model files are available and accessible"""
        ...


class LLMModelServiceProtocol(Protocol):
    """Protocol for LLM model management"""

    def load_model(
        self,
        model_name: LLMModelName,
        quantization: LLMQuantizationLevel,
        use_gpu: bool = True,
    ) -> Result[Any]:
        """Load LLM model"""
        ...

    def unload_model(self, model: Any,
    ) -> Result[None]:
        """Unload LLM model from memory"""
        ...

    def is_model_loaded(self, model_name: LLMModelName,
    ) -> bool:
        """Check if model is currently loaded"""
        ...

    def get_model_info(self, model_name: LLMModelName,
    ) -> Result[dict[str, Any]]:
        """Get information about the model"""
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


class InitializeLLMWorkerUseCase:
    """Use case for initializing LLM worker"""

    def __init__(
        self,
        llm_worker_factory: LLMWorkerFactoryProtocol,
        thread_management_service: LLMThreadManagementServiceProtocol,
        signal_connection_service: LLMSignalConnectionServiceProtocol,
        worker_cleanup_service: LLMWorkerCleanupServiceProtocol,
        dependency_validation_service: LLMDependencyValidationServiceProtocol,
        model_service: LLMModelServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self._llm_worker_factory = llm_worker_factory
        self._thread_management = thread_management_service
        self._signal_connection = signal_connection_service
        self._worker_cleanup = worker_cleanup_service
        self._dependency_validation = dependency_validation_service
        self._model_service = model_service
        self._logger = logger_service

    def execute(self, request: InitializeLLMWorkerRequest,
    ) -> InitializeLLMWorkerResponse:
        """Execute the initialize LLM worker operation"""
        start_time = datetime.utcnow()
        response = InitializeLLMWorkerResponse(result=LLMInitializationResult.FAILED)

        try:
            self._logger.log_info(
                "Starting LLM worker initialization",
                model_name=request.configuration.model_name.value,
                quantization=request.configuration.quantization_level.value,
                strategy=request.strategy.value,
                cleanup_existing=request.cleanup_existing,
            )

            # Phase 1: Initialize
            if not self._update_progress(request.progress_callback, LLMInitializationPhase.INITIALIZING, 0):
                response.result = LLMInitializationResult.CANCELLED
                return response

            # Phase 2: Validate configuration
            if not self._update_progress(request.progress_callback,
            LLMInitializationPhase.VALIDATING_CONFIGURATION, 5):
                response.result = LLMInitializationResult.CANCELLED
                return response

            config_validation = self._validate_configuration(request.configuration)
            if not config_validation.is_success:
response.error_message = (
    f"Configuration validation failed: {config_validation.error_message}")
                response.result = LLMInitializationResult.CONFIGURATION_ERROR
                return response

            # Phase 3: Check dependencies
            if not self._update_progress(request.progress_callback, LLMInitializationPhase.CHECKING_DEPENDENCIES, 10):
                response.result = LLMInitializationResult.CANCELLED
                return response

            if request.validate_dependencies:
dependency_result = (
    self._dependency_validation.validate_llm_dependencies(request.configuration,)
    )
                if not dependency_result.is_success:
response.error_message = (
    f"Dependency validation failed: {dependency_result.error_message}")
                    response.result = LLMInitializationResult.DEPENDENCY_FAILED
                    return response

            # Phase 4: Clean up existing worker
            if not self._update_progress(request.progress_callback, LLMInitializationPhase.CLEANING_UP_EXISTING, 15):
                response.result = LLMInitializationResult.CANCELLED
                return response

            if request.cleanup_existing:
                cleanup_result = self._worker_cleanup.cleanup_existing_llm_worker()
                if cleanup_result.is_success:
                    response.cleanup_performed = True
                else:
                    response.warnings.append(f"Cleanup failed: {cleanup_result.error_message}")

            # Phase 5: Load model (if preload is enabled)
            model_load_start = datetime.utcnow(,
    )
            if not self._update_progress(request.progress_callback, LLMInitializationPhase.LOADING_MODEL, 25):
                response.result = LLMInitializationResult.CANCELLED
                return response

if request.configuration.preload_model or request.strategy = (
    = LLMWorkerStrategy.PRELOAD_MODEL:)
                model_result = self._model_service.load_model(
                    request.configuration.model_name,
                    request.configuration.quantization_level,
                    request.configuration.use_gpu,
                )
                if model_result.is_success:
                    response.model_loaded = True
response.model_load_time_ms = (
    int((datetime.utcnow() - model_load_start).total_seconds() * 1000))
                else:
                    response.error_message = f"Model loading failed: {model_result.error_message}"
                    response.result = LLMInitializationResult.MODEL_LOAD_FAILED
                    return response

            # Phase 6: Create worker
            if not self._update_progress(request.progress_callback, LLMInitializationPhase.CREATING_WORKER, 40):
                response.result = LLMInitializationResult.CANCELLED
                return response

            worker_result = self._llm_worker_factory.create_llm_worker(
                request.configuration.model_name,
                request.configuration.quantization_level,
                request.configuration.prompt,
                request.configuration.use_gpu,
            )

            if not worker_result.is_success:
                response.error_message = f"Worker creation failed: {worker_result.error_message}"
                response.result = LLMInitializationResult.FAILED
                return response

            worker = worker_result.value
            response.worker_id = getattr(worker, "id", "unknown")

            # Phase 7: Create thread
            if not self._update_progress(request.progress_callback, LLMInitializationPhase.CREATING_THREAD, 55):
                response.result = LLMInitializationResult.CANCELLED
                return response

            thread_result = self._thread_management.create_llm_thread("llm_worker_thread")
            if not thread_result.is_success:
                response.error_message = f"Thread creation failed: {thread_result.error_message}"
                response.result = LLMInitializationResult.THREAD_CREATION_FAILED
                return response

            thread = thread_result.value
            response.thread_id = getattr(thread, "objectName", lambda: "unknown")()

            # Phase 8: Move worker to thread
            if not self._update_progress(request.progress_callback, LLMInitializationPhase.MOVING_TO_THREAD, 65):
                response.result = LLMInitializationResult.CANCELLED
                return response

            move_result = self._thread_management.move_llm_worker_to_thread(worker, thread)
            if not move_result.is_success:
response.error_message = (
    f"Failed to move worker to thread: {move_result.error_message}")
                response.result = LLMInitializationResult.FAILED
                return response

            # Phase 9: Connect signals
            if not self._update_progress(request.progress_callback, LLMInitializationPhase.CONNECTING_SIGNALS, 75):
                response.result = LLMInitializationResult.CANCELLED
                return response

            signal_result = self._signal_connection.connect_llm_worker_signals(worker)
            if signal_result.is_success:
                response.signals_connected = True
            else:
                response.error_message = f"Signal connection failed: {signal_result.error_message}"
                response.result = LLMInitializationResult.SIGNAL_CONNECTION_FAILED
                return response

            # Phase 10: Start worker
            if not self._update_progress(request.progress_callback, LLMInitializationPhase.STARTING_WORKER, 85):
                response.result = LLMInitializationResult.CANCELLED
                return response

            if request.configuration.auto_start:
                start_result = self._thread_management.start_llm_thread(thread)
                if start_result.is_success:
                    response.worker_started = True
                else:
                    response.warnings.append(f"Worker start failed: {start_result.error_message}",
    )

            # Phase 11: Verify initialization
            if not self._update_progress(request.progress_callback,
            LLMInitializationPhase.VERIFYING_INITIALIZATION, 95):
                response.result = LLMInitializationResult.CANCELLED
                return response

            verification_result = self._verify_initialization(worker, thread)
            if not verification_result.is_success:
                response.warnings.append(f"Verification failed: {verification_result.error_message}"\
    )

            # Get memory usage
            memory_result = self._worker_cleanup.get_llm_memory_usage()
            if memory_result.is_success:
                response.memory_usage_mb = memory_result.value

            gpu_memory_result = self._worker_cleanup.get_gpu_memory_usage()
            if gpu_memory_result.is_success:
                response.gpu_memory_usage_mb = gpu_memory_result.value

            # Phase 12: Complete
            if not self._update_progress(request.progress_callback, LLMInitializationPhase.COMPLETED, 100):
                response.result = LLMInitializationResult.CANCELLED
                return response

            # Set success result
            response.result = LLMInitializationResult.SUCCESS
response.initialization_time_ms = (
    int((datetime.utcnow() - start_time).total_seconds() * 1000))

            # Add metadata
            response.metadata = {
                "initialization_timestamp": start_time.isoformat()
                "strategy_used": request.strategy.value,
                "model_name": request.configuration.model_name.value,
                "quantization_level": request.configuration.quantization_level.value,
                "gpu_used": request.configuration.use_gpu,
                "preload_enabled": request.configuration.preload_model,
                "cleanup_performed": response.cleanup_performed,
                "model_loaded": response.model_loaded,
                "signals_connected": response.signals_connected,
                "worker_started": response.worker_started,
                "memory_usage_mb": response.memory_usage_mb,
                "gpu_memory_usage_mb": response.gpu_memory_usage_mb,
            }

            self._logger.log_info(
                "LLM worker initialization completed successfully",
                worker_id=response.worker_id,
                thread_id=response.thread_id,
                duration_ms=response.initialization_time_ms,
                model_load_time_ms=response.model_load_time_ms,
                memory_usage_mb=response.memory_usage_mb,
            )

        except Exception as e:
            self._logger.log_error(f"Unexpected error during LLM worker initialization: {e!s}")
            response.error_message = f"Unexpected error: {e!s}"
            response.result = LLMInitializationResult.FAILED

        return response

    def _validate_configuration(self, config: LLMWorkerConfiguration,
    ) -> Result[None]:
        """Validate LLM worker configuration"""
        try:
            if not config.model_name:
                return Result.failure("Model name is required")

            if not config.quantization_level:
                return Result.failure("Quantization level is required")

            if config.timeout_seconds <= 0:
                return Result.failure("Timeout must be positive")

            if config.retry_count < 0:
                return Result.failure("Retry count cannot be negative")

            if config.max_memory_mb is not None and config.max_memory_mb <= 0:
                return Result.failure("Max memory must be positive")

            # Validate model compatibility
            compatibility_result = self._llm_worker_factory.validate_model_compatibility(
                config.model_name, config.quantization_level,
            )
            if not compatibility_result.is_success:
                return Result.failure(f"Model compatibility check failed: {compatibility_result.erro\
    r_message}")

            # Check memory requirements if specified
            if config.max_memory_mb is not None:
                memory_req_result = self._llm_worker_factory.estimate_memory_requirements(
                    config.model_name, config.quantization_level,
                )
                if memory_req_result.is_success and memory_req_result.value > config.max_memory_mb:
                    return Result.failure(f"Model requires {memory_req_result.value}MB but limit is
    {config.max_memory_mb}MB")

            return Result.success(None)

        except Exception as e:
            return Result.failure(f"Configuration validation error: {e!s}")

    def _verify_initialization(self, worker: Any, thread: Any,
    ) -> Result[None]:
        """Verify that initialization was successful"""
        try:
            # Check if worker is valid
            if worker is None:
                return Result.failure("Worker is None")

            # Check if thread is valid
            if thread is None:
                return Result.failure("Thread is None")

            # Check if thread is running (if auto_start was enabled)
            if hasattr(thread, "isRunning") and callable(thread.isRunning):
                if not thread.isRunning():
                    return Result.failure("Thread is not running")

            # Verify signal connections
            signal_verification = self._signal_connection.verify_signal_connections(worker)
            if not signal_verification.is_success:
                return Result.failure(f"Signal verification failed: {signal_verification.error_messa\
    ge}")

            return Result.success(None)

        except Exception as e:
            return Result.failure(f"Verification error: {e!s}")

    def _update_progress(self,
    callback: ProgressCallback | None, phase: LLMInitializationPhase, percentage: int,
    ) -> bool:
        """Update progress and check for cancellation"""
        if callback:
            return callback.update_progress(
                percentage=percentage,
                message=f"LLM initialization phase: {phase.value}",
                phase=phase.value,
            )
        return True