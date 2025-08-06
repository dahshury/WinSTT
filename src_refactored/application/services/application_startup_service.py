"""Application Startup Service.

This module provides the application startup service that coordinates
the startup workflow and manages the application lifecycle.
"""

from typing import Protocol

from src_refactored.domain.application_lifecycle.ports.application_lifecycle_port import (
    IApplicationLifecyclePort,
)
from src_refactored.domain.common.ports.logger_port import ILoggerPort
from src_refactored.domain.common.result import Result
from src_refactored.domain.system_integration.ports.single_instance_port import ISingleInstancePort
from src_refactored.domain.window_management.ports.window_management_port import (
    IWindowManagementPort,
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
    
    def shutdown_application(self) -> Result[None]:
        """Perform graceful application shutdown."""
        ...


class ApplicationStartupService:
    """Service for coordinating application startup workflow."""
    
    def __init__(
        self,
        application_lifecycle_port: IApplicationLifecyclePort,
        window_management_port: IWindowManagementPort,
        single_instance_port: ISingleInstancePort,
        logger: ILoggerPort,
    ):
        self.logger = logger
        self._application_lifecycle_port = application_lifecycle_port
        self._window_management_port = window_management_port
        self._single_instance_port = single_instance_port
        self._main_window = None
    
    def initialize_application(self) -> Result[None]:
        """Initialize the application with proper configuration."""
        result = self._application_lifecycle_port.initialize_application()
        if result.is_success:
            self.logger.info("Application initialized successfully")
        else:
            self.logger.error(f"Failed to initialize application: {result.error()}")
        return result
    
    def check_single_instance(self) -> Result[bool]:
        """Check if another instance is already running.
        
        Returns:
            Result containing True if this is the only instance, False if another instance exists
        """
        result = self._single_instance_port.check_single_instance()
        if not result.is_success:
            return result
            
        is_single = result.value()
        if not is_single:
            activation_result = self._handle_existing_instance()
            if not activation_result.is_success:
                self.logger.warning(f"Failed to activate existing instance: {activation_result.error()}")
        
        return Result.success(is_single)
    
    def _handle_existing_instance(self) -> Result[None]:
        """Handle the case where another instance is already running."""
        try:
            # Attempt to activate existing window
            activation_result = self._window_management_port.activate_existing_window()
            
            if activation_result.is_success:
                self.logger.info("Successfully activated existing WinSTT instance")
            else:
                self.logger.warning(f"Could not activate existing instance: {activation_result.error()}")
            
            self.logger.info("An instance of WinSTT is already running. Exiting.")
            return Result.success(None)
            
        except Exception as e:
            self.logger.exception(f"Error handling existing instance: {e}")
            return Result.failure(f"Error handling existing instance: {e}")
    
    def create_and_show_main_window(self) -> Result[None]:
        """Create and show the main application window."""
        # Create main window
        create_result = self._window_management_port.create_main_window()
        if not create_result.is_success:
            self.logger.error(f"Failed to create main window: {create_result.error()}")
            return create_result
        
        self._main_window = create_result.value()
        self.logger.info("Main window created successfully")
        
        # Show the window
        show_result = self._window_management_port.show_main_window()
        if not show_result.is_success:
            self.logger.error(f"Failed to show main window: {show_result.error()}")
            return show_result
        
        return Result.success(None)
    
    def start_application_loop(self) -> int:
        """Start the application event loop."""
        return self._application_lifecycle_port.run_application()
    
    def shutdown_application(self) -> Result[None]:
        """Perform graceful application shutdown."""
        try:
            # Close main window if it exists
            if self._main_window:
                close_result = self._window_management_port.close_main_window()
                if not close_result.is_success:
                    self.logger.warning(f"Failed to close main window: {close_result.error()}")
            
            # Shutdown application
            shutdown_result = self._application_lifecycle_port.shutdown_application()
            if shutdown_result.is_success:
                self.logger.info("Application shutdown completed")
            else:
                self.logger.error(f"Application shutdown failed: {shutdown_result.error()}")
            
            return shutdown_result
            
        except Exception as e:
            self.logger.exception(f"Error during application shutdown: {e}")
            return Result.failure(f"Error during application shutdown: {e}")