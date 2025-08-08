"""Application Startup Service.

This module provides the application startup service that coordinates
the startup workflow and manages the application lifecycle.
"""

from typing import Protocol

from src_refactored.application.interfaces.main_window_service import IMainWindowService
from src_refactored.domain.application_lifecycle.entities.shutdown_configuration import (
    ShutdownConfiguration,
)
from src_refactored.domain.application_lifecycle.entities.single_instance_configuration import (
    SingleInstanceConfiguration,
)
from src_refactored.domain.application_lifecycle.entities.startup_configuration import (
    StartupConfiguration,
)
from src_refactored.domain.application_lifecycle.ports.application_lifecycle_port import (
    ApplicationLifecyclePort,
)
from src_refactored.domain.application_lifecycle.ports.single_instance_port import (
    SingleInstancePort,
)
from src_refactored.domain.application_lifecycle.value_objects.instance_check_result import (
    InstanceCheckResult,
)
from src_refactored.domain.application_lifecycle.value_objects.shutdown_result import ShutdownResult
from src_refactored.domain.application_lifecycle.value_objects.startup_result import StartupResult
from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.domain.common.result import Result
from src_refactored.domain.ui_coordination.ports.window_management_port import (
    WindowManagementPort,
)


class IApplicationStartupService(Protocol):
    """Protocol for application startup service."""
    
    def initialize_application(self) -> Result[None]:
        """Initialize the application with proper configuration."""
        ...
    
    def check_single_instance(self) -> Result[bool]:
        """Check if another instance is already running."""
        ...
    
    def create_and_show_main_window(self) -> Result[None]:
        """Create and show the main application window."""
        ...
    
    def start_application_loop(self) -> int:
        """Start the application event loop."""
        ...
    
    def shutdown_application(self, config: ShutdownConfiguration) -> Result[None]:
        """Perform graceful application shutdown."""
        ...


class ApplicationStartupService:
    """Service for coordinating application startup workflow."""
    
    def __init__(
        self,
        application_lifecycle_port: ApplicationLifecyclePort,
        window_management_port: WindowManagementPort,
        single_instance_port: SingleInstancePort,
        main_window_service: IMainWindowService,
        logger: LoggingPort,
    ):
        self.logger = logger
        self._application_lifecycle_port = application_lifecycle_port
        self._window_management_port = window_management_port
        self._single_instance_port = single_instance_port
        self._main_window_service = main_window_service
        self._main_window_id: str | None = None
    
    def initialize_application(self) -> Result[None]:
        """Initialize the application with proper configuration."""
        # Create default startup configuration
        config = StartupConfiguration()
        result = self._application_lifecycle_port.initialize_application(config)
        if result == StartupResult.SUCCESS:
            self.logger.log_info("Application initialized successfully")
            return Result.success(None)
        error_msg = f"Failed to initialize application: {result.value}"
        self.logger.log_error(error_msg)
        return Result.failure(error_msg)
    
    def check_single_instance(self) -> Result[bool]:
        """Check if another instance is already running.
        
        Returns:
            Result containing True if this is the only instance, False if another instance exists
        """
        # Create default single instance configuration
        config = SingleInstanceConfiguration()
        result = self._single_instance_port.check_existing_instance(config)
        
        if result == InstanceCheckResult.FIRST_INSTANCE:
            self.logger.log_info("First instance detected")
            return Result.success(True)
        if result == InstanceCheckResult.ALREADY_RUNNING:
            self.logger.log_info("Another instance is already running")
            activation_result = self._handle_existing_instance()
            if not activation_result.is_success:
                self.logger.log_warning(f"Failed to activate existing instance: {activation_result.get_error()}")
            return Result.success(False)
        error_msg = f"Instance check failed: {result.value}"
        self.logger.log_error(error_msg)
        return Result.failure(error_msg)
    
    def _handle_existing_instance(self) -> Result[None]:
        """Handle the case where another instance is already running."""
        try:
            # Try to notify existing instance to bring window to front
            notification_success = self._single_instance_port.notify_existing_instance("activate")
            
            if notification_success:
                self.logger.log_info("Successfully notified existing WinSTT instance")
            else:
                self.logger.log_warning("Could not notify existing instance")
            
            self.logger.log_info("An instance of WinSTT is already running. Exiting.")
            return Result.success(None)
            
        except Exception as e:
            self.logger.log_error(f"Error handling existing instance: {e}", exception=e)
            return Result.failure(f"Error handling existing instance: {e}")
    
    def create_and_show_main_window(self) -> Result[None]:
        """Create and show the main application window."""
        # Use default window ID
        window_id = "main_window"
        
        # Initialize the main window through the main window service
        init_result = self._main_window_service.initialize_window(window_id)
        if not init_result.is_success:
            self.logger.log_error(f"Failed to initialize main window: {init_result.get_error()}")
            return init_result
        
        self._main_window_id = window_id
        self.logger.log_info("Main window initialized successfully")
        
        # Show the window using window management port
        show_result = self._window_management_port.show_window(window_id)
        if not show_result.is_success:
            self.logger.log_error(f"Failed to show main window: {show_result.get_error()}")
            return show_result
        
        self.logger.log_info("Main window displayed successfully")
        return Result.success(None)
    
    def start_application_loop(self) -> int:
        """Start the application event loop."""
        return self._application_lifecycle_port.start_event_loop()
    
    def shutdown_application(self, config: ShutdownConfiguration) -> Result[None]:
        """Perform graceful application shutdown."""
        try:
            # Use provided shutdown configuration
            
            # Close main window if it exists
            if self._main_window_id:
                close_result = self._window_management_port.close_window(self._main_window_id)
                if not close_result.is_success:
                    self.logger.log_warning(f"Failed to close main window: {close_result.get_error()}")
            
            # Cleanup single instance registration
            self._single_instance_port.cleanup_instance()
            
            # Shutdown application
            shutdown_result = self._application_lifecycle_port.shutdown_application(config)
            if shutdown_result == ShutdownResult.SUCCESS:
                self.logger.log_info("Application shutdown completed")
                return Result.success(None)
            error_msg = f"Application shutdown failed: {shutdown_result.value}"
            self.logger.log_error(error_msg)
            return Result.failure(error_msg)
            
        except Exception as e:
            self.logger.log_error(f"Error during application shutdown: {e}", exception=e)
            return Result.failure(f"Error during application shutdown: {e}")