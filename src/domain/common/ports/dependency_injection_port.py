"""Dependency Injection Port for proper DI container abstraction."""

from abc import ABC, abstractmethod
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")


class DILifetime:
    """Dependency injection lifetime management."""
    
    SINGLETON = "singleton"
    TRANSIENT = "transient"
    SCOPED = "scoped"


class IDependencyContainer(ABC):
    """Port interface for dependency injection container."""
    
    @abstractmethod
    def register(
        self, 
        service_type: type[T], 
        implementation: type[T] | Callable[[], T],
        lifetime: str = DILifetime.TRANSIENT,
    ) -> None:
        """Register a service with its implementation.
        
        Args:
            service_type: The service interface/type
            implementation: The implementation type or factory function
            lifetime: Service lifetime (singleton, transient, scoped)
        """
        ...
    
    @abstractmethod
    def register_instance(self, service_type: type[T], instance: T) -> None:
        """Register a service instance.
        
        Args:
            service_type: The service interface/type
            instance: The service instance
        """
        ...
    
    @abstractmethod
    def resolve(self, service_type: type[T]) -> T:
        """Resolve a service instance.
        
        Args:
            service_type: The service type to resolve
            
        Returns:
            Service instance
            
        Raises:
            ServiceNotRegisteredException: If service is not registered
        """
        ...
    
    @abstractmethod
    def is_registered(self, service_type: type[T]) -> bool:
        """Check if a service is registered.
        
        Args:
            service_type: The service type to check
            
        Returns:
            True if registered, False otherwise
        """
        ...
    
    @abstractmethod
    def create_scope(self) -> "IDependencyContainer":
        """Create a new dependency scope.
        
        Returns:
            New scoped container
        """
        ...


class ServiceNotRegisteredException(Exception):
    """Exception raised when a service is not registered."""
    
    def __init__(self, service_type: type):
        """Initialize the exception.
        
        Args:
            service_type: The service type that was not found
        """
        super().__init__(f"Service '{service_type.__name__}' is not registered")
        self.service_type = service_type


class DIContainerBuilder(ABC):
    """Builder interface for dependency injection container."""
    
    @abstractmethod
    def add_singleton(self, service_type: type[T], implementation: type[T] | Callable[[], T]) -> "DIContainerBuilder":
        """Add a singleton service."""
        ...
    
    @abstractmethod
    def add_transient(self, service_type: type[T], implementation: type[T] | Callable[[], T]) -> "DIContainerBuilder":
        """Add a transient service."""
        ...
    
    @abstractmethod
    def add_scoped(self, service_type: type[T], implementation: type[T] | Callable[[], T]) -> "DIContainerBuilder":
        """Add a scoped service."""
        ...
    
    @abstractmethod
    def add_instance(self, service_type: type[T], instance: T) -> "DIContainerBuilder":
        """Add a service instance."""
        ...
    
    @abstractmethod
    def build(self) -> IDependencyContainer:
        """Build the dependency container."""
        ...
