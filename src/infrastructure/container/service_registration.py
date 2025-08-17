"""Service Registration for WinSTT

This module provides automatic service registration using decorators and reflection,
integrating with the existing UIContainer infrastructure.
"""

import importlib
import inspect
from collections.abc import Callable
from enum import Enum
from pathlib import Path
from typing import TypeVar

from src.domain.common.ports.logger_port import ILoggerPort

# The refactored container exposes EnterpriseContainerBuilder; map to that for registration
from ...presentation.core.container import EnterpriseContainerBuilder as UIContainerBuilder

T = TypeVar("T")


class ServiceLifetime(Enum):
    """Service lifetime enumeration."""
    SINGLETON = "singleton"
    TRANSIENT = "transient"
    SCOPED = "scoped"


class ServiceRegistrationError(Exception):
    """Base exception for service registration errors."""


class ServiceMetadata:
    """Metadata for registered services."""
    
    def __init__(
        self,
        service_type: type,
        implementation_type: type | None = None,
        lifetime: ServiceLifetime = ServiceLifetime.SINGLETON,
        factory: Callable | None = None,
        dependencies: list[type] | None = None,
        tags: list[str] | None = None,
    ):
        self.service_type = service_type
        self.implementation_type = implementation_type or service_type
        self.lifetime = lifetime
        self.factory = factory
        self.dependencies = dependencies or []
        self.tags = tags or []
        self.registration_order = 0
    
    def __repr__(self) -> str:
        return f"ServiceMetadata({self.service_type.__name__}, {self.lifetime.value})"


class ServiceRegistry:
    """Registry for managing service metadata and registration."""
    
    def __init__(self, logger: ILoggerPort | None = None):
        self.logger = logger
        self._services: dict[type, ServiceMetadata] = {}
        self._named_services: dict[str, ServiceMetadata] = {}
        self._registration_counter = 0
    
    def register_service(
        self,
        service_type: type[T],
        implementation_type: type[T] | None = None,
        lifetime: ServiceLifetime = ServiceLifetime.SINGLETON,
        factory: Callable[[], T] | None = None,
        dependencies: list[type] | None = None,
        tags: list[str] | None = None,
        name: str | None = None,
    ) -> None:
        """Register a service with metadata.
        
        Args:
            service_type: Type of the service interface
            implementation_type: Type of the implementation (defaults to service_type)
            lifetime: Service lifetime
            factory: Optional factory function
            dependencies: List of dependency types
            tags: List of tags for categorization
            name: Optional name for named registration
        """
        metadata = ServiceMetadata(
            service_type=service_type,
            implementation_type=implementation_type,
            lifetime=lifetime,
            factory=factory,
            dependencies=dependencies,
            tags=tags,
        )
        metadata.registration_order = self._registration_counter
        self._registration_counter += 1
        
        self._services[service_type] = metadata
        
        if name:
            self._named_services[name] = metadata
        
        if self.logger:
            self.logger.debug(f"Registered service: {service_type.__name__} ({lifetime.value})")
    
    def get_service_metadata(self, service_type: type[T]) -> ServiceMetadata | None:
        """Get metadata for a service type."""
        return self._services.get(service_type)
    
    def get_named_service_metadata(self, name: str) -> ServiceMetadata | None:
        """Get metadata for a named service."""
        return self._named_services.get(name)
    
    def get_services_by_tag(self, tag: str) -> list[ServiceMetadata]:
        """Get all services with a specific tag."""
        return [metadata for metadata in self._services.values() if tag in metadata.tags]
    
    def get_all_services(self) -> list[ServiceMetadata]:
        """Get all registered services ordered by registration."""
        return sorted(self._services.values(), key=lambda m: m.registration_order)
    
    def is_registered(self, service_type: type[T]) -> bool:
        """Check if a service type is registered."""
        return service_type in self._services
    
    def clear(self) -> None:
        """Clear all registered services."""
        self._services.clear()
        self._named_services.clear()
        self._registration_counter = 0
        if self.logger:
            self.logger.debug("Service registry cleared")


# Global service registry
_global_registry = ServiceRegistry()


def get_global_registry() -> ServiceRegistry:
    """Get the global service registry."""
    return _global_registry


# Decorator functions for service registration
def service(
    lifetime: ServiceLifetime = ServiceLifetime.SINGLETON,
    interface: type | None = None,
    tags: list[str] | None = None,
    name: str | None = None,
):
    """Decorator to mark a class as a service.
    
    Args:
        lifetime: Service lifetime
        interface: Service interface type (defaults to the decorated class)
        tags: List of tags for categorization
        name: Optional name for named registration
    """
    def decorator(cls: type[T]) -> type[T]:
        service_type = interface or cls
        
        # Extract dependencies from constructor
        dependencies = _extract_dependencies(cls)
        
        _global_registry.register_service(
            service_type=service_type,
            implementation_type=cls,
            lifetime=lifetime,
            dependencies=dependencies,
            tags=tags,
            name=name,
        )
        
        # Mark the class with registration metadata on __dict__ to avoid mypy attr-defined complaints
        try:
            cls._service_metadata = ServiceMetadata(service_type=service_type, implementation_type=cls, lifetime=lifetime, dependencies=dependencies, tags=tags)
        except Exception:
            # Best-effort; registration is already stored in the registry
            pass
        
        return cls
    
    return decorator


def singleton(interface: type | None = None, tags: list[str] | None = None, name: str | None = None):
    """Decorator to mark a class as a singleton service."""
    return service(ServiceLifetime.SINGLETON, interface, tags, name)


def transient(interface: type | None = None, tags: list[str] | None = None, name: str | None = None):
    """Decorator to mark a class as a transient service."""
    return service(ServiceLifetime.TRANSIENT, interface, tags, name)


def scoped(interface: type | None = None, tags: list[str] | None = None, name: str | None = None):
    """Decorator to mark a class as a scoped service."""
    return service(ServiceLifetime.SCOPED, interface, tags, name)


def factory_service(
    service_type: type[T],
    lifetime: ServiceLifetime = ServiceLifetime.SINGLETON,
    tags: list[str] | None = None,
    name: str | None = None,
):
    """Decorator to mark a function as a service factory.
    
    Args:
        service_type: Type of service the factory creates
        lifetime: Service lifetime
        tags: List of tags for categorization
        name: Optional name for named registration
    """
    def decorator(factory_func: Callable[[], T]) -> Callable[[], T]:
        # Extract dependencies from factory function
        dependencies = _extract_dependencies_from_function(factory_func)
        
        _global_registry.register_service(
            service_type=service_type,
            lifetime=lifetime,
            factory=factory_func,
            dependencies=dependencies,
            tags=tags,
            name=name,
        )
        
        return factory_func
    
    return decorator


def _extract_dependencies(cls: type) -> list[type]:
    """Extract dependency types from a class constructor."""
    try:
        # Accessing __init__ on instances can be unsound; use the attribute from the class
        init_func = getattr(cls, "__init__", None)
        if init_func is None:
            return []
        signature = inspect.signature(init_func)
        dependencies = []
        
        for param_name, param in signature.parameters.items():
            if param_name == "self":
                continue
            
            if param.annotation != inspect.Parameter.empty:
                dependencies.append(param.annotation)
        
        return dependencies
    except Exception:
        return []


def _extract_dependencies_from_function(func: Callable) -> list[type]:
    """Extract dependency types from a function signature."""
    try:
        signature = inspect.signature(func)
        dependencies = []
        
        for param in signature.parameters.values():
            if param.annotation != inspect.Parameter.empty:
                dependencies.append(param.annotation)
        
        return dependencies
    except Exception:
        return []


class AutoServiceRegistrar:
    """Automatic service registration using reflection."""
    
    def __init__(self, registry: ServiceRegistry | None = None):
        self.registry = registry or _global_registry
        # Logger should be injected by composition; avoid global setup here
        self.logger = self.registry.logger if hasattr(self.registry, "logger") else None
    
    def register_from_module(self, module_name: str) -> None:
        """Register all decorated services from a module.
        
        Args:
            module_name: Name of the module to scan
        """
        try:
            module = importlib.import_module(module_name)
            self._scan_module(module)
            if self.logger:
                self.logger.info(f"Auto-registered services from module: {module_name}")
        except Exception as e:
            if self.logger:
                self.logger.exception(f"Failed to auto-register from module {module_name}: {e}")
            msg = f"Failed to register from module {module_name}"
            raise ServiceRegistrationError(msg) from e
    
    def register_from_package(self, package_name: str, recursive: bool = True) -> None:
        """Register all decorated services from a package.
        
        Args:
            package_name: Name of the package to scan
            recursive: Whether to scan subpackages recursively
        """
        try:
            package = importlib.import_module(package_name)
            package_file = getattr(package, "__file__", None)
            if package_file is None:
                msg = f"Package '{package_name}' has no __file__ attribute"
                raise ServiceRegistrationError(msg)
            package_path = Path(package_file).parent
            
            if recursive:
                self._scan_package_recursive(package_path, package_name)
            else:
                self._scan_package(package_path, package_name)
            
            if self.logger:
                self.logger.info(f"Auto-registered services from package: {package_name}")
        except Exception as e:
            if self.logger:
                self.logger.exception(f"Failed to auto-register from package {package_name}: {e}")
            msg = f"Failed to register from package {package_name}"
            raise ServiceRegistrationError(msg) from e
    
    def _scan_module(self, module) -> None:
        """Scan a module for decorated services."""
        for name in dir(module):
            obj = getattr(module, name)
            
            if inspect.isclass(obj) and hasattr(obj, "_service_metadata"):
                # Service already registered via decorator
                if self.logger:
                    self.logger.debug(f"Found decorated service: {obj.__name__}")
    
    def _scan_package(self, package_path: Path, package_name: str) -> None:
        """Scan a package for Python modules."""
        for py_file in package_path.glob("*.py"):
            if py_file.name.startswith("__"):
                continue
            
            module_name = f"{package_name}.{py_file.stem}"
            try:
                self.register_from_module(module_name)
            except Exception as e:
                if self.logger:
                    self.logger.warning(f"Failed to scan module {module_name}: {e}")
    
    def _scan_package_recursive(self, package_path: Path, package_name: str) -> None:
        """Recursively scan a package and its subpackages."""
        self._scan_package(package_path, package_name)
        
        for subdir in package_path.iterdir():
            if subdir.is_dir() and not subdir.name.startswith("__"):
                if (subdir / "__init__.py").exists():
                    subpackage_name = f"{package_name}.{subdir.name}"
                    self._scan_package_recursive(subdir, subpackage_name)


class ServiceRegistrationBuilder:
    """Builder for configuring service registration with UIContainer."""
    
    def __init__(self, container_builder: UIContainerBuilder, registry: ServiceRegistry | None = None):
        self.container_builder = container_builder
        self.registry = registry or _global_registry
        # Logger should be injected by composition; avoid global setup here
        self.logger = self.registry.logger if hasattr(self.registry, "logger") else None
    
    def register_all_services(self) -> None:
        """Register all services from the registry with the container builder."""
        services = self.registry.get_all_services()
        
        for metadata in services:
            self._register_service_metadata(metadata)
        
        if self.logger:
            self.logger.info(f"Registered {len(services)} services with container")
    
    def register_services_by_tag(self, tag: str) -> None:
        """Register services with a specific tag.
        
        Args:
            tag: Tag to filter services by
        """
        services = self.registry.get_services_by_tag(tag)
        
        for metadata in services:
            self._register_service_metadata(metadata)
        
        if self.logger:
            self.logger.info(f"Registered {len(services)} services with tag '{tag}'")
    
    def _register_service_metadata(self, metadata: ServiceMetadata) -> None:
        """Register a single service metadata with the container builder."""
        if metadata.factory:
            factory_func = metadata.factory
        else:
            def factory_func():
                return metadata.implementation_type()
        
        if metadata.lifetime == ServiceLifetime.SINGLETON:
            self.container_builder.add_singleton(metadata.service_type, factory_func)
        elif metadata.lifetime == ServiceLifetime.TRANSIENT:
            self.container_builder.add_transient(metadata.service_type, factory_func)
        elif metadata.lifetime == ServiceLifetime.SCOPED:
            self.container_builder.add_scoped(metadata.service_type, factory_func)
        
        if self.logger:
            self.logger.debug(f"Registered {metadata.service_type.__name__} as {metadata.lifetime.value}")


# Convenience functions
def auto_register_from_module(module_name: str) -> None:
    """Auto-register services from a module.
    
    Args:
        module_name: Name of the module to scan
    """
    registrar = AutoServiceRegistrar()
    registrar.register_from_module(module_name)


def auto_register_from_package(package_name: str, recursive: bool = True) -> None:
    """Auto-register services from a package.
    
    Args:
        package_name: Name of the package to scan
        recursive: Whether to scan subpackages recursively
    """
    registrar = AutoServiceRegistrar()
    registrar.register_from_package(package_name, recursive)


def register_all_services_with_builder(container_builder: UIContainerBuilder) -> None:
    """Register all services from the global registry with a container builder.
    
    Args:
        container_builder: UIContainerBuilder instance
    """
    builder = ServiceRegistrationBuilder(container_builder)
    builder.register_all_services()


def create_auto_service_registrar() -> AutoServiceRegistrar:
    """Factory function to create an AutoServiceRegistrar instance."""
    return AutoServiceRegistrar()


def create_service_registration_builder(container_builder: UIContainerBuilder) -> ServiceRegistrationBuilder:
    """Factory function to create a ServiceRegistrationBuilder instance."""
    return ServiceRegistrationBuilder(container_builder)