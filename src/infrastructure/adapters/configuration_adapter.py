"""Configuration Service Adapter.

This adapter bridges the real ConfigurationService (which returns Result[dict])
with the simple IConfigurationService protocol expected by the presentation layer.
"""

from typing import Any

from src.domain.common.ports.logging_port import LoggingPort
from src.infrastructure.common.configuration_service import ConfigurationService


class ConfigurationServiceAdapter:
    """Adapter that bridges ConfigurationService Result[dict] interface to simple get_value interface."""
    
    def __init__(self, config_filename: str = "settings.json", logger: LoggingPort | None = None):
        self._service = ConfigurationService(config_filename)
        self._logger = logger
        self._config_cache: dict[str, Any] | None = None
        # Load configuration immediately
        self._load_config()
    
    def _load_config(self) -> None:
        """Load configuration from the service."""
        try:
            result = self._service.load_config()
            if result.is_success:
                self._config_cache = result.value
                if self._logger:
                    self._logger.log_info("Configuration loaded successfully")
            else:
                self._config_cache = {}
                if self._logger:
                    self._logger.log_warning(f"Failed to load configuration: {result.error}")
        except Exception as e:
            self._config_cache = {}
            if self._logger:
                self._logger.log_error("Failed to load configuration", exception=e)
    
    def get_value(self, key: str, default: str | None = None) -> str | None:
        """Get a configuration value - implementing the interface expected by main window."""
        try:
            if self._config_cache is None:
                self._load_config()
            
            if self._config_cache is None:
                return default
            
            value = self._config_cache.get(key, default)
            # Ensure we return string or None as expected by the protocol
            if value is None:
                return default
            return str(value)
            
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Failed to get configuration value {key}", exception=e)
            return default
    
    def get_setting(self, key: str, default: Any = None) -> Any:
        """Get a setting value - legacy compatibility method."""
        try:
            if self._config_cache is None:
                self._load_config()
            
            if self._config_cache is None:
                return default
            
            return self._config_cache.get(key, default)
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Failed to get setting {key}", exception=e)
            return default
    
    def save_setting(self, key: str, value: Any) -> None:
        """Save a setting value."""
        try:
            if self._config_cache is None:
                self._load_config()
            
            if self._config_cache is None:
                self._config_cache = {}
            
            self._config_cache[key] = value
            result = self._service.save_config(self._config_cache)
            if not result.is_success and self._logger:
                self._logger.log_error(f"Failed to save setting {key}: {result.error}")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Failed to save setting {key}", exception=e)
    
    def reload_config(self) -> None:
        """Force reload of configuration from file."""
        self._config_cache = None
        self._load_config()
