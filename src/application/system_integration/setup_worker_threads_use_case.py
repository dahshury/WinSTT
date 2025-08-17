"""Setup Worker Threads Use Case.

This module implements the SetupWorkerThreadsUseCase for initializing and
coordinating worker threads with proper lifecycle management.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from src.domain.common.ports.threading_port import IThreadHandle
from src.domain.system_integration.value_objects.system_operations import (
    SetupPhase,
    SetupResult,
    ThreadPriority,
    ThreadType,
)


class ThreadState(Enum):
    """Thread execution states."""
    CREATED = "created"
    STARTING = "starting"
    RUNNING = "running"
    PAUSED = "paused"
    STOPPING = "stopping"
    STOPPED = "stopped"
    ERROR = "error"


class CoordinationMode(Enum):
    """Thread coordination modes."""
    INDEPENDENT = "independent"
    SEQUENTIAL = "sequential"
    PARALLEL = "parallel"
    PIPELINE = "pipeline"
    PRODUCER_CONSUMER = "producer_consumer"


class MonitoringMode(Enum):
    """Thread monitoring modes."""
    BASIC = "basic"
    DETAILED = "detailed"
    PERFORMANCE = "performance"
    HEALTH_CHECK = "health_check"
    RESOURCE_USAGE = "resource_usage"


@dataclass
class ThreadConfiguration:
    """Configuration for a worker thread."""
    thread_id: str
    thread_type: ThreadType
    thread_name: str
    target_function: Callable
    priority: ThreadPriority = ThreadPriority.NORMAL
    daemon: bool = True
    auto_start: bool = True
    restart_on_failure: bool = False
    max_restart_attempts: int = 3
    startup_timeout: float = 30.0
    shutdown_timeout: float = 10.0
    args: tuple = ()
    kwargs: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if self.kwargs is None:
            self.kwargs = {}


@dataclass
class CoordinationConfiguration:
    """Configuration for thread coordination."""
    coordination_mode: CoordinationMode
    thread_dependencies: dict[str, list[str]] = field(default_factory=dict)
    synchronization_points: list[str] = field(default_factory=list)
    communication_channels: dict[str, str] = field(default_factory=dict)
    shared_resources: list[str] = field(default_factory=list)
    deadlock_detection: bool = True
    timeout_handling: bool = True

    def __post_init__(self,
    ):
        if self.thread_dependencies is None:
            self.thread_dependencies = {}
        if self.synchronization_points is None:
            self.synchronization_points = []
        if self.communication_channels is None:
            self.communication_channels = {}
        if self.shared_resources is None:
            self.shared_resources = []


@dataclass
class LifecycleConfiguration:
    """Configuration for thread lifecycle management."""
    graceful_shutdown: bool = True
    cleanup_on_exit: bool = True
    resource_cleanup: bool = True
    exception_handling: bool = True
    error_recovery: bool = True
    health_monitoring: bool = True
    performance_tracking: bool = False


@dataclass
class MonitoringConfiguration:
    """Configuration for thread monitoring."""
    monitoring_mode: MonitoringMode
    monitoring_interval: float = 1.0
    performance_metrics: bool = False
    resource_tracking: bool = False
    health_checks: bool = True
    alert_thresholds: dict[str, float] = field(default_factory=dict)
    logging_enabled: bool = True

    def __post_init__(self):
        if self.alert_thresholds is None:
            self.alert_thresholds = {}


@dataclass
class SetupWorkerThreadsRequest:
    """Request for worker threads setup."""
    thread_configs: list[ThreadConfiguration]
    coordination_config: CoordinationConfiguration
    lifecycle_config: LifecycleConfiguration
    monitoring_config: MonitoringConfiguration
    enable_logging: bool = True
    enable_progress_tracking: bool = True
    setup_timeout: float = 60.0


@dataclass
class ThreadSetupResult:
    """Result of individual thread setup."""
    thread_id: str
    thread_created: bool
    thread_started: bool
    thread_object: IThreadHandle | None = None
    current_state: ThreadState = ThreadState.CREATED
    error_message: str | None = None
    setup_time: float = 0.0


@dataclass
class CoordinationSetup:
    """Result of coordination setup."""
    coordination_established: bool
    dependencies_resolved: int
    sync_points_created: int
    channels_established: int
    shared_resources_configured: int
    deadlock_detection_enabled: bool


@dataclass
class LifecycleSetup:
    """Result of lifecycle management setup."""
    shutdown_handlers_installed: bool
    cleanup_handlers_installed: bool
    exception_handlers_installed: bool
    health_monitoring_enabled: bool
    recovery_mechanisms_enabled: bool


@dataclass
class MonitoringSetup:
    """Result of monitoring setup."""
    monitoring_enabled: bool
    metrics_collection_enabled: bool
    health_checks_enabled: bool
    alert_system_enabled: bool
    logging_configured: bool
    monitoring_thread_created: bool


@dataclass
class WorkerThreadsState:
    """Current state of worker threads setup."""
    current_phase: SetupPhase
    thread_results: list[ThreadSetupResult] = field(default_factory=list)
    coordination_setup: CoordinationSetup | None = None
    lifecycle_setup: LifecycleSetup | None = None
    monitoring_setup: MonitoringSetup | None = None
    active_threads: int = 0
    failed_threads: int = 0
    error_message: str | None = None

    def __post_init__(self,
    ):
        if self.thread_results is None:
            self.thread_results = []


@dataclass
class SetupWorkerThreadsResponse:
    """Response from worker threads setup."""
    result: SetupResult
    state: WorkerThreadsState
    thread_manager: Any | None = None
    coordinator: Any | None = None
    monitor: Any | None = None
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)
    execution_time: float = 0.0
    phase_times: dict[SetupPhase, float] = field(default_factory=dict)

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []
        if self.phase_times is None:
            self.phase_times = {}


class ThreadValidationServiceProtocol(Protocol):
    """Protocol for thread validation service."""

    def validate_thread_configuration(self, config: ThreadConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate thread configuration."""
        ...

    def validate_coordination_configuration(self, config: CoordinationConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate coordination configuration."""
        ...

    def validate_dependencies(self,
    configs: list[ThreadConfiguration], coord_config: CoordinationConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate thread dependencies."""
        ...

    def check_resource_availability(self) -> tuple[bool, str | None]:
        """Check system resource availability."""
        ...


class ThreadCreationServiceProtocol(Protocol):
    """Protocol for thread creation service."""

    def create_thread(self, config: ThreadConfiguration,
    ) -> tuple[bool, IThreadHandle | None, str | None]:
        """Create a worker thread."""
        ...

    def start_thread(self, thread: IThreadHandle, timeout: float,
    ) -> tuple[bool, str | None]:
        """Start a thread with timeout."""
        ...

    def configure_thread_priority(self, thread: IThreadHandle, priority: ThreadPriority,
    ) -> tuple[bool, str | None]:
        """Configure thread priority."""
        ...


class CoordinationServiceProtocol(Protocol):
    """Protocol for thread coordination service."""

    def setup_coordination(self,
    config: CoordinationConfiguration, threads: list[IThreadHandle]) -> tuple[bool, Any, str | None]:
        """Setup thread coordination."""
        ...

    def establish_dependencies(self,
    dependencies: dict[str, list[str]], threads: dict[str, IThreadHandle]) -> tuple[bool, int, str | None]:
        """Establish thread dependencies."""
        ...

    def create_synchronization_points(self, sync_points: list[str]) -> tuple[bool, int, str | None]:
        """Create synchronization points."""
        ...

    def setup_communication_channels(
    self,
    channels: dict[str,
    str]) -> tuple[bool, int, str | None]:
        """Setup communication channels."""
        ...


class LifecycleManagementServiceProtocol(Protocol):
    """Protocol for thread lifecycle management service."""

    def setup_lifecycle_management(self,
    config: LifecycleConfiguration, threads: list[IThreadHandle]) -> tuple[bool, Any, str | None]:
        """Setup lifecycle management."""
        ...

    def install_shutdown_handlers(self, threads: list[IThreadHandle]) -> tuple[bool, str | None]:
        """Install shutdown handlers."""
        ...

    def install_cleanup_handlers(self, threads: list[IThreadHandle]) -> tuple[bool, str | None]:
        """Install cleanup handlers."""
        ...

    def setup_exception_handling(self, threads: list[IThreadHandle]) -> tuple[bool, str | None]:
        """Setup exception handling."""
        ...


class MonitoringServiceProtocol(Protocol):
    """Protocol for thread monitoring service."""

    def setup_monitoring(
    self,
    config: MonitoringConfiguration,
    threads: list[IThreadHandle]) -> tuple[bool, Any, str | None]:
        """Setup thread monitoring."""
        ...

    def enable_health_checks(self, threads: list[IThreadHandle]) -> tuple[bool, str | None]:
        """Enable health checks for threads."""
        ...

    def setup_performance_tracking(self, threads: list[IThreadHandle]) -> tuple[bool, str | None]:
        """Setup performance tracking."""
        ...

    def configure_alerts(self, thresholds: dict[str, float]) -> tuple[bool, str | None]:
        """Configure alert thresholds."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking service."""

    def start_progress(self, total_phases: int,
    ) -> None:
        """Start progress tracking."""
        ...

    def update_progress(self, phase: SetupPhase, progress: float,
    ) -> None:
        """Update progress for current phase."""
        ...

    def complete_progress(self) -> None:
        """Complete progress tracking."""
        ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging service."""

    def log_info(self, message: str, **kwargs) -> None:
        """Log info message."""
        ...

    def log_warning(self, message: str, **kwargs) -> None:
        """Log warning message."""
        ...

    def log_error(self, message: str, **kwargs) -> None:
        """Log error message."""
        ...


class SetupWorkerThreadsUseCase:
    """Use case for setting up worker threads with coordination."""

    def __init__(
        self,
        thread_validation_service: ThreadValidationServiceProtocol,
        thread_creation_service: ThreadCreationServiceProtocol,
        coordination_service: CoordinationServiceProtocol,
        lifecycle_management_service: LifecycleManagementServiceProtocol,
        monitoring_service: MonitoringServiceProtocol,
        progress_tracking_service: ProgressTrackingServiceProtocol | None = None,
        logger_service: LoggerServiceProtocol | None = None,
    ):
        self._thread_validation_service = thread_validation_service
        self._thread_creation_service = thread_creation_service
        self._coordination_service = coordination_service
        self._lifecycle_management_service = lifecycle_management_service
        self._monitoring_service = monitoring_service
        self._progress_tracking_service = progress_tracking_service
        self._logger_service = logger_service

    def execute(self, request: SetupWorkerThreadsRequest,
    ) -> SetupWorkerThreadsResponse:
        """Execute worker threads setup."""
        start_time = time.time()
        phase_times = {}

        state = WorkerThreadsState(current_phase=SetupPhase.INITIALIZATION)
        warnings = []
        created_threads = []
        thread_map = {}

        try:
            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.start_progress(len(SetupPhase))

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "Starting worker threads setup",
                    thread_count=len(request.thread_configs),
                )

            # Phase 1: Validation
            phase_start = time.time()
            state.current_phase = SetupPhase.VALIDATION

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(SetupPhase.VALIDATION, 0.0)

            # Check resource availability
            resources_available, resource_error = self._thread_validation_service.check_resource_availability()
            if not resources_available:
                state.error_message = f"Insufficient resources: {resource_error}"
                return SetupWorkerThreadsResponse(
                    result=SetupResult.VALIDATION_ERROR,
                    state=state,
                    error_message=state.error_message,
                    execution_time=time.time() - start_time,
                )

            # Validate thread configurations
            for config in request.thread_configs:
                config_valid, config_error = (
                    self._thread_validation_service.validate_thread_configuration(config))
                if not config_valid:
                    state.error_message = (
                        f"Invalid thread configuration for {config.thread_id}: {config_error}")
                    return SetupWorkerThreadsResponse(
                        result=SetupResult.VALIDATION_ERROR,
                        state=state,
                        error_message=state.error_message,
                        execution_time=time.time() - start_time,
                    )

            # Validate coordination configuration
            coord_valid, coord_error = (
                self._thread_validation_service.validate_coordination_configuration(request.coordination_config))
            if not coord_valid:
                state.error_message = f"Invalid coordination configuration: {coord_error}"
                return SetupWorkerThreadsResponse(
                    result=SetupResult.VALIDATION_ERROR,
                    state=state,
                    error_message=state.error_message,
                    execution_time=time.time() - start_time,
                )

            # Validate dependencies
            deps_valid, deps_error = self._thread_validation_service.validate_dependencies(
                request.thread_configs, request.coordination_config,
            )
            if not deps_valid:
                state.error_message = f"Invalid thread dependencies: {deps_error}"
                return SetupWorkerThreadsResponse(
                    result=SetupResult.VALIDATION_ERROR,
                    state=state,
                    error_message=state.error_message,
                    execution_time=time.time() - start_time,
                )

            phase_times[SetupPhase.VALIDATION] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(SetupPhase.VALIDATION, 1.0)

            # Phase 2: Thread Creation
            phase_start = time.time()
            state.current_phase = SetupPhase.THREAD_CREATION

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(SetupPhase.THREAD_CREATION, 0.0)

            for i, config in enumerate(request.thread_configs):
                thread_start_time = time.time()

                # Create thread
                thread_created, thread_obj, thread_error = (
                    self._thread_creation_service.create_thread(config))

                result = ThreadSetupResult(
                    thread_id=config.thread_id,
                    thread_created=thread_created,
                    thread_started=False,
                    thread_object=thread_obj,
                    current_state=ThreadState.CREATED if thread_created else ThreadState.ERROR,
                    error_message=thread_error,
                    setup_time=time.time() - thread_start_time,
                )

                if thread_created and thread_obj:
                    created_threads.append(thread_obj)
                    thread_map[config.thread_id] = thread_obj

                    # Configure thread priority
                    priority_set, priority_error = (
                        self._thread_creation_service.configure_thread_priority(thread_obj, config.priority))
                    if not priority_set and priority_error:
                        warnings.append(f"Failed to set priority for {config.thread_id}: {priority_error}")

                    # Start thread if auto_start is enabled
                    if config.auto_start:
                        thread_started, start_error = self._thread_creation_service.start_thread(
                            thread_obj, config.startup_timeout,
                        )
                        result.thread_started = thread_started
                        result.current_state = (
                            ThreadState.RUNNING if thread_started else ThreadState.ERROR)

                        if not thread_started:
                            result.error_message = start_error
                            state.failed_threads += 1
                        else:
                            state.active_threads += 1
                else:
                    state.failed_threads += 1

                state.thread_results.append(result)

                if request.enable_progress_tracking and self._progress_tracking_service:
                    progress = (i + 1) / len(request.thread_configs)
                    self._progress_tracking_service.update_progress(SetupPhase.THREAD_CREATION, progress)

            # Check if any threads were created successfully
            if not created_threads:
                state.error_message = "Failed to create any worker threads"
                return SetupWorkerThreadsResponse(
                    result=SetupResult.THREAD_ERROR,
                    state=state,
                    error_message=state.error_message,
                    warnings=warnings,
                    execution_time=time.time() - start_time,
                    phase_times=phase_times,
                )

            phase_times[SetupPhase.THREAD_CREATION] = time.time() - phase_start

            # Phase 3: Coordination Setup
            phase_start = time.time()
            state.current_phase = SetupPhase.COORDINATION_SETUP

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(SetupPhase.COORDINATION_SETUP, 0.0)

            coord_setup, coordinator, coord_error = self._coordination_service.setup_coordination(
                request.coordination_config, created_threads,
            )

            if not coord_setup:
                warnings.append(f"Failed to setup coordination: {coord_error}")

            # Establish dependencies
            deps_established, deps_count, deps_error = (
                self._coordination_service.establish_dependencies(request.coordination_config.thread_dependencies, thread_map))
            if not deps_established:
                warnings.append(f"Failed to establish dependencies: {deps_error}")

            # Create synchronization points
            sync_created, sync_count, sync_error = (
                self._coordination_service.create_synchronization_points(request.coordination_config.synchronization_points))
            if not sync_created:
                warnings.append(f"Failed to create synchronization points: {sync_error}")

            # Setup communication channels
            channels_setup, channels_count, channels_error = (
                self._coordination_service.setup_communication_channels(request.coordination_config.communication_channels))
            if not channels_setup:
                warnings.append(f"Failed to setup communication channels: {channels_error}")

            state.coordination_setup = CoordinationSetup(
                coordination_established=coord_setup,
                dependencies_resolved=deps_count,
                sync_points_created=sync_count,
                channels_established=channels_count,
                shared_resources_configured=len(request.coordination_config.shared_resources),
                deadlock_detection_enabled=request.coordination_config.deadlock_detection,
            )

            phase_times[SetupPhase.COORDINATION_SETUP] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(SetupPhase.COORDINATION_SETUP, 1.0)

            # Phase 4: Lifecycle Management
            phase_start = time.time()
            state.current_phase = SetupPhase.LIFECYCLE_MANAGEMENT

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(SetupPhase.LIFECYCLE_MANAGEMENT, 0.0)

            lifecycle_setup, lifecycle_manager, lifecycle_error = self._lifecycle_management_service.setup_lifecycle_management(
                request.lifecycle_config, created_threads,
            )

            if not lifecycle_setup:
                warnings.append(f"Failed to setup lifecycle management: {lifecycle_error}")

            # Install shutdown handlers
            shutdown_installed, shutdown_error = (
                self._lifecycle_management_service.install_shutdown_handlers(created_threads))
            if not shutdown_installed:
                warnings.append(f"Failed to install shutdown handlers: {shutdown_error}")

            # Install cleanup handlers
            cleanup_installed, cleanup_error = (
                self._lifecycle_management_service.install_cleanup_handlers(created_threads))
            if not cleanup_installed:
                warnings.append(f"Failed to install cleanup handlers: {cleanup_error}")

            # Setup exception handling
            exception_setup, exception_error = (
                self._lifecycle_management_service.setup_exception_handling(created_threads))
            if not exception_setup:
                warnings.append(f"Failed to setup exception handling: {exception_error}")

            state.lifecycle_setup = LifecycleSetup(
                shutdown_handlers_installed=shutdown_installed,
                cleanup_handlers_installed=cleanup_installed,
                exception_handlers_installed=exception_setup,
                health_monitoring_enabled=request.lifecycle_config.health_monitoring,
                recovery_mechanisms_enabled=request.lifecycle_config.error_recovery,
            )

            phase_times[SetupPhase.LIFECYCLE_MANAGEMENT] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(SetupPhase.LIFECYCLE_MANAGEMENT, 1.0)

            # Phase 5: Monitoring Setup
            phase_start = time.time()
            state.current_phase = SetupPhase.MONITORING_SETUP

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(SetupPhase.MONITORING_SETUP, 0.0)

            monitoring_setup, monitor, monitoring_error = self._monitoring_service.setup_monitoring(
                request.monitoring_config, created_threads,
            )

            if not monitoring_setup:
                warnings.append(f"Failed to setup monitoring: {monitoring_error}")

            # Enable health checks
            health_enabled, health_error = (
                self._monitoring_service.enable_health_checks(created_threads))
            if not health_enabled:
                warnings.append(f"Failed to enable health checks: {health_error}")

            # Setup performance tracking
            perf_setup, perf_error = (
                self._monitoring_service.setup_performance_tracking(created_threads))
            if not perf_setup and request.monitoring_config.performance_metrics:
                warnings.append(f"Failed to setup performance tracking: {perf_error}")

            # Configure alerts
            alerts_configured, alerts_error = self._monitoring_service.configure_alerts(
                request.monitoring_config.alert_thresholds,
            )
            if not alerts_configured:
                warnings.append(f"Failed to configure alerts: {alerts_error}")

            state.monitoring_setup = MonitoringSetup(
                monitoring_enabled=monitoring_setup,
                metrics_collection_enabled=request.monitoring_config.performance_metrics,
                health_checks_enabled=health_enabled,
                alert_system_enabled=alerts_configured,
                logging_configured=request.monitoring_config.logging_enabled,
                monitoring_thread_created=monitoring_setup,
            )

            phase_times[SetupPhase.MONITORING_SETUP] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(SetupPhase.MONITORING_SETUP, 1.0)

            # Phase 6: Finalization
            phase_start = time.time()
            state.current_phase = SetupPhase.FINALIZATION

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(SetupPhase.FINALIZATION, 0.0)
                self._progress_tracking_service.complete_progress()

            phase_times[SetupPhase.FINALIZATION] = time.time() - phase_start

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "Worker threads setup completed",
                    active_threads=state.active_threads,
                    failed_threads=state.failed_threads,
                    warnings_count=len(warnings),
                    execution_time=time.time() - start_time,
                )

            # Determine result
            if state.failed_threads == 0:
                final_result = SetupResult.SUCCESS if not warnings else SetupResult.PARTIAL_SUCCESS
            elif state.active_threads > 0:
                final_result = SetupResult.PARTIAL_SUCCESS
            else:
                final_result = SetupResult.FAILED

            return SetupWorkerThreadsResponse(
                result=final_result,
                state=state,
                thread_manager=lifecycle_manager if lifecycle_setup else None,
                coordinator=coordinator if coord_setup else None,
                monitor=monitor if monitoring_setup else None,
                warnings=warnings,
                execution_time=time.time() - start_time,
                phase_times=phase_times,
            )

        except Exception as e:
            error_message = f"Unexpected error during worker threads setup: {e!s}"
            state.error_message = error_message

            if request.enable_logging and self._logger_service:
                self._logger_service.log_error(
                    "Worker threads setup failed",
                    error=str(e),
                    phase=state.current_phase.value,
                    execution_time=time.time() - start_time,
                )

            return SetupWorkerThreadsResponse(
                result=SetupResult.FAILED,
                state=state,
                error_message=error_message,
                warnings=warnings,
                execution_time=time.time() - start_time,
                phase_times=phase_times,
            )