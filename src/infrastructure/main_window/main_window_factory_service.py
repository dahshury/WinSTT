"""Main Window Factory Service.

This service implements the main window factory following hexagonal architecture
principles with proper separation of concerns.
"""

import json
import os
import sys
from pathlib import Path
from typing import Any

from src.application.main_window.create_main_window_use_case import (
    IConfigurationProvider,
    IMainWindowFactory,
    IResourceProvider,
)
from src.domain.common.result import Result


class SimpleConfigurationProvider:
    """Simple configuration provider that avoids complex infrastructure loading."""
    
    def __init__(self, config_file_name: str = "settings.json"):
        self._config_path = self._get_config_path(config_file_name)
        self._config_cache: dict[str, Any] | None = None
    
    def _get_config_path(self, config_file_name: str) -> Path:
        """Get path to configuration file."""
        # Get project root (navigate up from infrastructure/main_window)
        current_file = Path(__file__)
        project_root = current_file.parent.parent.parent.parent
        return project_root / config_file_name
    
    def _load_config(self) -> dict[str, Any]:
        """Load configuration from file with defaults."""
        if self._config_cache is not None:
            return self._config_cache
        
        # Default configuration
        defaults = {
            "rec_key": "F9",
            "llm_enabled": False,
            "llm_model": "llama-3.2-3b-instruct",
            "llm_quantization": "Quantized",
            "model": "whisper-turbo",
            "quantization": "Quantized",
            "sound_path": "",
            "enable_sound": True,
            "recording_sound_enabled": True,
            "output_srt": False,
            "recording_key": "CTRL+ALT+A",
            "sound_file_path": "@resources/splash.wav",
        }
        
        # Try to load from file
        if self._config_path.exists():
            try:
                with open(self._config_path, encoding="utf-8") as f:
                    file_config = json.load(f)
                    defaults.update(file_config)
            except (json.JSONDecodeError, OSError):
                pass  # Use defaults
        
        self._config_cache = defaults
        return defaults
    
    def get_value(self, key: str, default: str | None = None) -> str | None:
        """Get configuration value."""
        config = self._load_config()
        value = config.get(key, default)
        return str(value) if value is not None else None


class SimpleResourceProvider:
    """Simple resource provider that avoids complex infrastructure loading."""
    
    def __init__(self):
        self._base_path = self._get_base_path()
    
    def _get_base_path(self) -> str:
        """Get base path for resources."""
        try:
            # PyInstaller creates a temp folder and stores path in _MEIPASS
            return sys._MEIPASS  # type: ignore[attr-defined]
        except AttributeError:
            # Development mode - navigate from infrastructure/main_window to project root
            current_file = Path(__file__)
            project_root = current_file.parent.parent.parent.parent
            return str(project_root / "src")
    
    def get_resource_path(self, relative_path: str) -> str:
        """Get absolute path to resource."""
        full_path = os.path.join(self._base_path, relative_path)
        
        # Check if resource exists
        if not os.path.exists(full_path):
            # Try alternative path (project root)
            current_file = Path(__file__)
            project_root = current_file.parent.parent.parent.parent
            alt_path = str(project_root / relative_path)
            if os.path.exists(alt_path):
                return alt_path
        
        return full_path


class AuthenticMainWindowFactory:
    """Factory for creating main window instances.

    Note: Presentation construction must not happen inside Infrastructure.
    This factory should defer actual UI construction to an Application/PRESENTATION-side factory.
    Here we return a failure with guidance if mistakenly invoked.
    """

    def create_window(
        self,
        configuration_provider: IConfigurationProvider,
        resource_provider: IResourceProvider,
    ) -> Result[Any]:
        """Prohibit Infra from constructing Presentation windows.

        Returns a failure directing the composition root to use the Presentation factory.
        """
        msg = (
            "Infrastructure must not import Presentation. Use a Presentation-layer "
            "factory (e.g., presentation.main_window.factory.create_main_window) "
            "wired via the composition root."
        )
        return Result.failure(msg)


# Factory function for the composition root
def create_main_window_factory() -> IMainWindowFactory:
    """Create main window factory with dependencies."""
    return AuthenticMainWindowFactory()


def create_configuration_provider() -> IConfigurationProvider:
    """Create configuration provider."""
    return SimpleConfigurationProvider()


def create_resource_provider() -> IResourceProvider:
    """Create resource provider."""
    return SimpleResourceProvider()
