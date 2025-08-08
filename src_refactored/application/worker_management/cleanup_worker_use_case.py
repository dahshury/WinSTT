"""Cleanup Worker Use Case

This module implements the CleanupWorkerUseCase for safely cleaning up
application workers with proper resource management and error handling.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from src_refactored.domain.common.progress_callback import (
    ProgressCallback,
)
from src_refactored.domain.common.result import Result
from src_refactored.domain.common.value_object import (
    ProgressPercentage,
)
from src_refactored.domain.worker_management.entities.thread_instance import ThreadInstance
from src_refactored.domain.worker_management.entities.worker_instance import WorkerInstance
from src_refactored.domain.worker_management.value_objects.worker_operations import (
    CleanupPhase,
    CleanupResult,
    CleanupStrategy,
    WorkerType,
)


@dataclass(frozen=True)
class WorkerCleanupConfiguration:
    """Configuration for worker cleanup"""
    worker_type: WorkerType
    cleanup_enabled: bool = True
    graceful_timeout_ms: int = 5000
    force_timeout_ms: int = 2000
    disconnect_signals: bool = True
    cleanup_resources: bool = True
    wait_for_completion: bool = True
    force_garbage_collection: bool = True
    verify_cleanup: bool = True
    custom_cleanup_steps: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class CleanupWorkerRequest:
    """Request for cleaning up workers"""
    worker_configurations: list[WorkerCleanupConfiguration]
    strategy: CleanupStrategy = CleanupStrategy.TIMEOUT_THEN_FORCE
    cleanup_all_if_empty: bool = True
    enable_progress_tracking: bool = True
    progress_callback: ProgressCallback | None = None
    max_total_cleanup_time_ms: int = 30000
    timestamp: datetime = field(default_factory=datetime.utcnow,
    )


@dataclass
class WorkerCleanupStatus:
    """Status of individual worker cleanup"""
    worker_type: WorkerType
    result: CleanupResult
    signals_disconnected: bool = False
    worker_stopped: bool = False
    thread_stopped: bool = False
    resources_cleaned: bool = False
    cleanup_time_ms: int = 0
    error_message: str | None = None
    force_cleanup_used: bool = False
    memory_freed_mb: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class CleanupWorkersResult:
    """Result from cleaning up multiple workers"""
    worker_statuses: list[WorkerCleanupStatus] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass
class CleanupWorkerResponse:
    """Response from cleanup worker operation"""
    result: CleanupResult
    worker_statuses: list[WorkerCleanupStatus] = field(default_factory=list)
    total_cleanup_time_ms: int = 0
    successful_cleanups: list[WorkerType] = field(default_factory=list)
    failed_cleanups: list[WorkerType] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list,
    )
    error_message: str | None = None
    memory_freed_mb: float = 0.0
    garbage_collection_performed: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


class WorkerRegistryProtocol(Protocol):
    """Protocol for worker registry operations"""

    def get_active_workers(self, worker_type: WorkerType | None = None) -> Result[list[WorkerInstance]]:
        """Get list of active workers"""
        ...

    def get_worker_by_type(self, worker_type: WorkerType,
    ) -> Result[WorkerInstance | None]:
        """Get worker instance by type"""
        ...

    def get_worker_thread(self, worker: WorkerInstance,
    ) -> Result[ThreadInstance | None]:
        """Get thread associated with worker"""
        ...

    def remove_worker(self, worker: WorkerInstance, worker_type: WorkerType,
    ) -> Result[None]:
        """Remove worker from registry"""
        ...

    def is_worker_active(self, worker: WorkerInstance,
    ) -> bool:
        """Check if worker is active"""
        ...


class ThreadManagementServiceProtocol(Protocol):
    """Protocol for thread management operations"""

    def stop_thread(self, thread: Any, timeout_ms: int = 5000,
    ) -> Result[None]:
        """Stop thread execution gracefully"""
        ...

    def force_stop_thread(self, thread: Any, timeout_ms: int = 2000,
    ) -> Result[None]:
        """Force stop thread execution"""
        ...

    def wait_for_thread(self, thread: Any, timeout_ms: int = 5000,
    ) -> Result[bool]:
        """Wait for thread to finish"""
        ...

    def is_thread_running(self, thread: Any,
    ) -> bool:
        """Check if thread is running"""
        ...

    def cleanup_thread(self, thread: Any,
    ) -> Result[None]:
        """Clean up thread resources"""
        ...

    def get_thread_info(self, thread: Any,
    ) -> Result[dict[str, Any]]:
        """Get thread information"""
        ...


class SignalManagementServiceProtocol(Protocol):
    """Protocol for signal management operations"""

    def disconnect_worker_signals(self, worker: WorkerInstance,
    ) -> Result[None]:
        """Disconnect all signals from worker"""
        ...

    def disconnect_specific_signals(self, worker: WorkerInstance, signal_names: list[str]) -> Result[None]:
        """Disconnect specific signals from worker"""
        ...

    def get_connected_signals(self, worker: WorkerInstance,
    ) -> Result[list[str]]:
        """Get list of connected signals for worker"""
        ...

    def verify_signals_disconnected(self, worker: WorkerInstance,
    ) -> Result[bool]:
        """Verify all signals are disconnected"""
        ...


class ResourceManagementServiceProtocol(Protocol):
    """Protocol for resource management operations"""

    def cleanup_worker_resources(self, worker: WorkerInstance, worker_type: WorkerType,
    ) -> Result[None]:
        """Clean up worker-specific resources"""
        ...

    def force_garbage_collection(self) -> Result[float]:
        """Force garbage collection and return memory freed"""
        ...

    def get_memory_usage(self) -> Result[float]:
        """Get current memory usage in MB"""
        ...

    def cleanup_temporary_files(self, worker_type: WorkerType,
    ) -> Result[None]:
        """Clean up temporary files created by worker"""
        ...

    def release_gpu_memory(self, worker_type: WorkerType,
    ) -> Result[None]:
        """Release GPU memory used by worker"""
        ...


class WorkerControlServiceProtocol(Protocol):
    """Protocol for worker control operations"""

    def stop_worker(self, worker: WorkerInstance, timeout_ms: int = 5000,
    ) -> Result[None]:
        """Stop worker gracefully"""
        ...

    def force_stop_worker(self, worker: WorkerInstance, timeout_ms: int = 2000,
    ) -> Result[None]:
        """Force stop worker"""
        ...

    def is_worker_running(self, worker: WorkerInstance,
    ) -> bool:
        """Check if worker is running"""
        ...

    def get_worker_status(self, worker: WorkerInstance,
    ) -> Result[dict[str, Any]]:
        """Get worker status information"""
        ...

    def send_shutdown_signal(self, worker: WorkerInstance,
    ) -> Result[None]:
        """Send shutdown signal to worker"""
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


class CleanupWorkerUseCase:
    """Use case for cleaning up application workers"""

    def __init__(
        self,
        worker_registry: WorkerRegistryProtocol,
        thread_management_service: ThreadManagementServiceProtocol,
        signal_management_service: SignalManagementServiceProtocol,
        resource_management_service: ResourceManagementServiceProtocol,
        worker_control_service: WorkerControlServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self._worker_registry = worker_registry
        self._thread_management = thread_management_service
        self._signal_management = signal_management_service
        self._resource_management = resource_management_service
        self._worker_control = worker_control_service
        self._logger = logger_service

    def execute(self, request: CleanupWorkerRequest,
    ) -> CleanupWorkerResponse:
        """Execute the cleanup worker operation"""
        start_time = datetime.now(UTC)
        initial_memory = self._get_current_memory_usage()
        response = CleanupWorkerResponse(result=CleanupResult.FAILED)

        try:
            self._logger.log_info(
                "Starting worker cleanup",
                worker_count=len(request.worker_configurations),
                strategy=request.strategy.value,
                cleanup_all=request.cleanup_all_if_empty,
            )

            # Phase 1: Initialize
            if not self._update_progress(request.progress_callback, CleanupPhase.INITIALIZING, 0):
                response.result = CleanupResult.CANCELLED
                return response

            # Phase 2: Identify workers to clean up
            if not self._update_progress(request.progress_callback, CleanupPhase.IDENTIFYING_WORKERS, 5):
                response.result = CleanupResult.CANCELLED
                return response

            # Get workers to clean up
            workers_to_cleanup = self._identify_workers_to_cleanup(request.worker_configurations,
            request.cleanup_all_if_empty)
            if not workers_to_cleanup:
                response.result = CleanupResult.SUCCESS
                response.total_cleanup_time_ms = int((datetime.now(UTC) - start_time).total_seconds() * 1000)
                self._logger.log_info("No workers found to cleanup")
                return response

            # Phase 3-10: Clean up workers
            cleanup_result = self._cleanup_workers_by_strategy(
                workers_to_cleanup, request.strategy, request.progress_callback,
            )

            response.worker_statuses = cleanup_result.worker_statuses
            response.successful_cleanups = (
                [status.worker_type for status in cleanup_result.worker_statuses if status.result == CleanupResult.SUCCESS])
            response.failed_cleanups = (
                [status.worker_type for status in cleanup_result.worker_statuses if status.result != CleanupResult.SUCCESS])
            response.warnings.extend(cleanup_result.warnings)

            # Phase 11: Verify cleanup
            if not self._update_progress(request.progress_callback, CleanupPhase.VERIFYING_CLEANUP, 95):
                response.result = CleanupResult.CANCELLED
                return response

            # Verify cleanup was successful
            verification_result = self._verify_cleanup_completion(response.worker_statuses)
            if not verification_result.is_success:
                response.warnings.append(f"Cleanup verification failed: {verification_result.get_error()}")

            # Determine overall result
            if len(response.failed_cleanups) == 0:
                response.result = CleanupResult.SUCCESS
            elif len(response.successful_cleanups) > 0:
                response.result = CleanupResult.PARTIAL_SUCCESS
            else:
                response.result = CleanupResult.FAILED
                response.error_message = "All worker cleanups failed"

            # Phase 12: Complete
            if not self._update_progress(request.progress_callback, CleanupPhase.COMPLETED, 100):
                response.result = CleanupResult.CANCELLED
                return response

            # Calculate final metrics
            response.total_cleanup_time_ms = (
                int((datetime.now(UTC) - start_time).total_seconds() * 1000))
            final_memory = self._get_current_memory_usage()
            if initial_memory is not None and final_memory is not None:
                response.memory_freed_mb = max(0, initial_memory - final_memory)

            # Add metadata
            response.metadata = {
                "cleanup_timestamp": start_time.isoformat(),
                "strategy_used": request.strategy.value,
                "total_workers_cleaned": len(response.worker_statuses),
                "successful_count": len(response.successful_cleanups),
                "failed_count": len(response.failed_cleanups),
                "initial_memory_mb": initial_memory,
                "final_memory_mb": final_memory,
                "memory_freed_mb": response.memory_freed_mb,
                "garbage_collection_performed": response.garbage_collection_performed,
            }

            self._logger.log_info(
                "Worker cleanup completed",
                result=response.result.value,
                successful_cleanups=[wt.value for wt in response.successful_cleanups],
                failed_cleanups=[wt.value for wt in response.failed_cleanups],
                duration_ms=response.total_cleanup_time_ms,
                memory_freed_mb=response.memory_freed_mb,
            )

        except Exception as e:
            self._logger.log_error(f"Unexpected error during worker cleanup: {e!s}")
            response.error_message = f"Unexpected error: {e!s}"
            response.result = CleanupResult.FAILED

        return response

    def _identify_workers_to_cleanup(
        self,
        configurations: list[WorkerCleanupConfiguration],
        cleanup_all_if_empty: bool,
    ) -> list[tuple[WorkerInstance, WorkerCleanupConfiguration]]:
        """Identify workers that need to be cleaned up"""
        workers_to_cleanup = []

        try:
            if not configurations and cleanup_all_if_empty:
                # Get all active workers
                active_workers_result = self._worker_registry.get_active_workers()
                if active_workers_result.is_success and active_workers_result.value is not None:
                    for worker in active_workers_result.value:
                        # Create default configuration for each worker
                        default_config = WorkerCleanupConfiguration(worker_type=WorkerType.ALL)
                        workers_to_cleanup.append((worker, default_config))
            else:
                # Get specific workers based on configurations
                for config in configurations:
                    if config.cleanup_enabled:
                        if config.worker_type == WorkerType.ALL:
                            active_workers_result = self._worker_registry.get_active_workers(
                            )
                            if active_workers_result.is_success and active_workers_result.value is not None:
                                for worker in active_workers_result.value:
                                    workers_to_cleanup.append((worker, config))
                        else:
                            worker_result = (
                                self._worker_registry.get_worker_by_type(config.worker_type)
                            )
                            if worker_result.is_success and worker_result.value is not None:
                                workers_to_cleanup.append((worker_result.value, config))

        except Exception as e:
            self._logger.log_error(f"Error identifying workers to cleanup: {e!s}")

        return workers_to_cleanup

    def _cleanup_workers_by_strategy(
        self,
        workers_to_cleanup: list[tuple[WorkerInstance, WorkerCleanupConfiguration]],
        strategy: CleanupStrategy,
        progress_callback: ProgressCallback | None,
    ) -> "CleanupWorkersResult":
        """Clean up workers based on strategy"""
        worker_statuses = []
        warnings = []

        base_progress = 10  # Starting after identification
        progress_per_worker = (
            80 // max(1, len(workers_to_cleanup))  # 80% for cleanup, ending at 90%)
        )

        for i, (worker, config) in enumerate(workers_to_cleanup):
            current_progress = base_progress + (i * progress_per_worker)

            # Update progress for this worker
            if not self._update_progress(progress_callback, CleanupPhase.STOPPING_WORKERS, current_progress):
                # If cancelled, mark remaining workers as cancelled
                for j in range(i, len(workers_to_cleanup)):
                    remaining_worker, remaining_config = workers_to_cleanup[j]
                    worker_statuses.append(WorkerCleanupStatus(
                        worker_type=remaining_config.worker_type,
                        result=CleanupResult.CANCELLED,
                    ))
                break

            # Clean up this worker
            status = self._cleanup_single_worker(worker, config, strategy)
            worker_statuses.append(status)

            if status.result != CleanupResult.SUCCESS:
                warnings.append(f"Worker {config.worker_type.value} cleanup failed: {status.error_message}")

        return CleanupWorkersResult(
            worker_statuses=worker_statuses,
            warnings=warnings,
        )

    def _cleanup_single_worker(
        self,
        worker: WorkerInstance,
        config: WorkerCleanupConfiguration,
        strategy: CleanupStrategy,
    ) -> WorkerCleanupStatus:
        """Clean up a single worker"""
        start_time = datetime.now(UTC)
        status = WorkerCleanupStatus(
            worker_type=config.worker_type,
            result=CleanupResult.FAILED,
        )

        try:
            self._logger.log_debug(f"Cleaning up {config.worker_type.value} worker")

            # Step 1: Disconnect signals
            if config.disconnect_signals:
                signal_result = self._signal_management.disconnect_worker_signals(worker)
                if signal_result.is_success:
                    status.signals_disconnected = True
                else:
                    self._logger.log_warning(f"Failed to disconnect signals: {signal_result.get_error()}",
                    )

            # Step 2: Stop worker
            if strategy == CleanupStrategy.GRACEFUL:
                stop_result = self._worker_control.stop_worker(worker, config.graceful_timeout_ms)
            elif strategy == CleanupStrategy.FORCE:
                stop_result = (
                    self._worker_control.force_stop_worker(worker, config.force_timeout_ms))
            else:  # TIMEOUT_THEN_FORCE
                stop_result = self._worker_control.stop_worker(worker, config.graceful_timeout_ms)
                if not stop_result.is_success:
                    stop_result = (
                        self._worker_control.force_stop_worker(worker, config.force_timeout_ms))
                    status.force_cleanup_used = True

            if stop_result.is_success:
                status.worker_stopped = True
            else:
                self._logger.log_warning(f"Failed to stop worker: {stop_result.get_error()}")

            # Step 3: Stop thread
            thread_result = self._worker_registry.get_worker_thread(worker)
            if thread_result.is_success and thread_result.value is not None:
                thread = thread_result.value

                if strategy == CleanupStrategy.GRACEFUL:
                    thread_stop_result = (
                        self._thread_management.stop_thread(thread, config.graceful_timeout_ms))
                elif strategy == CleanupStrategy.FORCE:
                    thread_stop_result = (
                        self._thread_management.force_stop_thread(thread, config.force_timeout_ms))
                else:  # TIMEOUT_THEN_FORCE
                    thread_stop_result = (
                        self._thread_management.stop_thread(thread, config.graceful_timeout_ms))
                    if not thread_stop_result.is_success:
                        thread_stop_result = (
                            self._thread_management.force_stop_thread(thread, config.force_timeout_ms))
                        status.force_cleanup_used = True

                if thread_stop_result.is_success:
                    status.thread_stopped = True

                    # Wait for thread completion if requested
                    if config.wait_for_completion:
                        wait_result = (
                            self._thread_management.wait_for_thread(thread, config.graceful_timeout_ms))
                        if not wait_result.is_success:
                            self._logger.log_warning(f"Thread did not complete within timeout: {wait_result.get_error()}")

                    # Clean up thread resources
                    cleanup_result = self._thread_management.cleanup_thread(thread)
                    if not cleanup_result.is_success:
                        self._logger.log_warning(f"Thread cleanup failed: {cleanup_result.get_error()}")
                else:
                    self._logger.log_warning(f"Failed to stop thread: {thread_stop_result.get_error()}")

            # Step 4: Clean up resources
            if config.cleanup_resources:
                resource_result = (
                    self._resource_management.cleanup_worker_resources(worker, config.worker_type))
                if resource_result.is_success:
                    status.resources_cleaned = True
                else:
                    self._logger.log_warning(f"Resource cleanup failed: {resource_result.get_error()}")

                # Clean up temporary files
                temp_cleanup_result = (
                    self._resource_management.cleanup_temporary_files(config.worker_type))
                if not temp_cleanup_result.is_success:
                    self._logger.log_warning(f"Temporary file cleanup failed: {temp_cleanup_result.get_error()}")

                # Release GPU memory if applicable
                gpu_cleanup_result = (
                    self._resource_management.release_gpu_memory(config.worker_type))
                if not gpu_cleanup_result.is_success:
                    self._logger.log_debug(f"GPU memory cleanup not applicable or failed: {gpu_cleanup_result.get_error()}")

            # Step 5: Remove from registry
            registry_result = self._worker_registry.remove_worker(worker, config.worker_type)
            if not registry_result.is_success:
                self._logger.log_warning(f"Failed to remove worker from registry: {registry_result.get_error()}")

            # Step 6: Force garbage collection if requested
            if config.force_garbage_collection:
                gc_result = self._resource_management.force_garbage_collection()
                if gc_result.is_success:
                    status.memory_freed_mb = gc_result.value
                else:
                    self._logger.log_warning(f"Garbage collection failed: {gc_result.get_error()}")

            # Determine success
            if status.signals_disconnected and status.worker_stopped and status.thread_stopped and status.resources_cleaned:
                status.result = CleanupResult.SUCCESS
            elif status.worker_stopped or status.thread_stopped:
                status.result = CleanupResult.PARTIAL_SUCCESS
            else:
                status.result = CleanupResult.FAILED
                status.error_message = "Failed to stop worker and thread"

            status.cleanup_time_ms = int((datetime.now(UTC) - start_time).total_seconds() * 1000)

            self._logger.log_debug(
                f"{config.worker_type.value} worker cleanup completed",
                result=status.result.value,
                cleanup_time_ms=status.cleanup_time_ms,
                force_used=status.force_cleanup_used,
            )

        except Exception as e:
            status.error_message = f"Unexpected error: {e!s}"
            status.result = CleanupResult.FAILED
            self._logger.log_error(f"Error cleaning up {config.worker_type.value} worker: {e!s}")

        return status

    def _verify_cleanup_completion(
    self,
    worker_statuses: list[WorkerCleanupStatus]) -> Result[None]:
        """Verify that cleanup was completed successfully"""
        try:
            failed_verifications = []

            for status in worker_statuses:
                if status.result == CleanupResult.SUCCESS:
                    # Verify worker is no longer in registry
                    worker_result = self._worker_registry.get_worker_by_type(status.worker_type)
                    if worker_result.is_success and worker_result.value is not None:
                        # Check if worker is still active
                        if self._worker_registry.is_worker_active(worker_result.value):
                            failed_verifications.append(f"{status.worker_type.value} worker still active")

            if failed_verifications:
                return Result.failure(f"Verification failed: {', '.join(failed_verifications)}")

            return Result.success(None)

        except Exception as e:
            return Result.failure(f"Verification error: {e!s}")

    def _get_current_memory_usage(self) -> float | None:
        """Get current memory usage"""
        try:
            memory_result = self._resource_management.get_memory_usage()
            return memory_result.value if memory_result.is_success else None
        except Exception:
            return None

    def _update_progress(self, callback: ProgressCallback | None, phase: CleanupPhase, percentage: int,
    ) -> bool:
        """Update progress and check for cancellation"""
        if callback:
            progress = ProgressPercentage(float(percentage))
            message = f"Cleanup phase: {phase.value}"
            callback(progress, message)
        return True