"""PyQt implementation of ApplicationLifecyclePort."""

import sys

from PyQt6.QtWidgets import QApplication

from src_refactored.domain.application_lifecycle.entities.shutdown_configuration import (
    ShutdownConfiguration,
)
from src_refactored.domain.application_lifecycle.entities.startup_configuration import (
    StartupConfiguration,
)
from src_refactored.domain.application_lifecycle.ports.application_lifecycle_port import (
    ApplicationLifecyclePort,
)
from src_refactored.domain.application_lifecycle.value_objects.shutdown_result import ShutdownResult
from src_refactored.domain.application_lifecycle.value_objects.startup_result import StartupResult
from src_refactored.domain.common.result import Result


class PyQtApplicationLifecycleAdapter(ApplicationLifecyclePort):
    """PyQt implementation of application lifecycle management."""

    def __init__(self):
        self._app: QApplication | None = None
        self._is_initialized = False

    def initialize_application(self, config: StartupConfiguration) -> Result[None]:
        """Initialize the PyQt application."""
        try:
            if self._is_initialized:
                return Result.success(None)

            # Create QApplication if it doesn't exist
            if not QApplication.instance():
                self._app = QApplication(sys.argv)
            else:
                self._app = QApplication.instance()

            # Set application metadata
            if config.app_name:
                self._app.setApplicationName(config.app_name)
            if config.app_version:
                self._app.setApplicationVersion(config.app_version)
            if config.organization_name:
                self._app.setOrganizationName(config.organization_name)
            if config.organization_domain:
                self._app.setOrganizationDomain(config.organization_domain)

            self._is_initialized = True
            return Result.success(None)

        except Exception as e:
            return Result.failure(f"Failed to initialize application: {e!s}")

    def start_application(self) -> Result[StartupResult]:
        """Start the PyQt application event loop."""
        try:
            if not self._is_initialized or not self._app:
                return Result.failure("Application not initialized")

            # Start the event loop
            exit_code = self._app.exec()
            
            result = StartupResult(
                success=exit_code == 0,
                exit_code=exit_code,
                message=f"Application exited with code {exit_code}",
            )
            
            return Result.success(result)

        except Exception as e:
            result = StartupResult(
                success=False,
                exit_code=-1,
                message=f"Application startup failed: {e!s}",
            )
            return Result.failure(str(e), result)

    def shutdown_application(self, config: ShutdownConfiguration) -> Result[ShutdownResult]:
        """Shutdown the PyQt application."""
        try:
            if not self._app:
                result = ShutdownResult(
                    success=True,
                    cleanup_performed=False,
                    message="Application was not running",
                )
                return Result.success(result)

            # Perform cleanup if requested
            cleanup_performed = False
            if config.perform_cleanup:
                # Close all windows
                self._app.closeAllWindows()
                cleanup_performed = True

            # Request application exit
            if config.force_exit:
                self._app.quit()
            else:
                self._app.exit(config.exit_code or 0)

            result = ShutdownResult(
                success=True,
                cleanup_performed=cleanup_performed,
                message="Application shutdown initiated",
            )
            
            return Result.success(result)

        except Exception as e:
            result = ShutdownResult(
                success=False,
                cleanup_performed=False,
                message=f"Shutdown failed: {e!s}",
            )
            return Result.failure(str(e), result)

    def request_exit(self, exit_code: int = 0) -> Result[None]:
        """Request application exit with specified code."""
        try:
            if self._app:
                self._app.exit(exit_code)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to request exit: {e!s}")

    def is_running(self) -> Result[bool]:
        """Check if the application is currently running."""
        try:
            is_running = self._app is not None and self._is_initialized
            return Result.success(is_running)
        except Exception as e:
            return Result.failure(f"Failed to check running status: {e!s}")

    def get_command_line_arguments(self) -> Result[list[str]]:
        """Get command line arguments passed to the application."""
        try:
            args = sys.argv.copy()
            return Result.success(args)
        except Exception as e:
            return Result.failure(f"Failed to get command line arguments: {e!s}")

    def set_application_metadata(self, name: str, version: str, organization: str, domain: str) -> Result[None]:
        """Set application metadata."""
        try:
            if not self._app:
                return Result.failure("Application not initialized")

            self._app.setApplicationName(name)
            self._app.setApplicationVersion(version)
            self._app.setOrganizationName(organization)
            self._app.setOrganizationDomain(domain)
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to set application metadata: {e!s}")