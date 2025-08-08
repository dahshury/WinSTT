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


class PyQtApplicationLifecycleAdapter(ApplicationLifecyclePort):
    """PyQt implementation of application lifecycle management."""

    def __init__(self):
        self._app: QApplication | None = None
        self._is_initialized = False

    def startup(self, config: StartupConfiguration) -> StartupResult:
        """Start up the application."""
        try:
            # Initialize QApplication if not already done
            if not self._app or not isinstance(self._app, QApplication):
                existing_app = QApplication.instance()
                if existing_app:
                    self._app = existing_app
                else:
                    new_app = QApplication([])
                    self._app = new_app
            
            # Set application metadata
            if self._app and hasattr(config, "app_name") and config.app_name:
                self._app.setApplicationName(config.app_name)
            if self._app and hasattr(config, "app_version") and config.app_version:
                self._app.setApplicationVersion(config.app_version)
            if self._app and hasattr(config, "organization_name") and config.organization_name:
                self._app.setOrganizationName(config.organization_name)
            
            return StartupResult.SUCCESS
        except Exception:
            return StartupResult.INITIALIZATION_FAILED

    def start_event_loop(self) -> int:
        """Start the main application event loop."""
        try:
            if not self._is_initialized or not self._app:
                return -1

            # Start the event loop
            return self._app.exec()

        except Exception:
            return -1

    def start_application(self) -> StartupResult:
        """Start the PyQt application event loop."""
        try:
            if not self._is_initialized or not self._app:
                return StartupResult.INITIALIZATION_FAILED

            # Start the event loop
            exit_code = self._app.exec()
            
            if exit_code == 0:
                return StartupResult.SUCCESS
            return StartupResult.INITIALIZATION_FAILED

        except Exception:
            return StartupResult.INITIALIZATION_FAILED

    def shutdown_application(self, config: ShutdownConfiguration) -> ShutdownResult:
        """Shutdown the PyQt application."""
        try:
            if not self._app:
                return ShutdownResult.SUCCESS

            # Perform cleanup if requested
            if hasattr(config, "perform_cleanup") and config.perform_cleanup:
                # Close all windows
                self._app.closeAllWindows()

            # Request application exit
            if hasattr(config, "force_exit") and config.force_exit:
                self._app.quit()
            else:
                exit_code = getattr(config, "exit_code", 0) or 0
                self._app.exit(exit_code)

            return ShutdownResult.SUCCESS

        except Exception:
            return ShutdownResult.PARTIAL_SUCCESS

    def request_exit(self, exit_code: int = 0) -> None:
        """Request application exit with specified code."""
        try:
            if self._app:
                self._app.exit(exit_code)
        except Exception:
            pass

    def is_running(self) -> bool:
        """Check if the application is currently running."""
        try:
            return self._app is not None and self._is_initialized
        except Exception:
            return False

    def get_command_line_arguments(self) -> list[str]:
        """Get command line arguments passed to the application."""
        try:
            return sys.argv.copy()
        except Exception:
            return []

    def set_application_metadata(self, name: str, version: str, organization: str) -> None:
        """Set application metadata."""
        try:
            if not self._app:
                return

            self._app.setApplicationName(name)
            self._app.setApplicationVersion(version)
            self._app.setOrganizationName(organization)
        except Exception:
            pass

    def run_application(self) -> int:
        """Run the application event loop."""
        try:
            if not self._is_initialized or not self._app:
                return -1

            return self._app.exec()
        except Exception:
            return -1