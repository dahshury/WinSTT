"""Configuration Management Service.

This module provides utilities for loading and saving application configuration,
with proper error handling and default values.
"""

import json
import os
from typing import Any

from ...domain.common.result import Result


class ConfigurationService:
    """Service for managing application configuration."""
    
    def __init__(self, config_filename: str = "settings.json") -> None:
        self._config_filename = config_filename
        self._config_path: str | None = None
        self._initialize_config_path()
    
    def _initialize_config_path(self) -> None:
        """Initialize the configuration file path."""
        # Get project root (go up from src_refactored/infrastructure/common)
        current_file = os.path.abspath(__file__)
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(current_file))))
        self._config_path = os.path.join(project_root, self._config_filename)
    
    def load_config(self) -> Result[dict[str, Any]]:
        """Load configuration from file.
        
        Returns:
            Result containing the configuration dictionary or error message
        """
        if not self._config_path:
            return Result.failure("Configuration path not initialized")
        
        try:
            if not os.path.exists(self._config_path):
                # Return default configuration if file doesn't exist
                return Result.success(self._get_default_config())
            
            with open(self._config_path, encoding="utf-8") as f:
                config = json.load(f)
                return Result.success(config)
                
        except json.JSONDecodeError as e:
            return Result.failure(f"Invalid JSON in config file: {e}")
        except OSError as e:
            return Result.failure(f"Error reading config file: {e}")
        except Exception as e:
            return Result.failure(f"Unexpected error loading config: {e}")
    
    def save_config(self, config: dict[str, Any]) -> Result[None]:
        """Save configuration to file.
        
        Args:
            config: Configuration dictionary to save
            
        Returns:
            Result indicating success or failure
        """
        if not self._config_path:
            return Result.failure("Configuration path not initialized")
        
        if not isinstance(config, dict):
            return Result.failure("Configuration must be a dictionary")
        
        try:
            # Ensure directory exists
            os.makedirs(os.path.dirname(self._config_path), exist_ok=True)
            
            with open(self._config_path, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=4, ensure_ascii=False)
                
            return Result.success(None)
            
        except OSError as e:
            return Result.failure(f"Error writing config file: {e}")
        except Exception as e:
            return Result.failure(f"Unexpected error saving config: {e}")
    
    def _get_default_config(self) -> dict[str, Any]:
        """Get default configuration values.
        
        Returns:
            Dictionary containing default configuration
        """
        return {
            "rec_key": "F9",
            "llm_enabled": False,
            "llm_model": "llama-3.2-3b-instruct",
            "llm_quantization": "Quantized",
            "model": "whisper-turbo",
            "quantization": "Quantized",
            "sound_path": "",
            "enable_sound": True,
        }
    
    def get_config_path(self) -> str | None:
        """Get the configuration file path.
        
        Returns:
            Path to the configuration file
        """
        return self._config_path


# Legacy compatibility functions
def get_config() -> dict[str, Any]:
    """Legacy compatibility function for get_config.
    
    Returns:
        Configuration dictionary
    """
    service = ConfigurationService()
    result = service.load_config()
    
    if not result.is_success:
        print(f"⚠️  {result.error()}")
        return service._get_default_config()
    
    return result.value()


def save_config(config: dict[str, Any]) -> None:
    """Legacy compatibility function for save_config.
    
    Args:
        config: Configuration dictionary to save
    """
    service = ConfigurationService()
    result = service.save_config(config)
    
    if not result.is_success:
        print(f"⚠️  {result.error()}")