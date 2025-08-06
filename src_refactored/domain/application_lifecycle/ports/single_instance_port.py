"""Single instance port for abstracting platform-specific instance checking."""

from abc import ABC, abstractmethod

from src_refactored.domain.application_lifecycle.entities.single_instance_configuration import (
    SingleInstanceConfiguration,
)
from src_refactored.domain.application_lifecycle.value_objects.instance_check_result import (
    InstanceCheckResult,
)


class SingleInstancePort(ABC):
    """Port for managing single instance application behavior.
    
    This port abstracts platform-specific mechanisms for ensuring only one
    instance of the application runs at a time, removing direct dependencies
    on system-specific APIs like sockets or named pipes.
    """

    @abstractmethod
    def check_existing_instance(self, config: SingleInstanceConfiguration) -> InstanceCheckResult:
        """Check if another instance of the application is already running.
        
        Args:
            config: Configuration for instance checking
            
        Returns:
            Result indicating if an existing instance was found
        """

    @abstractmethod
    def register_instance(self, config: SingleInstanceConfiguration) -> bool:
        """Register this instance as the active application instance.
        
        Args:
            config: Configuration for instance registration
            
        Returns:
            True if registration was successful, False otherwise
        """

    @abstractmethod
    def cleanup_instance(self) -> None:
        """Clean up instance registration resources.
        
        This should be called during application shutdown to ensure
        proper cleanup of any system resources used for instance tracking.
        """

    @abstractmethod
    def notify_existing_instance(self, message: str | None = None) -> bool:
        """Send a notification to an existing application instance.
        
        Args:
            message: Optional message to send to the existing instance
            
        Returns:
            True if notification was sent successfully, False otherwise
        """

    @abstractmethod
    def is_instance_registered(self) -> bool:
        """Check if this instance is currently registered.
        
        Returns:
            True if this instance is registered, False otherwise
        """
