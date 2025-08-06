"""Infrastructure Service Registry for WinSTT

This module provides infrastructure-only service registration.
Application services should be registered in the composition root.
"""

from typing import Any, TypeVar

from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.infrastructure.adapters.logging_adapter import PythonLoggingAdapter

T = TypeVar("T")


class InfrastructureServiceRegistry:
    """Registry for infrastructure-only services."""
    
    def __init__(self):
        self.logger = PythonLoggingAdapter()
        self._services: dict[type, Any] = {}
    
    def register_infrastructure_services(self) -> None:
        """Register infrastructure-only services."""
        self.logger.info("Registering infrastructure services")
        
        # Register logging service
        self._services[LoggingPort] = PythonLoggingAdapter()
        
        self.logger.info("Infrastructure services registered")
    
    def get_service(self, service_type: type[T]) -> T:
        """Get an infrastructure service.
        
        Args:
            service_type: Type of service to retrieve
            
        Returns:
            Service instance
            
        Raises:
            KeyError: If service is not registered
        """
        if service_type not in self._services:
            msg = f"Infrastructure service {service_type.__name__} not registered"
            raise KeyError(msg)
        
        return self._services[service_type]
    
    def has_service(self, service_type: type) -> bool:
        """Check if a service is registered.
        
        Args:
            service_type: Type of service to check
            
        Returns:
            True if service is registered
        """
        return service_type in self._services


# Global infrastructure registry
_infrastructure_registry: InfrastructureServiceRegistry | None = None


def get_infrastructure_registry() -> InfrastructureServiceRegistry:
    """Get the global infrastructure service registry.
    
    Returns:
        Infrastructure service registry
    """
    global _infrastructure_registry
    
    if _infrastructure_registry is None:
        _infrastructure_registry = InfrastructureServiceRegistry()
        _infrastructure_registry.register_infrastructure_services()
    
    return _infrastructure_registry


def get_infrastructure_service(service_type: type[T]) -> T:
    """Get an infrastructure service from the global registry.
    
    Args:
        service_type: Type of service to retrieve
        
    Returns:
        Service instance
    """
    return get_infrastructure_registry().get_service(service_type)
