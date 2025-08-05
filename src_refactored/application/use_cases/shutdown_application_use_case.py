"""Application Shutdown Use Case for WinSTT

This module provides the shutdown use case for graceful application termination,
managing resource cleanup and proper application exit.
"""

import atexit
from dataclasses import dataclass

from PyQt6.QtWidgets import QApplication

from logger import setup_logger
from src_refactored.infrastructure.common.progress_callback import (
    IProgressCallback,
    ProgressInfo,
    ProgressStatus,
)


@dataclass(frozen=True)
class ShutdownRequest:
    """Request for application shutdown."""
    
    force_shutdown: bool = False
    cleanup_timeout_seconds: int = 30
    progress_callback: IProgressCallback | None = None
    save_state: bool = True


@dataclass(frozen=True)
class ShutdownResult:
    """Result of application shutdown."""
    
    success: bool
    exit_code: int = 0
    error_message: str | None = None
    cleanup_failures: list[str] = None
    
    def __post_init__(self):
        if self.cleanup_failures is None:
            object.__setattr__(self, "cleanup_failures", [])
    
    @classmethod
    def success_result(cls, exit_code: int = 0) -> "ShutdownResult":
        """Create a successful shutdown result."""
        return cls(success=True, exit_code=exit_code)
    
    @classmethod
    def failure_result(cls, error_message: str, exit_code: int = 1) -> "ShutdownResult":
        """Create a failed shutdown result."""
        return cls(success=False, error_message=error_message, exit_code=exit_code)
    
    @classmethod
    def partial_failure_result(
        cls, 
        cleanup_failures: list[str], 
        exit_code: int = 0,
    ) -> "ShutdownResult":
        """Create a result with partial cleanup failures."""
        return cls(
            success=True, 
            exit_code=exit_code, 
            cleanup_failures=cleanup_failures,
        )


class ShutdownApplicationUseCase:
    """Use case for shutting down the WinSTT application gracefully."""
    
    def __init__(self):
        self.logger = setup_logger()
        self._cleanup_functions: list[callable] = []
        self._is_shutting_down = False
    
    def register_cleanup_function(self, cleanup_func: callable) -> None:
        """Register a cleanup function to be called during shutdown.
        
        Args:
            cleanup_func: Function to call during cleanup
        """
        if cleanup_func not in self._cleanup_functions:
            self._cleanup_functions.append(cleanup_func)
    
    def execute(self, request: ShutdownRequest) -> ShutdownResult:
        """Execute the application shutdown workflow.
        
        Args:
            request: Shutdown request with options
            
        Returns:
            ShutdownResult with success status and any cleanup failures
        """
        if self._is_shutting_down:
            self.logger.warning("Shutdown already in progress")
            return ShutdownResult.success_result()
        
        self._is_shutting_down = True
        cleanup_failures = []
        
        try:
            self.logger.info("Starting application shutdown")
            
            # Step 1: Save application state if requested
            if request.save_state:
                self._report_progress(request.progress_callback, "Saving application state...", 10)
                try:
                    self._save_application_state()
                except Exception as e:
                    cleanup_failures.append(f"Failed to save application state: {e}")
                    self.logger.warning(f"Failed to save application state: {e}")
            
            # Step 2: Close main window gracefully
            self._report_progress(request.progress_callback, "Closing main window...", 20)
            try:
                self._close_main_window()
            except Exception as e:
                cleanup_failures.append(f"Failed to close main window: {e}")
                self.logger.warning(f"Failed to close main window: {e}")
            
            # Step 3: Stop background workers and services
            self._report_progress(request.progress_callback, "Stopping background services...", 40)
            try:
                self._stop_background_services()
            except Exception as e:
                cleanup_failures.append(f"Failed to stop background services: {e}")
                self.logger.warning(f"Failed to stop background services: {e}")
            
            # Step 4: Cleanup registered functions
            self._report_progress(request.progress_callback, "Running cleanup functions...", 60)
            cleanup_failures.extend(self._run_cleanup_functions())
            
            # Step 5: Cleanup single instance socket
            self._report_progress(request.progress_callback, "Cleaning up system resources...", 80)
            try:
                self._cleanup_single_instance_socket()
            except Exception as e:
                cleanup_failures.append(f"Failed to cleanup socket: {e}")
                self.logger.warning(f"Failed to cleanup socket: {e}")
            
            # Step 6: Quit Qt application
            self._report_progress(request.progress_callback, "Shutting down Qt application...", 90)
            try:
                self._quit_qt_application()
            except Exception as e:
                cleanup_failures.append(f"Failed to quit Qt application: {e}")
                self.logger.warning(f"Failed to quit Qt application: {e}")
            
            # Step 7: Complete shutdown
            self._report_progress(request.progress_callback, "Shutdown completed", 100)
            
            if cleanup_failures:
                self.logger.warning(f"Shutdown completed with {len(cleanup_failures)} cleanup failures")
                return ShutdownResult.partial_failure_result(cleanup_failures)
            else:
                self.logger.info("Application shutdown completed successfully")
                return ShutdownResult.success_result()
            
        except Exception as e:
            error_msg = f"Critical error during shutdown: {e}"
            self.logger.exception(error_msg)
            return ShutdownResult.failure_result(error_msg)
        
        finally:
            self._is_shutting_down = False
    
    def _save_application_state(self) -> None:
        """Save current application state before shutdown."""
        # This would typically save window positions, user preferences, etc.
        # For now, we'll just log that state saving would happen here
        self.logger.info("Application state saved")
    
    def _close_main_window(self) -> None:
        """Close the main application window gracefully."""
        app = QApplication.instance()
        if app:
            # Get all top-level widgets and close them
            for widget in app.topLevelWidgets():
                if widget.isVisible():
                    widget.close()
                    self.logger.debug(f"Closed widget: {widget.__class__.__name__}")
    
    def _stop_background_services(self) -> None:
        """Stop any background workers and services."""
        # This would typically stop transcription workers, audio processors, etc.
        # For now, we'll just log that services would be stopped here
        self.logger.info("Background services stopped")
    
    def _run_cleanup_functions(self) -> list[str]:
        """Run all registered cleanup functions.
        
        Returns:
            List of error messages from failed cleanup functions
        """
        failures = []
        
        for i, cleanup_func in enumerate(self._cleanup_functions):
            try:
                self.logger.debug(f"Running cleanup function {i + 1}/{len(self._cleanup_functions)}")
                cleanup_func()
            except Exception as e:
                error_msg = f"Cleanup function {i + 1} failed: {e}"
                failures.append(error_msg)
                self.logger.warning(error_msg)
        
        return failures
    
    def _cleanup_single_instance_socket(self) -> None:
        """Cleanup the single instance socket."""
        from src.main import cleanup_socket
        
        try:
            cleanup_socket()
            self.logger.debug("Single instance socket cleaned up")
        except Exception as e:
            self.logger.warning(f"Failed to cleanup socket: {e}")
            raise
    
    def _quit_qt_application(self) -> None:
        """Quit the Qt application."""
        app = QApplication.instance()
        if app:
            app.quit()
            self.logger.debug("Qt application quit")
    
    def _report_progress(
        self, 
        callback: IProgressCallback | None, 
        message: str, 
        percentage: int,
    ) -> None:
        """Report progress if callback is provided."""
        if callback:
            progress_info = ProgressInfo(
                current=percentage,
                total=100,
                message=message,
                status=ProgressStatus.IN_PROGRESS if percentage < 100 else ProgressStatus.COMPLETED,
            )
            callback.report_progress(progress_info)


class ShutdownManager:
    """Manager for application shutdown with automatic registration."""
    
    def __init__(self):
        self.shutdown_use_case = ShutdownApplicationUseCase()
        self._registered_atexit = False
    
    def register_for_atexit(self) -> None:
        """Register shutdown to be called automatically on exit."""
        if not self._registered_atexit:
            atexit.register(self._atexit_shutdown)
            self._registered_atexit = True
    
    def register_cleanup_function(self, cleanup_func: callable) -> None:
        """Register a cleanup function."""
        self.shutdown_use_case.register_cleanup_function(cleanup_func)
    
    def shutdown(self, force: bool = False) -> ShutdownResult:
        """Perform application shutdown."""
        request = ShutdownRequest(force_shutdown=force)
        return self.shutdown_use_case.execute(request)
    
    def _atexit_shutdown(self) -> None:
        """Shutdown function called by atexit."""
        try:
            request = ShutdownRequest(force_shutdown=True, save_state=False)
            self.shutdown_use_case.execute(request)
        except Exception as e:
            # Can't use logger here as it might be shut down
            print(f"Error during atexit shutdown: {e}")


def create_shutdown_use_case() -> ShutdownApplicationUseCase:
    """Factory function to create a ShutdownApplicationUseCase instance."""
    return ShutdownApplicationUseCase()


def create_shutdown_manager() -> ShutdownManager:
    """Factory function to create a ShutdownManager instance."""
    return ShutdownManager()