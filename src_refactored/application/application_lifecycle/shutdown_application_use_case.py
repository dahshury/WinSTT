"""Shutdown Application Use Case.

This module implements the use case for graceful application shutdown,
including resource cleanup, worker termination, and state persistence.
"""

import contextlib
import logging
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from src_refactored.domain.application_lifecycle.entities import ShutdownConfiguration
from src_refactored.domain.application_lifecycle.value_objects import (
    ShutdownPhase,
    ShutdownReason,
    ShutdownResult,
)


@dataclass
class ShutdownApplicationRequest:
    """Request for application shutdown."""
    reason: ShutdownReason
    configuration: ShutdownConfiguration
    progress_callback: Callable[[int, str, ShutdownPhase], None] | None = None
    error_callback: Callable[[str, Exception], None] | None = None
    force_immediate: bool = False


@dataclass
class ShutdownApplicationResponse:
    """Response from application shutdown."""
    result: ShutdownResult
    completed_phases: list[ShutdownPhase] = field(default_factory=list)
    current_phase: ShutdownPhase = ShutdownPhase.INITIATED
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)
    cleanup_errors: list[str] = field(default_factory=list)
    exit_code: int = 0

    def __post_init__(self):
        if self.completed_phases is None:
            self.completed_phases = []
        if self.warnings is None:
            self.warnings = []
        if self.cleanup_errors is None:
            self.cleanup_errors = []


class StateManagerProtocol(Protocol):
    """Protocol for state management."""

    def save_application_state(self,
    ) -> bool:
        """Save current application state."""
        ...

    def save_window_state(self, window: Any,
    ) -> bool:
        """Save window state and geometry."""
        ...


class WorkerManagerProtocol(Protocol):
    """Protocol for worker management."""

    def stop_all_workers(self, timeout_seconds: int = 5, force: bool = False) -> bool:
        """Stop all running workers."""
        ...

    def get_active_workers(self) -> list[str]:
        """Get list of active worker names."""
        ...


class ResourceManagerProtocol(Protocol):
    """Protocol for resource management."""

    def cleanup_resources(self) -> bool:
        """Cleanup application resources."""
        ...

    def cleanup_temp_files(self) -> bool:
        """Cleanup temporary files."""
        ...

    def close_connections(self) -> bool:
        """Close network connections and sockets."""
        ...


class ApplicationProtocol(Protocol):
    """Protocol for application instance."""

    def quit(self) -> None:
        """Quit the application."""
        ...

    def processEvents(self,
    ) -> None:
        """Process pending events."""
        ...


class ShutdownApplicationUseCase:
    """Use case for graceful application shutdown."""

    def __init__(
        self,
        state_manager: StateManagerProtocol,
        worker_manager: WorkerManagerProtocol,
        resource_manager: ResourceManagerProtocol,
        logger: logging.Logger | None = None,
    ):
        self.state_manager = state_manager
        self.worker_manager = worker_manager
        self.resource_manager = resource_manager
        self.logger = logger
        self.current_phase = ShutdownPhase.INITIATED

    def execute(self, request: ShutdownApplicationRequest,
    ) -> ShutdownApplicationResponse:
        """Execute the shutdown application use case."""
        response = ShutdownApplicationResponse(
            result=ShutdownResult.FAILED,
            current_phase=self.current_phase,
        )

        try:
            if self.logger:
                self.logger.info("Application shutdown initiated: {request.reason.value}")

            # Handle immediate forced shutdown
            if request.force_immediate:
                return self._force_immediate_shutdown(request, response)

            # Phase 1: Save State
            self._update_progress(request, 10, "Saving application state...", ShutdownPhase.SAVING_STATE)
            success = self._save_application_state(request, response)
            if not success and request.reason == ShutdownReason.CRITICAL_ERROR:
                response.warnings.append("State saving failed during critical error")

            # Phase 2: Stop Workers
            self._update_progress(request, 30, "Stopping workers...", ShutdownPhase.STOPPING_WORKERS)
            success = self._stop_workers(request, response)
            if not success:
                response.warnings.append("Some workers failed to stop gracefully")

            # Phase 3: Clean Resources
            self._update_progress(request, 60, "Cleaning up resources...", ShutdownPhase.CLEANING_RESOURCES)
            success = self._cleanup_resources(request, response)
            if not success:
                response.warnings.append("Resource cleanup encountered errors")

            # Phase 4: Close Connections
            self._update_progress(request, 80, "Closing connections...", ShutdownPhase.CLOSING_CONNECTIONS)
            success = self._close_connections(request, response)
            if not success:
                response.warnings.append("Connection closure encountered errors")

            # Phase 5: Finalize
            self._update_progress(request, 95, "Finalizing shutdown...", ShutdownPhase.FINALIZING)
            success = self._finalize_shutdown(request, response)
            if not success:
                response.warnings.append("Finalization encountered errors")

            # Phase 6: Complete
            self._update_progress(request, 100, "Shutdown complete", ShutdownPhase.COMPLETED)
            response.result = (
                ShutdownResult.SUCCESS if not response.warnings else ShutdownResult.PARTIAL_SUCCESS)
            response.current_phase = ShutdownPhase.COMPLETED
            response.completed_phases.append(ShutdownPhase.COMPLETED)

            if self.logger:
                self.logger.info("Application shutdown completed: {response.result.value}")

            return response

        except Exception as e:
            return self._create_error_response(f"Unexpected shutdown error: {e!s}", response, e)

    def _save_application_state(self,
    request: ShutdownApplicationRequest, response: ShutdownApplicationResponse,
    ) -> bool:
        """Save application state before shutdown."""
        try:
            if not request.configuration.save_state:
                response.completed_phases.append(ShutdownPhase.SAVING_STATE)
                return True

            success = self.state_manager.save_application_state()

            if success:
                response.completed_phases.append(ShutdownPhase.SAVING_STATE)
                if self.logger:
                    self.logger.info("Application state saved successfully")
                return True
            response.cleanup_errors.append("Failed to save application state")
            return False

        except Exception as e:
            if request.error_callback:
                request.error_callback("State saving failed", e)
            response.cleanup_errors.append(f"State saving error: {e!s}")
            return False

    def _stop_workers(self, request: ShutdownApplicationRequest, response: ShutdownApplicationResponse,
    ) -> bool:
        """Stop all running workers."""
        try:
            active_workers = self.worker_manager.get_active_workers()

            if not active_workers:
                response.completed_phases.append(ShutdownPhase.STOPPING_WORKERS)
                return True

            if self.logger:
                self.logger.info(f"Stopping {len(active_workers)} active workers")

            success = self.worker_manager.stop_all_workers(
                timeout_seconds=request.configuration.worker_timeout_seconds,
                force=request.configuration.force_worker_termination,
            )

            if success:
                response.completed_phases.append(ShutdownPhase.STOPPING_WORKERS)
                if self.logger:
                    self.logger.info("All workers stopped successfully")
                return True
            response.cleanup_errors.append("Some workers failed to stop")
            return False

        except Exception as e:
            if request.error_callback:
                request.error_callback("Worker stopping failed", e)
            response.cleanup_errors.append(f"Worker stopping error: {e!s}")
            return False

    def _cleanup_resources(self, request: ShutdownApplicationRequest, response: ShutdownApplicationResponse,
    ) -> bool:
        """Cleanup application resources."""
        try:
            success = True

            # Cleanup main resources
            if not self.resource_manager.cleanup_resources():
                response.cleanup_errors.append("Main resource cleanup failed")
                success = False

            # Cleanup temporary files if requested
            if request.configuration.cleanup_temp_files:
                if not self.resource_manager.cleanup_temp_files():
                    response.cleanup_errors.append("Temporary file cleanup failed")
                    success = False

            if success:
                response.completed_phases.append(ShutdownPhase.CLEANING_RESOURCES)
                if self.logger:
                    self.logger.info("Resources cleaned up successfully")

            return success

        except Exception as e:
            if request.error_callback:
                request.error_callback("Resource cleanup failed", e)
            response.cleanup_errors.append(f"Resource cleanup error: {e!s}")
            return False

    def _close_connections(self, request: ShutdownApplicationRequest, response: ShutdownApplicationResponse,
    ) -> bool:
        """Close network connections and sockets."""
        try:
            success = self.resource_manager.close_connections()

            if success:
                response.completed_phases.append(ShutdownPhase.CLOSING_CONNECTIONS)
                if self.logger:
                    self.logger.info("Connections closed successfully")
                return True
            response.cleanup_errors.append("Connection closure failed")
            return False

        except Exception as e:
            if request.error_callback:
                request.error_callback("Connection closure failed", e)
            response.cleanup_errors.append(f"Connection closure error: {e!s}")
            return False

    def _finalize_shutdown(self, request: ShutdownApplicationRequest, response: ShutdownApplicationResponse,
    ) -> bool:
        """Finalize the shutdown process."""
        try:
            # Determine exit code based on shutdown reason and success
            if request.reason == ShutdownReason.CRITICAL_ERROR:
                response.exit_code = 1
            elif request.reason == ShutdownReason.FORCED_EXIT:
                response.exit_code = 2
            elif response.cleanup_errors:
                response.exit_code = 3
            else:
                response.exit_code = 0

            response.completed_phases.append(ShutdownPhase.FINALIZING)

            if self.logger:
                self.logger.info("Shutdown finalized with exit code: {response.exit_code}")

            return True

        except Exception as e:
            if request.error_callback:
                request.error_callback("Shutdown finalization failed", e)
            response.cleanup_errors.append(f"Finalization error: {e!s}")
            return False

    def _force_immediate_shutdown(self,
    request: ShutdownApplicationRequest, response: ShutdownApplicationResponse,
    ) -> ShutdownApplicationResponse:
        """Force immediate shutdown without graceful cleanup."""
        try:
            if self.logger:
                self.logger.warning("Forcing immediate shutdown")

            # Try basic cleanup but don't wait
            with contextlib.suppress(Exception):
                self.worker_manager.stop_all_workers(timeout_seconds=1, force=True)

            with contextlib.suppress(Exception):
                self.resource_manager.close_connections()

            response.result = ShutdownResult.FORCED
            response.current_phase = ShutdownPhase.COMPLETED
            response.exit_code = 2
            response.warnings.append("Forced immediate shutdown - cleanup may be incomplete")

            return response

        except Exception as e:
            return self._create_error_response(f"Force shutdown failed: {e!s}", response, e)

    def _update_progress(
        self,
        request: ShutdownApplicationRequest,
        percentage: int,
        message: str,
        phase: ShutdownPhase,
    ) -> None:
        """Update shutdown progress."""
        self.current_phase = phase

        if request.progress_callback:
            request.progress_callback(percentage, message, phase)

    def _create_error_response(
        self,
        error_message: str,
        response: ShutdownApplicationResponse,
        exception: Exception | None = None,
    ) -> ShutdownApplicationResponse:
        """Create an error response."""
        response.result = ShutdownResult.FAILED
        response.error_message = error_message
        response.exit_code = 1

        if self.logger:
            if exception:
                self.logger.exception(f"Shutdown error: {error_message}")
            else:
                self.logger.error("Shutdown error: {error_message}")

        return response

    def get_current_phase(self) -> ShutdownPhase:
        """Get the current shutdown phase."""
        return self.current_phase

    def emergency_shutdown(self, application: ApplicationProtocol,
    ) -> None:
        """Emergency shutdown for critical situations."""
        try:
            if self.logger:
                self.logger.critical("Emergency shutdown initiated")

            # Force quit application
            application.quit()

            # Force exit if application doesn't quit
            sys.exit(1)

        except Exception:
            # Last resort
            sys.exit(1)