"""Settings configuration entity for managing configuration persistence."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from src_refactored.domain.common import Entity

if TYPE_CHECKING:
    from pathlib import Path


@dataclass
class SettingsConfiguration(Entity):
    """Entity for managing settings configuration persistence and validation."""

    config_file_path: Path
    _cached_settings: dict[str, Any] | None = field(default=None, init=False)
    _is_dirty: bool = field(default=False, init=False)

    def __post_init__(self):
        """Initialize the settings configuration entity."""
        super().__post_init__()
        self._ensure_config_directory_exists()

    def _ensure_config_directory_exists(self) -> None:
        """Ensure the configuration directory exists."""
        self.config_file_path.parent.mkdir(parents=True, exist_ok=True)

    def load_configuration(self) -> dict[str, Any]:
        """Load configuration from file with validation and defaults."""
        try:
            if not self.config_file_path.exists():
                return self._get_default_configuration()

            with open(self.config_file_path, encoding="utf-8") as f:
                raw_config = json.load(f)

            # Validate and merge with defaults
            validated_config = self._validate_and_merge_configuration(raw_config,
    )
            self._cached_settings = validated_config
            self._is_dirty = False

            return validated_config

        except (json.JSONDecodeError, FileNotFoundError, PermissionError) as e:
            # Log error and return defaults
            print(f"Error loading configuration: {e}")
            return self._get_default_configuration()

    def save_configuration(self, settings: dict[str, Any]) -> bool:
        """Save configuration to file with validation."""
        try:
            # Validate settings before saving
            validated_settings = self._validate_settings_for_save(settings)

            # Create backup if file exists
            if self.config_file_path.exists():
                self._create_backup()

            # Write configuration
            with open(self.config_file_path, "w", encoding="utf-8") as f:
                json.dump(validated_settings, f, indent=2, ensure_ascii=False)

            self._cached_settings = validated_settings
            self._is_dirty = False

            return True

        except (PermissionError, OSError) as e:
            print(f"Error saving configuration: {e}")
            return False

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
        validation_rules = {
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

    def _create_backup(self) -> None:
        """Create a backup of the current configuration file."""
        try:
            backup_path = self.config_file_path.with_suffix(".bak")
            backup_path.write_bytes(self.config_file_path.read_bytes())
        except Exception as e:
            print(f"Warning: Could not create configuration backup: {e}")

    @classmethod
    def create_default(cls, config_path: Path,
    ) -> SettingsConfiguration:
        """Create a settings configuration with default path."""
        return cls(config_file_path=config_path)

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