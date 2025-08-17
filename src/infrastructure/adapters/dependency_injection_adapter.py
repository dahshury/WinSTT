"""Simple Dependency Injection Container Implementation."""

from collections.abc import Callable
from typing import Any, TypeVar

from src.domain.common.ports.dependency_injection_port import (
    DIContainerBuilder,
    DILifetime,
    IDependencyContainer,
    ServiceNotRegisteredException,
)

T = TypeVar("T")


class SimpleDIContainer(IDependencyContainer):
    """Simple dependency injection container implementation."""
    
    def __init__(self):
        """Initialize the container."""
        self._services: dict[type, dict[str, Any]] = {}
        self._instances: dict[type, Any] = {}
        self._parent: SimpleDIContainer | None = None
    
    def register(
        self, 
        service_type: type[T], 
        implementation: type[T] | Callable[[], T],
        lifetime: str = DILifetime.TRANSIENT,
    ) -> None:
        """Register a service with its implementation."""
        self._services[service_type] = {
            "implementation": implementation,
            "lifetime": lifetime,
        }
    
    def register_instance(self, service_type: type[T], instance: T) -> None:
        """Register a service instance."""
        self._instances[service_type] = instance
        self._services[service_type] = {
            "implementation": lambda: instance,
            "lifetime": DILifetime.SINGLETON,
        }
    
    def resolve(self, service_type: type[T]) -> T:
        """Resolve a service instance."""
        # Check if instance already exists for singleton
        if service_type in self._instances:
            return self._instances[service_type]
        
        # Check if service is registered
        if service_type not in self._services:
            if self._parent:
                return self._parent.resolve(service_type)
            raise ServiceNotRegisteredException(service_type)
        
        service_info = self._services[service_type]
        implementation = service_info["implementation"]
        lifetime = service_info["lifetime"]
        
        # Create instance
        if callable(implementation):
            if hasattr(implementation, "__annotations__"):
                # It's a class, try to instantiate with dependencies
                instance = self._create_instance(implementation)
            else:
                # It's a factory function
                instance = implementation()
        else:
            instance = implementation
        
        # Store singleton instances
        if lifetime == DILifetime.SINGLETON:
            self._instances[service_type] = instance
        
        return instance
    
    def is_registered(self, service_type: type[T]) -> bool:
        """Check if a service is registered."""
        if service_type in self._services:
            return True
        if self._parent:
            return self._parent.is_registered(service_type)
        return False
    
    def create_scope(self) -> "IDependencyContainer":
        """Create a new dependency scope."""
        scoped_container = SimpleDIContainer()
        scoped_container._parent = self
        return scoped_container
    
    def _create_instance(self, implementation_type: type[T]) -> T:
        """Create an instance by resolving dependencies."""
        # Simple implementation - just try to call constructor
        # In a full implementation, you would inspect constructor parameters
        # and resolve them from the container
        try:
            return implementation_type()
        except TypeError:
            # If constructor requires parameters, we can't auto-resolve yet
            # This would need more sophisticated reflection
            msg = f"Cannot auto-resolve dependencies for {implementation_type.__name__}"
            raise ValueError(msg)


class SimpleDIContainerBuilder(DIContainerBuilder):
    """Simple dependency injection container builder."""
    
    def __init__(self):
        """Initialize the builder."""
        self._container = SimpleDIContainer()
    
    def add_singleton(self, service_type: type[T], implementation: type[T] | Callable[[], T]) -> "DIContainerBuilder":
        """Add a singleton service."""
        self._container.register(service_type, implementation, DILifetime.SINGLETON)
        return self
    
    def add_transient(self, service_type: type[T], implementation: type[T] | Callable[[], T]) -> "DIContainerBuilder":
        """Add a transient service."""
        self._container.register(service_type, implementation, DILifetime.TRANSIENT)
        return self
    
    def add_scoped(self, service_type: type[T], implementation: type[T] | Callable[[], T]) -> "DIContainerBuilder":
        """Add a scoped service."""
        self._container.register(service_type, implementation, DILifetime.SCOPED)
        return self
    
    def add_instance(self, service_type: type[T], instance: T) -> "DIContainerBuilder":
        """Add a service instance."""
        self._container.register_instance(service_type, instance)
        return self
    
    def build(self) -> IDependencyContainer:
        """Build the dependency container."""
        return self._container
