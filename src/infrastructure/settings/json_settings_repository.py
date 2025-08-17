"""JSON Settings Repository Implementation.

This module provides a JSON-based implementation of the SettingsRepository
interface, handling file-based settings persistence with validation and backup.

Extracted from: domain/settings/entities/settings_configuration.py
"""

import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

# Removed PyQt dependencies to keep repository headless and infra-safe
from src.domain.common.ports.logging_port import LoggingPort
from src.domain.common.result import Result

from .settings_repository import SettingsRepository


class JSONSettingsRepository(SettingsRepository):
    """JSON-based implementation of SettingsRepository.
    
    Provides file-based settings persistence using JSON format with
    validation, backup, and error handling capabilities.
    """

    # Events are returned via Result; UI concerns moved to Application/EventPublisher

    def __init__(self, config_path: Path, auto_backup: bool = True, logger: LoggingPort | None = None):
        super().__init__()
        self.config_path = Path(config_path)
        self.auto_backup = auto_backup
        self.logger = logger

        # Cache for loaded settings
        self._cached_settings: dict[str, Any] | None = None
        self._cache_timestamp: float | None = None

        # Ensure config directory exists
        self.config_path.parent.mkdir(parents=True, exist_ok=True)

        # Initialize with defaults if file doesn't exist
        if not self.config_path.exists():
            self._create_default_config()

    def load_settings(self) -> Result[dict[str, Any]]:
        """Load settings from JSON file.
        
        Returns:
            Result containing settings dictionary or error
        """
        try:
            # Check if we can use cached settings
            if self._is_cache_valid() and self._cached_settings is not None:
                return Result.success(self._cached_settings.copy())

            if not self.config_path.exists():
                if self.logger:
                    self.logger.log_warning(f"Settings file not found: {self.config_path}")
                default_settings = self._get_default_settings()
                self._cached_settings = default_settings
                self._cache_timestamp = datetime.now().timestamp()
                return Result.success(default_settings)

            with open(self.config_path, encoding="utf-8") as f:
                settings = json.load(f)

            # Validate loaded settings
            validation_result = self.validate_settings(settings)
            if not validation_result.is_success:
                if self.logger:
                    self.logger.log_error(f"Settings validation failed: {validation_result.get_error()}")
                # Return default settings on validation failure
                default_settings = self._get_default_settings()
                self._cached_settings = default_settings
                self._cache_timestamp = datetime.now().timestamp()
                return Result.success(default_settings)

            # Update cache
            self._cached_settings = settings
            self._cache_timestamp = self.config_path.stat().st_mtime

            # Event publication is responsibility of Application layer
            if self.logger:
                self.logger.log_debug(f"Settings loaded successfully from {self.config_path}")

            return Result.success(settings)

        except json.JSONDecodeError as e:
            error_msg = f"Invalid JSON in settings file: {e}"
            if self.logger:
                self.logger.log_error(error_msg, exception=e)
            # Event publication is responsibility of Application layer
            return Result.failure(error_msg)

        except Exception as e:
            error_msg = f"Failed to load settings: {e}"
            if self.logger:
                self.logger.log_error(error_msg, exception=e)
            # Event publication is responsibility of Application layer
            return Result.failure(error_msg,
    )

    def save_settings(self, settings: dict[str, Any]) -> Result[None]:
        """Save settings to JSON file.
        
        Args:
            settings: Settings dictionary to save
            
        Returns:
            Result indicating success or failure
        """
        try:
            # Validate settings before saving
            validation_result = self.validate_settings(settings)
            if not validation_result.is_success:
                error_msg = f"Settings validation failed: {validation_result.get_error()}"
                if self.logger:
                    self.logger.log_error(error_msg)
                return Result.failure(error_msg)

            # Create backup if auto_backup is enabled
            if self.auto_backup and self.config_path.exists():
                backup_result = self.backup_settings()
                if self.logger and not backup_result.is_success:
                    self.logger.log_warning(f"Failed to create backup: {backup_result.get_error()}")

            # Ensure directory exists
            self.config_path.parent.mkdir(parents=True, exist_ok=True)

            # Write settings to file
            with self.config_path.open("w", encoding="utf-8") as f:
                json.dump(settings, f, indent=2, ensure_ascii=False)

            # Update cache
            self._cached_settings = settings.copy()
            self._cache_timestamp = self.config_path.stat().st_mtime

            # Event publication is responsibility of Application layer
            if self.logger:
                self.logger.log_debug(f"Settings saved successfully to {self.config_path}")

            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to save settings: {e}"
            if self.logger:
                self.logger.log_error(error_msg, exception=e)
            # Event publication is responsibility of Application layer
            return Result.failure(error_msg)

    def get_setting(self, key: str, default: Any = None) -> Result[Any]:
        """Get a specific setting value.
        
        Args:
            key: Setting key to retrieve
            default: Default value if key not found
            
        Returns:
            Result containing setting value or error
        """
        try:
            settings_result = self.load_settings()
            if not settings_result.is_success:
                return Result.failure(settings_result.get_error())

            settings = settings_result.get_value()
            value = settings.get(key, default)

            return Result.success(value)

        except Exception as e:
            error_msg = f"Failed to get setting '{key}': {e}"
            if self.logger:
                self.logger.log_error(error_msg, exception=e)
            return Result.failure(error_msg)

    def set_setting(self, key: str, value: Any,
    ) -> Result[None]:
        """Set a specific setting value.
        
        Args:
            key: Setting key to set
            value: Value to set
            
        Returns:
            Result indicating success or failure
        """
        try:
            settings_result = self.load_settings()
            if not settings_result.is_success:
                return Result.failure(settings_result.get_error())

            settings = settings_result.get_value()
            settings[key] = value

            return self.save_settings(settings)

        except Exception as e:
            error_msg = f"Failed to set setting '{key}': {e}"
            if self.logger:
                self.logger.log_error(error_msg, exception=e)
            return Result.failure(error_msg)

    def has_setting(self, key: str,
    ) -> Result[bool]:
        """Check if a setting exists.
        
        Args:
            key: Setting key to check
            
        Returns:
            Result containing boolean indicating existence
        """
        try:
            settings_result = self.load_settings()
            if not settings_result.is_success:
                return Result.failure(settings_result.get_error())

            settings = settings_result.get_value()
            exists = key in settings

            return Result.success(exists)

        except Exception as e:
            error_msg = f"Failed to check setting '{key}': {e}"
            if self.logger:
                self.logger.log_error(error_msg, exception=e)
            return Result.failure(error_msg)

    def delete_setting(self, key: str,
    ) -> Result[None]:
        """Delete a specific setting.
        
        Args:
            key: Setting key to delete
            
        Returns:
            Result indicating success or failure
        """
        try:
            settings_result = self.load_settings()
            if not settings_result.is_success:
                return Result.failure(settings_result.get_error())

            settings = settings_result.get_value()

            if key not in settings:
                return Result.failure(f"Setting '{key}' does not exist")

            del settings[key]

            return self.save_settings(settings)

        except Exception as e:
            error_msg = f"Failed to delete setting '{key}': {e}"
            if self.logger:
                self.logger.log_error(error_msg, exception=e)
            return Result.failure(error_msg)

    def get_all_keys(self) -> Result[list[str]]:
        """Get all setting keys.
        
        Returns:
            Result containing list of all setting keys
        """
        try:
            settings_result = self.load_settings()
            if not settings_result.is_success:
                return Result.failure(settings_result.get_error())

            settings = settings_result.get_value()
            keys = list(settings.keys())

            return Result.success(keys)

        except Exception as e:
            error_msg = f"Failed to get setting keys: {e}"
            if self.logger:
                self.logger.log_error(error_msg, exception=e)
            return Result.failure(error_msg)

    def clear_all_settings(self) -> Result[None]:
        """Clear all settings.
        
        Returns:
            Result indicating success or failure
        """
        try:
            # Create backup before clearing
            if self.auto_backup and self.config_path.exists():
                backup_result = self.backup_settings()
                if self.logger and not backup_result.is_success:
                    self.logger.log_warning(
                        f"Failed to create backup before clearing: {backup_result.get_error()}",
                    )

            # Save empty settings
            empty_settings = self._get_default_settings()
            return self.save_settings(empty_settings)

        except Exception as e:
            error_msg = f"Failed to clear settings: {e}"
            if self.logger:
                self.logger.log_error(error_msg, exception=e)
            return Result.failure(error_msg)

    def backup_settings(self, backup_path: Path | None = None) -> Result[Path]:
        """Create a backup of current settings.
        
        Args:
            backup_path: Optional path for backup file
            
        Returns:
            Result containing path to backup file
        """
        try:
            if not self.config_path.exists():
                return Result.failure("No settings file to backup")

            if backup_path is None:
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                backup_filename = f"{self.config_path.stem}_backup_{timestamp}.json"
                backup_path = self.config_path.parent / "backups" / backup_filename

            # Ensure backup directory exists
            backup_path.parent.mkdir(parents=True, exist_ok=True)

            # Copy settings file to backup location
            shutil.copy2(self.config_path, backup_path)

            # Event publication is responsibility of Application layer
            if self.logger:
                self.logger.log_info(f"Settings backup created: {backup_path}")

            return Result.success(backup_path)

        except Exception as e:
            error_msg = f"Failed to create backup: {e}"
            if self.logger:
                self.logger.log_error(error_msg, exception=e)
            return Result.failure(error_msg)

    def restore_settings(self, backup_path: Path,
    ) -> Result[None]:
        """Restore settings from backup.
        
        Args:
            backup_path: Path to backup file
            
        Returns:
            Result indicating success or failure
        """
        try:
            if not backup_path.exists():
                return Result.failure(f"Backup file not found: {backup_path}")

            # Load and validate backup settings
            with open(backup_path, encoding="utf-8") as f:
                backup_settings = json.load(f)

            validation_result = self.validate_settings(backup_settings)
            if not validation_result.is_success:
                return Result.failure(f"Backup settings validation failed: {validation_result.get_error()}")

            # Create backup of current settings before restoring
            if self.config_path.exists():
                current_backup_result = self.backup_settings()
                if self.logger and not current_backup_result.is_success:
                    self.logger.log_warning(f"Failed to backup current settings: {current_backup_result.get_error()}")

            # Restore settings
            return self.save_settings(backup_settings)

        except json.JSONDecodeError as e:
            error_msg = f"Invalid JSON in backup file: {e}"
            if self.logger:
                self.logger.log_error(error_msg, exception=e)
            return Result.failure(error_msg)

        except Exception as e:
            error_msg = f"Failed to restore settings: {e}"
            if self.logger:
                self.logger.log_error(error_msg, exception=e)
            return Result.failure(error_msg)

    def validate_settings(self, settings: dict[str, Any]) -> Result[None]:
        """Validate settings before saving.
        
        Args:
            settings: Settings dictionary to validate
            
        Returns:
            Result indicating validation success or failure
        """
        try:
            if not isinstance(settings, dict):
                return Result.failure("Settings must be a dictionary")

            # Basic validation - ensure required keys exist
            required_keys = [
                "model", "quantization", "recording_key",
                "recording_sound_enabled", "output_srt",
            ]

            for key in required_keys:
                if key not in settings:
                    return Result.failure(f"Required setting '{key}' is missing")

            # Type validation
            type_validations = {
                "model": str,
                "quantization": str,
                "recording_key": str,
                "recording_sound_enabled": bool,
                "output_srt": bool,
                "llm_enabled": bool,
            }

            for key, expected_type in type_validations.items():
                if key in settings and not isinstance(settings[key], expected_type):
                    return Result.failure(
                        f"Setting '{key}' must be of type {expected_type.__name__}, "
                        f"got {type(settings[key]).__name__}",
                    )

            # Value validation
            valid_models = ["whisper-turbo", "whisper-large-v3", "whisper-medium", "whisper-small", "whisper-base"]
            if settings.get("model") not in valid_models:
                return Result.failure(f"Invalid model: {settings.get('model')}. Must be one of {valid_models}")

            valid_quantizations = ["full", "quantized"]
            if settings.get("quantization") not in valid_quantizations:
                return Result.failure(f"Invalid quantization: {settings.get('quantization')}. Must b\
    e one of {valid_quantizations}")

            return Result.success(None)

        except Exception as e:
            error_msg = f"Settings validation error: {e}"
            if self.logger:
                self.logger.log_error(error_msg, exception=e)
            return Result.failure(error_msg)

    def get_settings_info(self,
    ) -> Result[dict[str, Any]]:
        """Get metadata about the settings storage.

        Returns:
            Result containing settings metadata
        """
        try:
            info = {
                "config_path": str(self.config_path),
                "exists": self.config_path.exists(),
                "auto_backup": self.auto_backup,
                "cache_valid": self._is_cache_valid(),
            }

            if self.config_path.exists():
                stat = self.config_path.stat()
                info.update({
                    "size_bytes": stat.st_size,
                    "last_modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    "created": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                })

            # Count settings
            settings_result = self.load_settings()
            if settings_result.is_success:
                settings = settings_result.get_value()
                info["settings_count"] = len(settings)
                info["settings_keys"] = list(settings.keys())

            return Result.success(info)

        except Exception as e:
            error_msg = f"Failed to get settings info: {e}"
            if self.logger:
                self.logger.log_error(error_msg, exception=e)
            return Result.failure(error_msg)

    def _is_cache_valid(self) -> bool:
        """Check if cached settings are still valid."""
        if self._cached_settings is None or self._cache_timestamp is None:
            return False

        if not self.config_path.exists():
            return False

        try:
            file_mtime = self.config_path.stat().st_mtime
            return file_mtime <= self._cache_timestamp
        except Exception:
            return False

    def _create_default_config(self) -> None:
        """Create default configuration file."""
        try:
            default_settings = self._get_default_settings()
            self.save_settings(default_settings)
            if self.logger:
                self.logger.log_info(f"Created default settings file: {self.config_path}")
        except Exception as e:
            if self.logger:
                self.logger.log_error(f"Failed to create default config: {e}", exception=e)

    def _get_default_settings(self,
    ) -> dict[str, Any]:
        """Get default settings configuration."""
        return {
            "model": "whisper-turbo",
            "quantization": "quantized",
            "recording_key": "ctrl+shift+r",
            "recording_sound_enabled": True,
            "sound_file_path": "",
            "output_srt": False,
            "output_txt": True,
            "output_folder": "",
            "llm_enabled": False,
            "llm_model": "",
            "llm_prompt": "",
            "llm_api_key": "",
            "auto_paste": True,
            "minimize_to_tray": True,
            "start_minimized": False,
            "theme": "system",
            "language": "auto",
        }