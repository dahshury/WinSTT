"""
Dependency Injection Container for UI Layer

This module provides a sophisticated IoC container for managing dependencies
throughout the UI layer, following industry best practices and design patterns.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, Generic

from .abstractions import IServiceProvider, Result, T

if TYPE_CHECKING:
    from collections.abc import Callable

# ============================================================================
# SERVICE LIFECYCLE MANAGEMENT
# ============================================================================

class ServiceLifetime(Enum):
    """Service lifetime enumeration."""
    SINGLETON = "singleton"
    TRANSIENT = "transient"
    SCOPED = "scoped"

@dataclass
class ServiceDescriptor(Generic[T]):
    """Describes how a service should be created and managed."""
    service_type: type[T]
    implementation_type: type[T] | None = None
    factory: Callable[[], T] | None = None
    instance: T | None = None
    lifetime: ServiceLifetime = ServiceLifetime.TRANSIENT
    
    def __post_init__(self):
        """Validate service descriptor."""
        if not self.implementation_type and not self.factory and not self.instance:
            msg = "Must provide implementation_type, factory, or instance"
            raise ValueError(msg)

# ============================================================================
# DEPENDENCY INJECTION CONTAINER
# ============================================================================

class UIContainer(IServiceProvider):
    """
    Professional IoC container for the UI layer.
    
    Features:
    - Thread-safe service resolution
    - Multiple service lifetimes (Singleton, Transient, Scoped)
    - Factory-based service creation
    - Circular dependency detection
    - Automatic constructor injection
    - Service decoration/interception
    """
    
    def __init__(self):
        self._services: dict[type, ServiceDescriptor] = {}
        self._singletons: dict[type, Any] = {}
        self._scoped_instances: dict[type, Any] = {}
        self._lock = threading.RLock()
        self._resolution_stack: list[type] = []
    
    def register_singleton(self, service_type: type[T], implementation: T | type[T] | Callable[[], T]) -> UIContainer:
        """
        Register a singleton service.
        
        Args:
            service_type: The service interface type
            implementation: Concrete implementation, type, or factory
            
        Returns:
            Self for method chaining
        """
        with self._lock:
            if isinstance(implementation, type):
                descriptor = ServiceDescriptor(
                    service_type=service_type,
                    implementation_type=implementation,
                    lifetime=ServiceLifetime.SINGLETON,
                )
            elif callable(implementation):
                descriptor = ServiceDescriptor(
                    service_type=service_type,
                    factory=implementation,
                    lifetime=ServiceLifetime.SINGLETON,
                )
            else:
                descriptor = ServiceDescriptor(
                    service_type=service_type,
                    instance=implementation,
                    lifetime=ServiceLifetime.SINGLETON,
                )
            
            self._services[service_type] = descriptor
            return self
    
    def register_transient(self, service_type: type[T], factory: type[T] | Callable[[], T]) -> UIContainer:
        """
        Register a transient service.
        
        Args:
            service_type: The service interface type
            factory: Implementation type or factory function
            
        Returns:
            Self for method chaining
        """
        with self._lock:
            if isinstance(factory, type):
                descriptor = ServiceDescriptor(
                    service_type=service_type,
                    implementation_type=factory,
                    lifetime=ServiceLifetime.TRANSIENT,
                )
            else:
                descriptor = ServiceDescriptor(
                    service_type=service_type,
                    factory=factory,
                    lifetime=ServiceLifetime.TRANSIENT,
                )
            
            self._services[service_type] = descriptor
            return self
    
    def register_scoped(self, service_type: type[T], factory: type[T] | Callable[[], T]) -> UIContainer:
        """
        Register a scoped service (per UI session/context).
        
        Args:
            service_type: The service interface type
            factory: Implementation type or factory function
            
        Returns:
            Self for method chaining
        """
        with self._lock:
            if isinstance(factory, type):
                descriptor = ServiceDescriptor(
                    service_type=service_type,
                    implementation_type=factory,
                    lifetime=ServiceLifetime.SCOPED,
                )
            else:
                descriptor = ServiceDescriptor(
                    service_type=service_type,
                    factory=factory,
                    lifetime=ServiceLifetime.SCOPED,
                )
            
            self._services[service_type] = descriptor
            return self
    
    def get_service(self, service_type: type[T]) -> T:
        """
        Resolve a service instance.
        
        Args:
            service_type: The service type to resolve
            
        Returns:
            Service instance
            
        Raises:
            ServiceNotRegisteredException: If service is not registered
            CircularDependencyException: If circular dependency detected
        """
        result = self.try_get_service(service_type)
        if not result.is_success:
            msg = f"Failed to resolve {service_type.__name__}: {result.error}"
            raise ServiceResolutionException(msg)
        
        if result.value is None:
            msg = f"Service resolution returned None for {service_type.__name__}"
            raise ServiceResolutionException(msg)
        
        return result.value
    
    def try_get_service(self, service_type: type[T]) -> Result[T]:
        """
        Attempt to resolve a service instance.
        
        Args:
            service_type: The service type to resolve
            
        Returns:
            Result containing service instance or error
        """
        with self._lock:
            # Check for circular dependencies
            if service_type in self._resolution_stack:
                cycle = " -> ".join([t.__name__ for t in self._resolution_stack] + [service_type.__name__])
                return Result.failure(f"Circular dependency detected: {cycle}")
            
            try:
                self._resolution_stack.append(service_type)
                return self._resolve_service(service_type)
            finally:
                self._resolution_stack.pop()
    
    def _resolve_service(self, service_type: type[T]) -> Result[T]:
        """Internal service resolution logic."""
        if service_type not in self._services:
            return Result.failure(f"Service {service_type.__name__} is not registered")
        
        descriptor = self._services[service_type]
        
        # Handle singleton lifetime
        if descriptor.lifetime == ServiceLifetime.SINGLETON:
            if service_type in self._singletons:
                return Result.success(self._singletons[service_type])
            
            instance_result = self._create_instance(descriptor)
            if instance_result.is_success:
                self._singletons[service_type] = instance_result.value
            return instance_result
        
        # Handle scoped lifetime
        if descriptor.lifetime == ServiceLifetime.SCOPED:
            if service_type in self._scoped_instances:
                return Result.success(self._scoped_instances[service_type])
            
            instance_result = self._create_instance(descriptor)
            if instance_result.is_success:
                self._scoped_instances[service_type] = instance_result.value
            return instance_result
        
        # Handle transient lifetime
        return self._create_instance(descriptor)
    
    def _create_instance(self, descriptor: ServiceDescriptor) -> Result[Any]:
        """Create a service instance from descriptor."""
        try:
            # Use existing instance
            if descriptor.instance is not None:
                return Result.success(descriptor.instance)
            
            # Use factory function
            if descriptor.factory is not None:
                instance = descriptor.factory()
                return Result.success(instance)
            
            # Use implementation type with constructor injection
            if descriptor.implementation_type is not None:
                return self._create_with_injection(descriptor.implementation_type)
            
            return Result.failure("No creation method available")
            
        except Exception as e:
            return Result.failure(f"Failed to create instance: {e!s}")
    
    def _create_with_injection(self, implementation_type: type[T]) -> Result[T]:
        """Create instance with automatic constructor injection."""
        import inspect
        
        try:
            # Get constructor parameters
            constructor = implementation_type.__init__
            signature = inspect.signature(constructor)
            
            # Build constructor arguments
            kwargs = {}
            for param_name, param in signature.parameters.items():
                if param_name == "self":
                    continue
                
                # Try to resolve parameter type
                if param.annotation != inspect.Parameter.empty:
                    param_result = self.try_get_service(param.annotation)
                    if param_result.is_success:
                        kwargs[param_name] = param_result.value
                    elif param.default == inspect.Parameter.empty:
                        return Result.failure(f"Cannot resolve required parameter '{param_name}' of type {param.annotation}")
            
            # Create instance
            instance = implementation_type(**kwargs)
            return Result.success(instance)
            
        except Exception as e:
            return Result.failure(f"Constructor injection failed: {e!s}")
    
    def is_registered(self, service_type: type) -> bool:
        """Check if a service type is registered."""
        with self._lock:
            return service_type in self._services
    
    def clear_scoped(self) -> None:
        """Clear all scoped service instances."""
        with self._lock:
            self._scoped_instances.clear()
    
    def get_registrations(self) -> dict[type, ServiceDescriptor]:
        """Get all service registrations (for debugging)."""
        with self._lock:
            return self._services.copy()

# ============================================================================
# SERVICE RESOLUTION EXCEPTIONS
# ============================================================================

class ServiceResolutionException(Exception):
    """Raised when service resolution fails."""

class CircularDependencyException(ServiceResolutionException):
    """Raised when circular dependency is detected."""

class ServiceNotRegisteredException(ServiceResolutionException):
    """Raised when requested service is not registered."""

# ============================================================================
# SERVICE DECORATORS
# ============================================================================

def injectable(lifetime: ServiceLifetime = ServiceLifetime.TRANSIENT):
    """
    Decorator to mark a class as injectable with specified lifetime.
    
    Usage:
        @injectable(ServiceLifetime.SINGLETON)
        class MyService:
            pass
    """
    def decorator(cls):
        cls._service_lifetime = lifetime
        return cls
    return decorator

def service_interface(interface_type: type):
    """
    Decorator to specify the service interface for a class.
    
    Usage:
        @service_interface(IMyService)
        class MyService:
            pass
    """
    def decorator(cls):
        cls._service_interface = interface_type
        return cls
    return decorator

# ============================================================================
# CONTAINER BUILDER
# ============================================================================

class UIContainerBuilder:
    """
    Builder for configuring the UI container with fluent interface.
    """
    
    def __init__(self):
        self._container = UIContainer()
    
    def add_singleton(self, service_type: type[T], implementation: T | type[T] | Callable[[], T]) -> UIContainerBuilder:
        """Add a singleton service."""
        self._container.register_singleton(service_type, implementation)
        return self
    
    def add_transient(self, service_type: type[T], factory: type[T] | Callable[[], T]) -> UIContainerBuilder:
        """Add a transient service."""
        self._container.register_transient(service_type, factory)
        return self
    
    def add_scoped(self, service_type: type[T], factory: type[T] | Callable[[], T]) -> UIContainerBuilder:
        """Add a scoped service."""
        self._container.register_scoped(service_type, factory)
        return self
    
    def auto_register_from_module(self, module) -> UIContainerBuilder:
        """Automatically register services from a module based on decorators."""
        import inspect
        
        for _name, obj in inspect.getmembers(module):
            if inspect.isclass(obj) and hasattr(obj, "_service_lifetime"):
                interface = getattr(obj, "_service_interface", obj)
                lifetime = obj._service_lifetime
                
                if lifetime == ServiceLifetime.SINGLETON:
                    self._container.register_singleton(interface, obj)
                elif lifetime == ServiceLifetime.TRANSIENT:
                    self._container.register_transient(interface, obj)
                elif lifetime == ServiceLifetime.SCOPED:
                    self._container.register_scoped(interface, obj)
        
        return self
    
    def build(self) -> UIContainer:
        """Build the configured container."""
        return self._container

__all__ = [
    "CircularDependencyException",
    "ServiceDescriptor",
    "ServiceLifetime",
    "ServiceNotRegisteredException",
    "ServiceResolutionException",
    "UIContainer",
    "UIContainerBuilder",
    "injectable",
    "service_interface",
] 