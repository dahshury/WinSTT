"""Application lifecycle port for abstracting UI framework dependencies."""

from abc import ABC, abstractmethod

from src_refactored.domain.application_lifecycle.entities.shutdown_configuration import (
    ShutdownConfiguration,
)
from src_refactored.domain.application_lifecycle.entities.startup_configuration import (
    StartupConfiguration,
)
from src_refactored.domain.application_lifecycle.value_objects.shutdown_result import ShutdownResult
from src_refactored.domain.application_lifecycle.value_objects.startup_result import StartupResult


class ApplicationLifecyclePort(ABC):
    """Port for managing application lifecycle operations.
    
    This port abstracts the underlying UI framework (PyQt) from the domain layer,
    allowing the application layer to manage startup and shutdown without
    direct dependencies on UI framework classes.
    """

    @abstractmethod
    def initialize_application(self, config: StartupConfiguration) -> StartupResult:
        """Initialize the application framework.
        
        Args:
            config: Configuration for application startup
            
        Returns:
            Result indicating success or failure of initialization
        """

    @abstractmethod
    def start_event_loop(self) -> int:
        """Start the main application event loop.
        
        Returns:
            Exit code from the application
        """

    @abstractmethod
    def shutdown_application(self, config: ShutdownConfiguration) -> ShutdownResult:
        """Shutdown the application gracefully.
        
        Args:
            config: Configuration for application shutdown
            
        Returns:
            Result indicating success or failure of shutdown
        """

    @abstractmethod
    def request_exit(self, exit_code: int = 0) -> None:
        """Request application exit with specified code.
        
        Args:
            exit_code: Exit code to return to the system
        """

    @abstractmethod
    def is_running(self) -> bool:
        """Check if the application is currently running.
        
        Returns:
            True if application is running, False otherwise
        """

    @abstractmethod
    def get_command_line_arguments(self) -> list[str]:
        """Get command line arguments passed to the application.
        
        Returns:
            List of command line arguments
        """

    @abstractmethod
    def set_application_metadata(self, name: str, version: str, organization: str) -> None:
        """Set application metadata.
        
        Args:
            name: Application name
            version: Application version
            organization: Organization name
        """

    @abstractmethod
    def run_application(self) -> int:
        """Run the application event loop.
        
        Returns:
            Exit code from the application
        """
