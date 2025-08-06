"""Enterprise-level IoC Container for Refactored Architecture.

This module provides a sophisticated dependency injection container with
thread-safe service resolution, circular dependency detection, automatic
constructor injection, service decorators, and fluent builder interface
for hexagonal architecture.
"""

from __future__ import annotations

import inspect
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, Generic, TypeVar
from weakref import WeakSet

from src_refactored.domain.common.result import Result

if TYPE_CHECKING:
    from collections.abc import Callable

# Type Variables
T = TypeVar("T")

# ============================================================================
# SERVICE LIFECYCLE MANAGEMENT
# ============================================================================

class ServiceLifetime(Enum):
    """Service lifetime enumeration for dependency injection."""
    SINGLETON = "singleton"
    TRANSIENT = "transient"
    SCOPED = "scoped"
    INSTANCE = "instance"


class ServiceScope(Enum):
    """Service scope enumeration for hierarchical containers."""
    APPLICATION = "application"
    SESSION = "session"
    REQUEST = "request"
    THREAD = "thread"


@dataclass
class ServiceDescriptor(Generic[T]):
    """Describes how a service should be created and managed."""
    service_type: type[T]
    implementation_type: type[T] | None = None
    factory: Callable[[], T] | None = None
    instance: T | None = None
    lifetime: ServiceLifetime = ServiceLifetime.TRANSIENT
    scope: ServiceScope = ServiceScope.APPLICATION
    tags: set[str] = field(default_factory=set)
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    
    def __post_init__(self):
        """Validate service descriptor."""
        if not self.implementation_type and not self.factory and not self.instance:
            msg = "Must provide implementation_type, factory, or instance"
            raise ValueError(msg)
        
        if self.lifetime == ServiceLifetime.INSTANCE and not self.instance:
            msg = "Instance lifetime requires an instance"
            raise ValueError(msg)


@dataclass
class ServiceRegistration:
    """Tracks service registration information."""
    descriptor: ServiceDescriptor
    registration_time: float = field(default_factory=time.time)
    access_count: int = 0
    last_accessed: float | None = None
    
    def mark_accessed(self) -> None:
        """Mark service as accessed."""
        self.access_count += 1
        self.last_accessed = time.time()


# ============================================================================
# ENTERPRISE IOC CONTAINER
# ============================================================================

class IServiceProvider:
    """Interface for service providers."""
    
    def get_service(self, service_type: type[T]) -> T:
        """Get a service instance."""
        raise NotImplementedError
    
    def try_get_service(self, service_type: type[T]) -> Result[T]:
        """Try to get a service instance."""
        raise NotImplementedError


class EnterpriseContainer(IServiceProvider):
    """Enterprise-level IoC container with advanced features.
    
    Features:
    - Thread-safe service resolution with performance monitoring
    - Multiple service lifetimes and scopes
    - Circular dependency detection with detailed diagnostics
    - Automatic constructor injection with parameter resolution
    - Service decoration and interception capabilities
    - Hierarchical container support
    - Service health monitoring and diagnostics
    - Fluent registration API
    """
    
    def __init__(self, parent: EnterpriseContainer | None = None):
        """Initialize the enterprise container.
        
        Args:
            parent: Parent container for hierarchical resolution
        """
        self._services: dict[type, ServiceRegistration] = {}
        self._singletons: dict[type, Any] = {}
        self._scoped_instances: dict[tuple[type, ServiceScope], Any] = {}
        self._lock = threading.RLock()
        self._resolution_stack: list[type] = []
        self._parent = parent
        self._children: WeakSet[EnterpriseContainer] = WeakSet()
        self._interceptors: list[Callable[[type, Any], Any]] = []
        self._performance_metrics: dict[type, list[float]] = {}
        self._health_checks: dict[type, Callable[[Any], bool]] = {}
        
        if parent:
            parent._children.add(self)
    
    def register_singleton(self, service_type: type[T], implementation: T | type[T] | Callable[[], T]) -> EnterpriseContainer:
        """Register a singleton service.
        
        Args:
            service_type: The service interface type
            implementation: Concrete implementation, type, or factory
            
        Returns:
            Self for method chaining
        """
        return self._register_service(
            service_type, 
            implementation, 
            ServiceLifetime.SINGLETON,
        )
    
    def register_transient(self, service_type: type[T], factory: type[T] | Callable[[], T]) -> EnterpriseContainer:
        """Register a transient service.
        
        Args:
            service_type: The service interface type
            factory: Implementation type or factory function
            
        Returns:
            Self for method chaining
        """
        return self._register_service(
            service_type, 
            factory, 
            ServiceLifetime.TRANSIENT,
        )
    
    def register_scoped(self, service_type: type[T], factory: type[T] | Callable[[], T], scope: ServiceScope = ServiceScope.SESSION) -> EnterpriseContainer:
        """Register a scoped service.
        
        Args:
            service_type: The service interface type
            factory: Implementation type or factory function
            scope: The service scope
            
        Returns:
            Self for method chaining
        """
        return self._register_service(
            service_type, 
            factory, 
            ServiceLifetime.SCOPED,
            scope,
        )
    
    def register_instance(self, service_type: type[T], instance: T) -> EnterpriseContainer:
        """Register a service instance.
        
        Args:
            service_type: The service interface type
            instance: The service instance
            
        Returns:
            Self for method chaining
        """
        return self._register_service(
            service_type, 
            instance, 
            ServiceLifetime.INSTANCE,
        )
    
    def _register_service(
        self, 
        service_type: type[T], 
        implementation: T | type[T] | Callable[[], T], 
        lifetime: ServiceLifetime,
        scope: ServiceScope = ServiceScope.APPLICATION,
    ) -> EnterpriseContainer:
        """Internal service registration method."""
        with self._lock:
            if isinstance(implementation, type):
                descriptor = ServiceDescriptor(
                    service_type=service_type,
                    implementation_type=implementation,
                    lifetime=lifetime,
                    scope=scope,
                )
            elif callable(implementation):
                descriptor = ServiceDescriptor(
                    service_type=service_type,
                    factory=implementation,
                    lifetime=lifetime,
                    scope=scope,
                )
            else:
                # For instance lifetime, implementation must be a concrete instance
                if callable(implementation) and not isinstance(implementation, type):
                    msg = "Instance lifetime requires a concrete instance, not a factory"
                    raise ValueError(msg)
                
                # Type assertion to help the type checker
                instance: T = implementation  # type: ignore
                
                descriptor = ServiceDescriptor(
                    service_type=service_type,
                    instance=instance,
                    lifetime=ServiceLifetime.INSTANCE,
                    scope=scope,
                )
            
            registration = ServiceRegistration(descriptor)
            self._services[service_type] = registration
            return self
    
    def get_service(self, service_type: type[T]) -> T:
        """Resolve a service instance.
        
        Args:
            service_type: The service type to resolve
            
        Returns:
            Service instance
            
        Raises:
            ServiceNotRegisteredException: If service is not registered
            CircularDependencyException: If circular dependency detected
            ServiceResolutionException: If resolution fails
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
        """Attempt to resolve a service instance.
        
        Args:
            service_type: The service type to resolve
            
        Returns:
            Result containing service instance or error
        """
        start_time = time.time()
        
        with self._lock:
            # Check for circular dependencies
            if service_type in self._resolution_stack:
                cycle = " -> ".join([t.__name__ for t in self._resolution_stack] + [service_type.__name__])
                return Result.failure(f"Circular dependency detected: {cycle}")
            
            try:
                self._resolution_stack.append(service_type)
                result = self._resolve_service(service_type)
                
                # Record performance metrics
                resolution_time = time.time() - start_time
                if service_type not in self._performance_metrics:
                    self._performance_metrics[service_type] = []
                self._performance_metrics[service_type].append(resolution_time)
                
                # Apply interceptors
                if result.is_success and result.value is not None:
                    for interceptor in self._interceptors:
                        try:
                            result = Result.success(interceptor(service_type, result.value))
                        except Exception as e:
                            return Result.failure(f"Interceptor failed: {e!s}")
                
                return result
            finally:
                self._resolution_stack.pop()
    
    def _resolve_service(self, service_type: type[T]) -> Result[T]:
        """Internal service resolution logic."""
        # Try local container first
        if service_type in self._services:
            registration = self._services[service_type]
            registration.mark_accessed()
            return self._create_service_instance(registration.descriptor)
        
        # Try parent container
        if self._parent:
            return self._parent.try_get_service(service_type)
        
        return Result.failure(f"Service {service_type.__name__} is not registered")
    
    def _create_service_instance(self, descriptor: ServiceDescriptor) -> Result[Any]:
        """Create a service instance from descriptor."""
        try:
            # Handle instance lifetime
            if descriptor.lifetime == ServiceLifetime.INSTANCE:
                return Result.success(descriptor.instance)
            
            # Handle singleton lifetime
            if descriptor.lifetime == ServiceLifetime.SINGLETON:
                if descriptor.service_type in self._singletons:
                    return Result.success(self._singletons[descriptor.service_type])
                
                instance_result = self._create_instance(descriptor)
                if instance_result.is_success:
                    self._singletons[descriptor.service_type] = instance_result.value
                return instance_result
            
            # Handle scoped lifetime
            if descriptor.lifetime == ServiceLifetime.SCOPED:
                scope_key = (descriptor.service_type, descriptor.scope)
                if scope_key in self._scoped_instances:
                    return Result.success(self._scoped_instances[scope_key])
                
                instance_result = self._create_instance(descriptor)
                if instance_result.is_success:
                    self._scoped_instances[scope_key] = instance_result.value
                return instance_result
            
            # Handle transient lifetime
            return self._create_instance(descriptor)
            
        except Exception as e:
            return Result.failure(f"Failed to create service instance: {e!s}")
    
    def _create_instance(self, descriptor: ServiceDescriptor) -> Result[Any]:
        """Create a service instance from descriptor."""
        try:
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
            if service_type in self._services:
                return True
            return self._parent.is_registered(service_type) if self._parent else False
    
    def clear_scoped(self, scope: ServiceScope | None = None) -> None:
        """Clear scoped service instances.
        
        Args:
            scope: Specific scope to clear, or None to clear all scopes
        """
        with self._lock:
            if scope is None:
                self._scoped_instances.clear()
            else:
                keys_to_remove = [key for key in self._scoped_instances if key[1] == scope]
                for key in keys_to_remove:
                    del self._scoped_instances[key]
    
    def add_interceptor(self, interceptor: Callable[[type, Any], Any]) -> None:
        """Add a service interceptor.
        
        Args:
            interceptor: Function that takes (service_type, instance) and returns modified instance
        """
        with self._lock:
            self._interceptors.append(interceptor)
    
    def add_health_check(self, service_type: type, health_check: Callable[[Any], bool]) -> None:
        """Add a health check for a service type.
        
        Args:
            service_type: The service type to monitor
            health_check: Function that takes service instance and returns health status
        """
        with self._lock:
            self._health_checks[service_type] = health_check
    
    def get_performance_metrics(self, service_type: type) -> dict[str, Any]:
        """Get performance metrics for a service type.
        
        Args:
            service_type: The service type to get metrics for
            
        Returns:
            Dictionary containing performance metrics
        """
        with self._lock:
            if service_type not in self._performance_metrics:
                return {}
            
            times = self._performance_metrics[service_type]
            return {
                "total_resolutions": len(times),
                "average_time": sum(times) / len(times),
                "min_time": min(times),
                "max_time": max(times),
                "last_resolution_time": times[-1] if times else None,
            }
    
    def get_registrations(self) -> dict[type, ServiceRegistration]:
        """Get all service registrations (for debugging)."""
        with self._lock:
            return self._services.copy()
    
    def create_child_container(self) -> EnterpriseContainer:
        """Create a child container for hierarchical resolution."""
        return EnterpriseContainer(parent=self)


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

def injectable(lifetime: ServiceLifetime = ServiceLifetime.TRANSIENT, scope: ServiceScope = ServiceScope.APPLICATION):
    """Decorator to mark a class as injectable with specified lifetime and scope.
    
    Usage:
        @injectable(ServiceLifetime.SINGLETON, ServiceScope.APPLICATION)
        class MyService:
            pass
    """
    def decorator(cls):
        cls._service_lifetime = lifetime
        cls._service_scope = scope
        return cls
    return decorator


def service_interface(interface_type: type):
    """Decorator to specify the service interface for a class.
    
    Usage:
        @service_interface(IMyService)
        class MyService:
            pass
    """
    def decorator(cls):
        cls._service_interface = interface_type
        return cls
    return decorator


def tagged(*tags: str):
    """Decorator to add tags to a service.
    
    Usage:
        @tagged("cache", "fast")
        class CacheService:
            pass
    """
    def decorator(cls):
        cls._service_tags = set(tags)
        return cls
    return decorator


# ============================================================================
# CONTAINER BUILDER
# ============================================================================

class EnterpriseContainerBuilder:
    """Builder for configuring the enterprise container with fluent interface."""
    
    def __init__(self, parent: EnterpriseContainer | None = None):
        """Initialize the builder.
        
        Args:
            parent: Parent container for hierarchical resolution
        """
        self._container = EnterpriseContainer(parent)
    
    def add_singleton(self, service_type: type[T], implementation: T | type[T] | Callable[[], T]) -> EnterpriseContainerBuilder:
        """Add a singleton service."""
        self._container.register_singleton(service_type, implementation)
        return self
    
    def add_transient(self, service_type: type[T], factory: type[T] | Callable[[], T]) -> EnterpriseContainerBuilder:
        """Add a transient service."""
        self._container.register_transient(service_type, factory)
        return self
    
    def add_scoped(self, service_type: type[T], factory: type[T] | Callable[[], T], scope: ServiceScope = ServiceScope.SESSION) -> EnterpriseContainerBuilder:
        """Add a scoped service."""
        self._container.register_scoped(service_type, factory, scope)
        return self
    
    def add_instance(self, service_type: type[T], instance: T) -> EnterpriseContainerBuilder:
        """Add a service instance."""
        self._container.register_instance(service_type, instance)
        return self
    
    def add_interceptor(self, interceptor: Callable[[type, Any], Any]) -> EnterpriseContainerBuilder:
        """Add a service interceptor."""
        self._container.add_interceptor(interceptor)
        return self
    
    def auto_register_from_module(self, module) -> EnterpriseContainerBuilder:
        """Automatically register services from a module based on decorators."""
        for _name, obj in inspect.getmembers(module):
            if inspect.isclass(obj) and hasattr(obj, "_service_lifetime"):
                interface = getattr(obj, "_service_interface", obj)
                lifetime = obj._service_lifetime
                scope = getattr(obj, "_service_scope", ServiceScope.APPLICATION)
                
                if lifetime == ServiceLifetime.SINGLETON:
                    self._container.register_singleton(interface, obj)
                elif lifetime == ServiceLifetime.TRANSIENT:
                    self._container.register_transient(interface, obj)
                elif lifetime == ServiceLifetime.SCOPED:
                    self._container.register_scoped(interface, obj, scope)
        
        return self
    
    def build(self) -> EnterpriseContainer:
        """Build the configured container."""
        return self._container


__all__ = [
    "CircularDependencyException",
    "EnterpriseContainer",
    "EnterpriseContainerBuilder",
    "IServiceProvider",
    "ServiceDescriptor",
    "ServiceLifetime",
    "ServiceNotRegisteredException",
    "ServiceRegistration",
    "ServiceResolutionException",
    "ServiceScope",
    "injectable",
    "service_interface",
    "tagged",
]