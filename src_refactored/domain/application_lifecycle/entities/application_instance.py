"""Application Instance Entity.

This module defines the domain entity for application instances.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from src_refactored.domain.common.domain_utils import DomainIdentityGenerator


@dataclass
class ApplicationInstance:
    """Domain entity representing an application instance."""
    
    instance_id: str
    name: str
    version: str
    startup_time: datetime
    is_running: bool = True
    configuration: dict[str, Any] | None = None
    process_id: int | None = None
    
    def __post_init__(self) -> None:
        if self.configuration is None:
            self.configuration = {}
    
    def start(self) -> None:
        """Mark application as started."""
        self.is_running = True
        if self.startup_time is None:
            self.startup_time = datetime.fromtimestamp(DomainIdentityGenerator.generate_timestamp())
    
    def stop(self) -> None:
        """Mark application as stopped."""
        self.is_running = False
    
    def get_uptime(self) -> float:
        """Get application uptime in seconds.
        
        Returns:
            Uptime in seconds since startup
        """
        if not self.startup_time:
            return 0.0
        
        return (datetime.fromtimestamp(DomainIdentityGenerator.generate_timestamp()) - self.startup_time).total_seconds()
    
    def set_configuration(self, key: str, value: Any) -> None:
        """Set configuration value.
        
        Args:
            key: Configuration key
            value: Configuration value
        """
        if self.configuration is None:
            self.configuration = {}
        self.configuration[key] = value
    
    def get_configuration(self, key: str, default: Any = None) -> Any:
        """Get configuration value.
        
        Args:
            key: Configuration key
            default: Default value if key not found
            
        Returns:
            Configuration value or default
        """
        if self.configuration is None:
            return default
        return self.configuration.get(key, default)
