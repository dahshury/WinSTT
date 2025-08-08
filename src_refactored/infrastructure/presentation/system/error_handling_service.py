"""Error handling service for application-level error management and user notifications.

This module provides infrastructure services for handling application errors,
user notifications, and graceful application termination.
"""

import sys
from collections.abc import Callable
from types import TracebackType
from typing import TYPE_CHECKING, Any

from PyQt6.QtWidgets import QMessageBox, QWidget

from src_refactored.domain.system_integration.value_objects.system_operations import (
    ErrorSeverity,
    ExitCode,
)

if TYPE_CHECKING:
    from src_refactored.domain.application_lifecycle.ports.application_lifecycle_port import (
        ApplicationLifecyclePort,
    )


class ErrorHandlingService:
    """Service for handling application errors and user notifications.
    
    This service provides infrastructure for displaying error messages to users,
    logging errors, and managing graceful application termination.
    """

    def __init__(self, logger=None):
        """Initialize the error handling service.
        
        Args:
            logger: Optional logger instance for error logging
        """
        self._logger = logger
        self._error_handlers: dict[ErrorSeverity, Callable] = {}
        self._default_parent: QWidget | None = None
        self._application_name = "WinSTT"
        self._show_detailed_errors = False
        self._exit_on_critical = True
        self._requested_exit_code: int | None = None

    def configure(self,
                 application_name: str = "WinSTT",
                 default_parent: QWidget | None = None,
                 show_detailed_errors: bool = False,
                 exit_on_critical: bool = True,
    ) -> None:
        """Configure the error handling service.
        
        Args:
            application_name: Name to display in error dialogs
            default_parent: Default parent widget for dialogs
            show_detailed_errors: Whether to show detailed error information
            exit_on_critical: Whether to exit application on critical errors
        """
        self._application_name = application_name
        self._default_parent = default_parent
        self._show_detailed_errors = show_detailed_errors
        self._exit_on_critical = exit_on_critical

    def set_logger(self, logger) -> None:
        """Set the logger for error logging.
        
        Args:
            logger: Logger instance
        """
        self._logger = logger

    def register_error_handler(self, severity: ErrorSeverity, handler: Callable,
    ) -> None:
        """Register a custom error handler for a specific severity.
        
        Args:
            severity: Error severity level
            handler: Handler function that takes (message, details, exception)
        """
        self._error_handlers[severity] = handler

    def show_info_message(self,
                         message: str,
                         title: str | None = None,
                         parent: QWidget | None = None) -> None:
        """Show an information message to the user.
        
        Args:
            message: Information message to display
            title: Dialog title (defaults to application name)
            parent: Parent widget for the dialog
        """
        if title is None:
            title = self._application_name

        if parent is None:
            parent = self._default_parent

        if ErrorSeverity.INFO in self._error_handlers:
            self._error_handlers[ErrorSeverity.INFO](message, None, None)
        else:
            QMessageBox.information(parent, title, message)

        if self._logger:
            self._logger.info(f"Info message shown: {message}")

    def show_warning_message(self,
                           message: str,
                           title: str | None = None,
                           parent: QWidget | None = None) -> None:
        """Show a warning message to the user.
        
        Args:
            message: Warning message to display
            title: Dialog title (defaults to application name)
            parent: Parent widget for the dialog
        """
        if title is None:
            title = self._application_name

        if parent is None:
            parent = self._default_parent

        if ErrorSeverity.WARNING in self._error_handlers:
            self._error_handlers[ErrorSeverity.WARNING](message, None, None)
        else:
            QMessageBox.warning(parent, title, message)

        if self._logger:
            self._logger.warning(f"Warning message shown: {message}")

    def show_error_message(self,
                          message: str,
                          details: str | None = None,
                          exception: Exception | None = None,
                          title: str | None = None,
                          parent: QWidget | None = None) -> None:
        """Show an error message to the user.
        
        Args:
            message: Error message to display
            details: Additional error details
            exception: Exception that caused the error
            title: Dialog title (defaults to application name + " Error")
            parent: Parent widget for the dialog
        """
        if title is None:
            title = f"{self._application_name} Error"

        if parent is None:
            parent = self._default_parent

        # Prepare display message
        display_message = message
        if self._show_detailed_errors and details:
            display_message += f"\n\nDetails: {details}"
        if self._show_detailed_errors and exception:
            display_message += f"\n\nException: {exception!s}"

        if ErrorSeverity.ERROR in self._error_handlers:
            self._error_handlers[ErrorSeverity.ERROR](message, details, exception)
        else:
            QMessageBox.critical(parent, title, display_message)

        # Log the error
        if self._logger:
            if exception:
                self._logger.exception(f"Error: {message}")
            else:
                self._logger.error(f"Error: {message}. Details: {details}")

    def show_critical_error(self,
                          message: str,
                          details: str | None = None,
                          exception: Exception | None = None,
                          title: str | None = None,
                          parent: QWidget | None = None,
                          exit_code: ExitCode = ExitCode.GENERAL_ERROR) -> None:
        """Show a critical error message and optionally exit the application.
        
        Args:
            message: Critical error message to display
            details: Additional error details
            exception: Exception that caused the error
            title: Dialog title (defaults to application name + " Critical Error",
    )
            parent: Parent widget for the dialog
            exit_code: Exit code to use if exiting application
        """
        if title is None:
            title = f"{self._application_name} Critical Error"

        if parent is None:
            parent = self._default_parent

        # Prepare display message
        display_message = message
        if self._show_detailed_errors and details:
            display_message += f"\n\nDetails: {details}"
        if self._show_detailed_errors and exception:
            display_message += f"\n\nException: {exception!s}"

        if ErrorSeverity.CRITICAL in self._error_handlers:
            self._error_handlers[ErrorSeverity.CRITICAL](message, details, exception)
        else:
            QMessageBox.critical(parent, title, display_message)

        # Log the critical error
        if self._logger:
            if exception:
                self._logger.exception(f"Critical error: {message}")
            else:
                self._logger.error(f"Critical error: {message}. Details: {details}")

        # Exit application if configured to do so
        if self._exit_on_critical:
            # Delegate termination via lifecycle port; do not hard-exit here
            try:
                terminator: ApplicationLifecyclePort | None = getattr(self, "_lifecycle_port", None)
                if terminator is not None:
                    terminator.request_exit(exit_code.value)
                else:
                    self._requested_exit_code = exit_code.value
            except Exception:
                self._requested_exit_code = exit_code.value

    def handle_application_startup_error(self,
                                        exception: Exception,
                                        exit_immediately: bool = True,
    ) -> None:
        """Handle application startup errors.
        
        This method replicates the error handling logic from main.py for startup failures.
        
        Args:
            exception: The exception that occurred during startup
            exit_immediately: Whether to exit immediately after showing error
        """
        error_message = f"Failed to start application: {exception!s}"

        self.show_critical_error(
            message=error_message,
            exception=exception,
            title=f"{self._application_name} Startup Error",
            exit_code=ExitCode.STARTUP_FAILURE,
        )

        if exit_immediately and not self._exit_on_critical:
            self.exit_application(ExitCode.STARTUP_FAILURE)

    def handle_already_running_error(self,
                                   activation_exception: Exception | None = None) -> None:
        """Handle the case where application is already running.
        
        This method replicates the error handling logic from main.py for already running instances.
        
        Args:
            activation_exception: Exception that occurred during window activation
        """
        if activation_exception and self._logger:
            self._logger.exception(f"Error activating existing instance: {activation_exception}")

        self.show_warning_message(
            message="An instance of WinSTT is already running.",
            title=self._application_name,
        )

        self.exit_application(ExitCode.ALREADY_RUNNING)

    def exit_application(self, exit_code: ExitCode = ExitCode.SUCCESS) -> None:
        """Exit the application with the specified exit code.
        
        Args:
            exit_code: Exit code to use
        """
        if self._logger:
            self._logger.info(f"Application exit requested with code: {exit_code.value}")
        try:
            terminator: ApplicationLifecyclePort | None = getattr(self, "_lifecycle_port", None)
            if terminator is not None:
                terminator.request_exit(exit_code.value)
            else:
                self._requested_exit_code = exit_code.value
        except Exception:
            self._requested_exit_code = exit_code.value

    def create_exception_handler(self,
    ) -> Callable[[type[BaseException], BaseException, TracebackType | None], Any]:
        """Create a global exception handler for unhandled exceptions.
        
        Returns:
            Exception handler function that can be assigned to sys.excepthook
        """
        def exception_handler(
            exc_type: type[BaseException],
            exc_value: BaseException,
            exc_traceback: TracebackType | None,
        ) -> Any:
            """Handle unhandled exceptions."""
            if issubclass(exc_type, KeyboardInterrupt):
                # Allow KeyboardInterrupt to exit normally
                sys.__excepthook__(exc_type, exc_value, exc_traceback)
                return

            error_message = f"Unhandled exception: {exc_type.__name__}"

            self.show_critical_error(
                message=error_message,
                details=str(exc_value),
                exception=Exception(str(exc_value)),
                title=f"{self._application_name} Unexpected Error",
                exit_code=ExitCode.GENERAL_ERROR,
            )

        return exception_handler

    def install_global_exception_handler(self) -> None:
        """Install global exception handler for unhandled exceptions."""
        sys.excepthook = self.create_exception_handler()

    def get_configuration(self) -> dict[str, Any]:
        """Get current error handling configuration.
        
        Returns:
            Dictionary with current configuration
        """
        return {
            "application_name": self._application_name,
            "show_detailed_errors": self._show_detailed_errors,
            "exit_on_critical": self._exit_on_critical,
            "has_logger": self._logger is not None,
            "registered_handlers": list(self._error_handlers.keys()),
        }


class WinSTTErrorHandler:
    """High-level error handler specifically configured for WinSTT application.
    
    This class provides a simplified interface for WinSTT-specific error handling patterns.
    """

    def __init__(self, logger=None):
        """Initialize WinSTT error handler.
        
        Args:
            logger: Optional logger instance
        """
        self.service = ErrorHandlingService(logger)
        self.service.configure(
            application_name="WinSTT",
            show_detailed_errors=False,
            exit_on_critical=True,
        )

    def handle_startup_failure(self, exception: Exception,
    ) -> None:
        """Handle application startup failure.
        
        Args:
            exception: The startup exception
        """
        self.service.handle_application_startup_error(exception)

    def handle_already_running(self, activation_error: Exception | None = None) -> None:
        """Handle already running application scenario.
        
        Args:
            activation_error: Optional error from window activation attempt
        """
        self.service.handle_already_running_error(activation_error)

    def show_general_error(self, message: str, exception: Exception | None = None) -> None:
        """Show a general error message.
        
        Args:
            message: Error message to display
            exception: Optional exception that caused the error
        """
        self.service.show_error_message(message, exception=exception)

    def show_warning(self, message: str,
    ) -> None:
        """Show a warning message.
        
        Args:
            message: Warning message to display
        """
        self.service.show_warning_message(message)

    def install_global_handler(self) -> None:
        """Install global exception handler."""
        self.service.install_global_exception_handler()

    def configure_logger(self, logger) -> None:
        """Configure the logger for error handling.
        
        Args:
            logger: Logger instance
        """
        self.service.set_logger(logger)

    def get_service(self) -> ErrorHandlingService:
        """Get the underlying error handling service.
        
        Returns:
            ErrorHandlingService instance
        """
        return self.service