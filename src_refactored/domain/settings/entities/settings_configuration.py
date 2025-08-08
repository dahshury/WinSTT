"""Settings configuration entity for managing configuration persistence."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from src_refactored.domain.common import Entity

if TYPE_CHECKING:
    from collections.abc import Callable

    from src_refactored.domain.common.ports.file_system_port import FileSystemPort
    from src_refactored.domain.common.ports.serialization_port import SerializationPort


@dataclass
class SettingsConfiguration(Entity):
    """Entity for managing settings configuration persistence and validation."""

    config_file_path: str
    file_system_port: FileSystemPort
    serialization_port: SerializationPort
    _cached_settings: dict[str, Any] | None = field(default=None, init=False)
    _is_dirty: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        """Initialize the settings configuration entity."""
        super().__post_init__()
        self._ensure_config_directory_exists()

    def _ensure_config_directory_exists(self) -> None:
        """Ensure the configuration directory exists."""
        # Get directory containing the config file
        directory_result = self.file_system_port.get_directory_name(self.config_file_path)
        if directory_result.is_success and directory_result.value:
            directory_path = directory_result.value
            # Create directory if it doesn't exist
            self.file_system_port.create_directory(directory_path, recursive=True)

    def load_configuration_from_content(self, file_content: str) -> dict[str, Any]:
        """Load configuration from file content string."""
        # Deserialize JSON content
        deserialize_result = self.serialization_port.deserialize_from_json(file_content)
        
        if not deserialize_result.is_success:
            return self._get_default_configuration()
        
        raw_config = deserialize_result.value
        if not isinstance(raw_config, dict):
            return self._get_default_configuration()
        
        # Validate and merge with defaults
        validated_config = self._validate_and_merge_configuration(raw_config)
        self._cached_settings = validated_config
        self._is_dirty = False
        
        return validated_config
    
    def load_configuration(self) -> dict[str, Any]:
        """Load configuration from file with validation and defaults."""
        # Check if file exists
        exists_result = self.file_system_port.file_exists(self.config_file_path)
        if not exists_result.is_success or not exists_result.value:
            return self._get_default_configuration()
        
        # Note: In a complete implementation, we'd need a file reading operation
        # through a port. For now, return defaults and rely on infrastructure
        # to coordinate the file reading with this method.
        return self._get_default_configuration()

    def serialize_configuration_for_save(self, settings: dict[str, Any]) -> tuple[bool, str]:
        """Serialize configuration for saving. Returns (success, content)."""
        try:
            # Validate settings before saving
            validated_settings = self._validate_settings_for_save(settings)
            
            # Serialize to JSON using port
            serialize_result = self.serialization_port.serialize_to_json(validated_settings)
            
            if not serialize_result.is_success:
                return False, ""
            
            # Pretty print for better readability
            if serialize_result.value is not None:
                pretty_result = self.serialization_port.pretty_print_json(serialize_result.value, indent=2)
            else:
                return False, ""
            if pretty_result.is_success and pretty_result.value is not None:
                serialized_content = pretty_result.value
            elif serialize_result.value is not None:
                serialized_content = serialize_result.value
            else:
                return False, ""
            
            # Update cached settings
            self._cached_settings = validated_settings
            self._is_dirty = False
            
            return True, serialized_content
            
        except Exception:
            return False, ""
    
    def save_configuration(self, settings: dict[str, Any]) -> bool:
        """Save configuration to file with validation."""
        # Note: In a complete implementation, this would coordinate with
        # infrastructure layer for file operations and backup creation.
        # The serialization is handled through ports.
        success, _ = self.serialize_configuration_for_save(settings)
        return success

    def update_setting(self, key: str, value: Any,
    ) -> None:
        """Update a single setting with validation."""
        if self._cached_settings is None:
            self._cached_settings = self.load_configuration()

        # Validate the setting update
        if self._is_valid_setting_update(key, value):
            self._cached_settings[key] = value
            self._is_dirty = True
        else:
            msg = f"Invalid setting update: {key} = {value}"
            raise ValueError(msg)

    def get_setting(self, key: str, default: Any = None) -> Any:
        """Get a setting value with optional default."""
        if self._cached_settings is None:
            self._cached_settings = self.load_configuration()

        return self._cached_settings.get(key, default)

    def has_unsaved_changes(self) -> bool:
        """Check if there are unsaved changes."""
        return self._is_dirty

    def reset_to_defaults(self) -> None:
        """Reset configuration to default values."""
        self._cached_settings = self._get_default_configuration()
        self._is_dirty = True

    def _get_default_configuration(self) -> dict[str, Any]:
        """Get default configuration values."""
        return {
            "model": "whisper-turbo",
            "quantization": "Full",
            "recording_sound_enabled": True,
            "sound_file_path": "",
            "output_srt": True,
            "recording_key": "CTRL+SHIFT+R",
            "llm_enabled": False,
            "llm_model": "gemma-3-1b-it",
            "llm_quantization": "Full",
            "llm_prompt": "You are a helpful assistant.",
        }

    def _validate_and_merge_configuration(self, raw_config: dict[str, Any]) -> dict[str, Any]:
        """Validate loaded configuration and merge with defaults."""
        defaults = self._get_default_configuration()
        validated_config = defaults.copy()

        # Validate and update each setting
        for key, value in raw_config.items():
            if self._is_valid_setting_update(key, value):
                validated_config[key] = value
            # Invalid values are ignored and defaults are kept

        return validated_config

    def _validate_settings_for_save(self, settings: dict[str, Any]) -> dict[str, Any]:
        """Validate settings before saving."""
        validated = {}

        for key, value in settings.items():
            if self._is_valid_setting_update(key, value):
                validated[key] = value
            else:
                # Use default for invalid values
                defaults = self._get_default_configuration()
                if key in defaults:
                    validated[key] = defaults[key]

        return validated

    def _is_valid_setting_update(self, key: str, value: Any,
    ) -> bool:
        """Validate a setting key-value pair."""
        validation_rules: dict[str, Callable[[Any], bool]] = {
            "model": lambda v: isinstance(v, str) and v in [
                "whisper-turbo", "lite-whisper-turbo", "lite-whisper-turbo-fast",
            ],
            "quantization": lambda v: isinstance(v, str) and v in ["Full", "Quantized"],
            "recording_sound_enabled": lambda v: isinstance(v, bool),
            "sound_file_path": lambda v: isinstance(v, str),
            "output_srt": lambda v: isinstance(v, bool),
            "recording_key": lambda v: isinstance(v, str) and len(v.strip()) > 0,
            "llm_enabled": lambda v: isinstance(v, bool),
            "llm_model": lambda v: isinstance(v, str) and len(v.strip()) > 0,
            "llm_quantization": lambda v: isinstance(v, str) and v in ["Full", "Quantized"],
            "llm_prompt": lambda v: isinstance(v, str) and len(v.strip()) > 0,
        }

        if key not in validation_rules:
            return False

        try:
            return validation_rules[key](value)
        except Exception:
            return False

    def _create_backup(self) -> bool:
        """Create a backup of the current configuration file. Returns success status."""
        try:
            # Create backup filename
            if self.config_file_path.endswith(".json"):
                backup_path = self.config_file_path[:-5] + ".bak"
            else:
                backup_path = self.config_file_path + ".bak"
            
            # Note: Actual file copying would be handled by infrastructure layer
            # This method now just indicates the backup operation was attempted
            return self.file_system_port.copy_file(self.config_file_path, backup_path).is_success
            
        except Exception:
            return False

    @classmethod
    def create_default(cls, config_path: str, file_system_port: FileSystemPort, serialization_port: SerializationPort) -> SettingsConfiguration:
        """Create a settings configuration with default path."""
        return cls(
            config_file_path=config_path,
            file_system_port=file_system_port,
            serialization_port=serialization_port,
        )

    def get_configuration_summary(self) -> dict[str, str]:
        """Get a human-readable summary of current configuration."""
        if self._cached_settings is None:
            self._cached_settings = self.load_configuration()

        return {
            "Model": self._cached_settings.get("model", "Unknown"),
            "Quantization": self._cached_settings.get("quantization", "Unknown"),
            "Recording Sound": "Enabled" if self._cached_settings.get("recording_sound_enabled") else "Disabled",
            "SRT Output": "Enabled" if self._cached_settings.get("output_srt") else "Disabled",
            "Recording Key": self._cached_settings.get("recording_key", "Not Set"),
            "LLM Processing": "Enabled" if self._cached_settings.get("llm_enabled") else "Disabled",
            "LLM Model": self._cached_settings.get("llm_model", "Not Set"),
        }