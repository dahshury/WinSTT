"""Service Locator for WinSTT

This module provides a simplified interface for service resolution,
acting as a facade over the UIContainer for easier service access.
"""

import logging
from typing import Type, TypeVar, Optional, Any, Dict, List
from functools import lru_cache

from src.ui.core.container import UIContainer
from src.ui.core.abstractions import IServiceProvider
from logger import setup_logger

# Import for type hints
from src_refactored.infrastructure.container.container_configuration import (
    configure_global_container,
    get_global_container
)

T = TypeVar('T')


class ServiceLocatorError(Exception):
    """Base exception for service locator errors."""
    pass


class ServiceNotFoundError(ServiceLocatorError):
    """Raised when a requested service is not found."""
    pass


class ServiceResolutionError(ServiceLocatorError):
    """Raised when service resolution fails."""
    pass


class ServiceLocator:
    """Service locator providing simplified access to container services."""
    
    def __init__(self, container: Optional[UIContainer] = None):
        """Initialize the service locator.
        
        Args:
            container: Optional UIContainer instance. If None, uses global container.
        """
        self.logger = setup_logger()
        self._container = container
        self._service_cache: Dict[str, Any] = {}
        self._resolution_count: Dict[str, int] = {}
    
    @property
    def container(self) -> UIContainer:
        """Get the container instance."""
        if self._container is None:
            self._container = get_global_container()
        return self._container
    
    def get_service(self, service_type: Type[T]) -> T:
        """Get a service by type.
        
        Args:
            service_type: Type of service to retrieve
            
        Returns:
            Service instance
            
        Raises:
            ServiceNotFoundError: If service is not registered
            ServiceResolutionError: If service resolution fails
        """
        service_name = service_type.__name__
        
        try:
            service = self.container.resolve(service_type)
            self._track_resolution(service_name)
            return service
        except KeyError:
            error_msg = f"Service '{service_name}' is not registered"
            self.logger.error(error_msg)
            raise ServiceNotFoundError(error_msg)
        except Exception as e:
            error_msg = f"Failed to resolve service '{service_name}': {str(e)}"
            self.logger.error(error_msg)
            raise ServiceResolutionError(error_msg) from e
    
    def get_service_by_name(self, service_name: str) -> Any:
        """Get a service by name.
        
        Args:
            service_name: Name of service to retrieve
            
        Returns:
            Service instance
            
        Raises:
            ServiceNotFoundError: If service is not registered
            ServiceResolutionError: If service resolution fails
        """
        try:
            service = self.container.resolve(service_name)
            self._track_resolution(service_name)
            return service
        except KeyError:
            error_msg = f"Service '{service_name}' is not registered"
            self.logger.error(error_msg)
            raise ServiceNotFoundError(error_msg)
        except Exception as e:
            error_msg = f"Failed to resolve service '{service_name}': {str(e)}"
            self.logger.error(error_msg)
            raise ServiceResolutionError(error_msg) from e
    
    def try_get_service(self, service_type: Type[T]) -> Optional[T]:
        """Try to get a service by type, returning None if not found.
        
        Args:
            service_type: Type of service to retrieve
            
        Returns:
            Service instance or None if not found
        """
        try:
            return self.get_service(service_type)
        except ServiceLocatorError:
            return None
    
    def try_get_service_by_name(self, service_name: str) -> Optional[Any]:
        """Try to get a service by name, returning None if not found.
        
        Args:
            service_name: Name of service to retrieve
            
        Returns:
            Service instance or None if not found
        """
        try:
            return self.get_service_by_name(service_name)
        except ServiceLocatorError:
            return None
    
    def is_service_registered(self, service_type: Type[T]) -> bool:
        """Check if a service is registered.
        
        Args:
            service_type: Type of service to check
            
        Returns:
            True if service is registered, False otherwise
        """
        return self.try_get_service(service_type) is not None
    
    def is_service_registered_by_name(self, service_name: str) -> bool:
        """Check if a service is registered by name.
        
        Args:
            service_name: Name of service to check
            
        Returns:
            True if service is registered, False otherwise
        """
        return self.try_get_service_by_name(service_name) is not None
    
    def get_required_service(self, service_type: Type[T]) -> T:
        """Get a required service, raising an exception if not found.
        
        This is an alias for get_service() with more explicit naming.
        
        Args:
            service_type: Type of service to retrieve
            
        Returns:
            Service instance
            
        Raises:
            ServiceNotFoundError: If service is not registered
            ServiceResolutionError: If service resolution fails
        """
        return self.get_service(service_type)
    
    def get_services(self, *service_types: Type) -> List[Any]:
        """Get multiple services by type.
        
        Args:
            *service_types: Types of services to retrieve
            
        Returns:
            List of service instances in the same order as requested
            
        Raises:
            ServiceLocatorError: If any service resolution fails
        """
        services = []
        for service_type in service_types:
            services.append(self.get_service(service_type))
        return services
    
    def get_services_by_names(self, *service_names: str) -> List[Any]:
        """Get multiple services by name.
        
        Args:
            *service_names: Names of services to retrieve
            
        Returns:
            List of service instances in the same order as requested
            
        Raises:
            ServiceLocatorError: If any service resolution fails
        """
        services = []
        for service_name in service_names:
            services.append(self.get_service_by_name(service_name))
        return services
    
    def clear_cache(self) -> None:
        """Clear the internal service cache."""
        self._service_cache.clear()
        self.logger.debug("Service cache cleared")
    
    def get_resolution_stats(self) -> Dict[str, int]:
        """Get service resolution statistics.
        
        Returns:
            Dictionary mapping service names to resolution counts
        """
        return self._resolution_count.copy()
    
    def _track_resolution(self, service_name: str) -> None:
        """Track service resolution for statistics.
        
        Args:
            service_name: Name of the resolved service
        """
        self._resolution_count[service_name] = self._resolution_count.get(service_name, 0) + 1


class ServiceLocatorFactory:
    """Factory for creating service locator instances."""
    
    @staticmethod
    def create() -> ServiceLocator:
        """Create a new service locator with the global container.
        
        Returns:
            ServiceLocator instance
        """
        return ServiceLocator()
    
    @staticmethod
    def create_with_container(container: UIContainer) -> ServiceLocator:
        """Create a new service locator with a specific container.
        
        Args:
            container: UIContainer instance to use
            
        Returns:
            ServiceLocator instance
        """
        return ServiceLocator(container)


# Global service locator instance
_global_service_locator: Optional[ServiceLocator] = None


def get_global_service_locator() -> ServiceLocator:
    """Get the global service locator instance.
    
    Returns:
        Global ServiceLocator instance
    """
    global _global_service_locator
    
    if _global_service_locator is None:
        # Ensure global container is configured
        configure_global_container()
        _global_service_locator = ServiceLocator()
    
    return _global_service_locator


def reset_global_service_locator() -> None:
    """Reset the global service locator instance."""
    global _global_service_locator
    _global_service_locator = None


# Convenience functions for common operations
def get_service(service_type: Type[T]) -> T:
    """Get a service from the global service locator.
    
    Args:
        service_type: Type of service to retrieve
        
    Returns:
        Service instance
    """
    return get_global_service_locator().get_service(service_type)


def get_service_by_name(service_name: str) -> Any:
    """Get a service by name from the global service locator.
    
    Args:
        service_name: Name of service to retrieve
        
    Returns:
        Service instance
    """
    return get_global_service_locator().get_service_by_name(service_name)


def try_get_service(service_type: Type[T]) -> Optional[T]:
    """Try to get a service from the global service locator.
    
    Args:
        service_type: Type of service to retrieve
        
    Returns:
        Service instance or None if not found
    """
    return get_global_service_locator().try_get_service(service_type)


def try_get_service_by_name(service_name: str) -> Optional[Any]:
    """Try to get a service by name from the global service locator.
    
    Args:
        service_name: Name of service to retrieve
        
    Returns:
        Service instance or None if not found
    """
    return get_global_service_locator().try_get_service_by_name(service_name)


def is_service_registered(service_type: Type[T]) -> bool:
    """Check if a service is registered in the global service locator.
    
    Args:
        service_type: Type of service to check
        
    Returns:
        True if service is registered, False otherwise
    """
    return get_global_service_locator().is_service_registered(service_type)


def is_service_registered_by_name(service_name: str) -> bool:
    """Check if a service is registered by name in the global service locator.
    
    Args:
        service_name: Name of service to check
        
    Returns:
        True if service is registered, False otherwise
    """
    return get_global_service_locator().is_service_registered_by_name(service_name)


@lru_cache(maxsize=128)
def get_cached_service(service_type: Type[T]) -> T:
    """Get a service with caching for singleton services.
    
    Args:
        service_type: Type of service to retrieve
        
    Returns:
        Service instance (cached for subsequent calls)
    """
    return get_service(service_type)


def clear_service_cache() -> None:
    """Clear the cached service instances."""
    get_cached_service.cache_clear()
    get_global_service_locator().clear_cache()


def create_service_locator() -> ServiceLocator:
    """Factory function to create a ServiceLocator instance."""
    return ServiceLocatorFactory.create()


def create_service_locator_with_container(container: UIContainer) -> ServiceLocator:
    """Factory function to create a ServiceLocator with a specific container.
    
    Args:
        container: UIContainer instance to use
        
    Returns:
        ServiceLocator instance
    """
    return ServiceLocatorFactory.create_with_container(container)