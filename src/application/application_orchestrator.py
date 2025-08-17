"""Application Orchestrator for WinSTT

This module provides a simplified application orchestrator that delegates
to application services for the actual workflow coordination.
"""

from typing import Any

from src.domain.common.ports.logger_port import ILoggerPort
from src.domain.common.result import Result

from .services.application_startup_service import IApplicationStartupService


class ApplicationOrchestrator:
    """Simplified orchestrator that delegates to application services."""
    
    def __init__(self, startup_service: IApplicationStartupService, logger: ILoggerPort):
        self.logger = logger
        self._startup_service = startup_service
        

    
    def start_application(self) -> int:
        """Start the main application workflow.
        
        Returns:
            Exit code for the application
        """
        try:
            # Initialize application
            init_result = self._startup_service.initialize_application()
            if not init_result.is_success:
                self.logger.error(f"Application initialization failed: {init_result.error or 'Unknown error'}")
                return 1
            
            # Check for single instance
            instance_result = self._startup_service.check_single_instance()
            if not instance_result.is_success:
                self.logger.error(f"Single instance check failed: {instance_result.error or 'Unknown error'}")
                return 1
                
            if not instance_result.value:
                return 0  # Another instance exists, exit gracefully
            
            # Create and show main window
            window_result = self._startup_service.create_and_show_main_window()
            if not window_result.is_success:
                self.logger.error(f"Main window creation failed: {window_result.error or 'Unknown error'}")
                return 1
            
            self.logger.info("WinSTT application started successfully")
            
            # Start the application event loop
            return self._startup_service.start_application_loop()
            
        except Exception as e:
            self.logger.exception(f"Failed to start application: {e}")
            return 1
    
    def shutdown_application(self, config: Any = None) -> Result[None]:
        """Perform graceful application shutdown."""
        return self._startup_service.shutdown_application(config)


def create_application_orchestrator(startup_service: IApplicationStartupService, logger: ILoggerPort) -> ApplicationOrchestrator:
    """Factory function to create an ApplicationOrchestrator instance."""
    return ApplicationOrchestrator(startup_service, logger)