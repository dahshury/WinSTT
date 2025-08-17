"""Settings migration service for handling settings version upgrades."""

import json
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from src.domain.transcription.value_objects import ProgressCallback


class MigrationError(Exception):
    """Exception raised when settings migration fails."""


class SettingsMigrationService:
    """Infrastructure service for migrating settings between versions."""

    CURRENT_VERSION = "1.0.0"

    def __init__(self, progress_callback: ProgressCallback | None = None):
        """Initialize the settings migration service.
        
        Args:
            progress_callback: Optional callback for progress updates
        """
        self.progress_callback = progress_callback
        self._migration_handlers = self._get_migration_handlers()

    def _notify(self, message: str) -> None:
        """Notify progress via domain ProgressCallback signature."""
        if self.progress_callback:
            self.progress_callback(0, 0, message)

    def _get_migration_handlers(self) -> dict[str, Callable[[dict[str, Any]], dict[str, Any]]]:
        """Get migration handlers for different version transitions.
        
        Returns:
            Dictionary mapping version transitions to handler functions
        """
        return {
            "0.1.0->0.2.0": self._migrate_0_1_0_to_0_2_0,
            "0.2.0->0.3.0": self._migrate_0_2_0_to_0_3_0,
            "0.3.0->1.0.0": self._migrate_0_3_0_to_1_0_0,
        }

    def needs_migration(self, settings: dict[str, Any]) -> bool:
        """Check if settings need migration.
        
        Args:
            settings: Settings dictionary
            
        Returns:
            True if migration is needed, False otherwise
        """
        current_version = settings.get("version", "0.1.0")
        return current_version != self.CURRENT_VERSION

    def get_migration_path(self, from_version: str, to_version: str | None = None) -> list[str]:
        """Get the migration path from one version to another.
        
        Args:
            from_version: Starting version
            to_version: Target version (defaults to current version)
            
        Returns:
            List of version transitions needed
        """
        if to_version is None:
            to_version = self.CURRENT_VERSION

        # Define version order
        version_order = ["0.1.0", "0.2.0", "0.3.0", "1.0.0"]

        try:
            from_idx = version_order.index(from_version)
            to_idx = version_order.index(to_version)
        except ValueError as e:
            msg = f"Unknown version: {e}"
            raise MigrationError(msg)

        if from_idx >= to_idx:
            return []  # No migration needed or downgrade not supported

        # Build migration path
        migration_path = []
        for i in range(from_idx, to_idx):
            transition = f"{version_order[i]}->{version_order[i + 1]}"
            migration_path.append(transition)

        return migration_path

    def migrate_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        """Migrate settings to the current version.
        
        Args:
            settings: Settings dictionary to migrate
            
        Returns:
            Migrated settings dictionary
            
        Raises:
            MigrationError: If migration fails
        """
        if not self.needs_migration(settings):
            self._notify("Settings are already up to date")
            return settings

        current_version = settings.get("version", "0.1.0")
        migration_path = self.get_migration_path(current_version)

        self._notify(f"Migrating settings from {current_version} to {self.CURRENT_VERSION}")

        migrated_settings = settings.copy()

        for transition in migration_path:
            if transition not in self._migration_handlers:
                msg = f"No migration handler for {transition}"
                raise MigrationError(msg)

            self._notify(f"Applying migration: {transition}")

            try:
                migrated_settings = self._migration_handlers[transition](migrated_settings)
            except Exception as e:
                msg = f"Migration {transition} failed: {e}"
                raise MigrationError(msg)

        # Update version to current
        migrated_settings["version"] = self.CURRENT_VERSION
        migrated_settings["migration_date"] = datetime.now().isoformat()

        self._notify("Settings migration completed successfully")

        return migrated_settings

    def _migrate_0_1_0_to_0_2_0(self, settings: dict[str, Any]) -> dict[str, Any]:
        """Migrate settings from version 0.1.0 to 0.2.0.

        Args:
            settings: Settings dictionary

        Returns:
            Migrated settings dictionary
        """
        migrated = settings.copy()

        # Add new LLM settings with defaults
        if "llm_enabled" not in migrated:
            migrated["llm_enabled"] = False

        if "llm_model" not in migrated:
            migrated["llm_model"] = "microsoft/DialoGPT-medium"

        if "llm_quantization" not in migrated:
            migrated["llm_quantization"] = "quantized"

        # Rename old keys if they exist
        if "model" in migrated:
            migrated["selected_model"] = migrated.pop("model")

        if "quantization" in migrated:
            migrated["selected_quantization"] = migrated.pop("quantization")

        migrated["version"] = "0.2.0"
        return migrated

    def _migrate_0_2_0_to_0_3_0(self, settings: dict[str, Any]) -> dict[str, Any]:
        """Migrate settings from version 0.2.0 to 0.3.0.

        Args:
            settings: Settings dictionary

        Returns:
            Migrated settings dictionary
        """
        migrated = settings.copy()

        # Add new model options
        if migrated.get("selected_model") == "whisper-large":
            migrated["selected_model"] = "whisper-turbo"

        # Add new audio format support settings
        if "supported_formats" not in migrated:
            migrated["supported_formats"] = [".mp3", ".wav", ".m4a", ".flac"]

        # Add recording buffer settings
        if "recording_buffer_size" not in migrated:
            migrated["recording_buffer_size"] = 96000

        migrated["version"] = "0.3.0"
        return migrated

    def _migrate_0_3_0_to_1_0_0(self, settings: dict[str, Any]) -> dict[str, Any]:
        """Migrate settings from version 0.3.0 to 1.0.0.

        Args:
            settings: Settings dictionary

        Returns:
            Migrated settings dictionary
        """
        migrated = settings.copy()

        # Add new lite model options
        model_mapping = {
            "whisper-turbo": "whisper-turbo",
            "whisper-large": "whisper-turbo",
            "whisper-medium": "lite-whisper-turbo",
            "whisper-small": "lite-whisper-turbo-fast",
        }

        current_model = migrated.get("selected_model", "whisper-turbo")
        if current_model in model_mapping:
            migrated["selected_model"] = model_mapping[current_model]

        # Add new UI settings
        if "ui_theme" not in migrated:
            migrated["ui_theme"] = "system"

        if "auto_save_transcriptions" not in migrated:
            migrated["auto_save_transcriptions"] = True

        if "transcription_output_dir" not in migrated:
            migrated["transcription_output_dir"] = "./transcriptions"

        # Remove deprecated settings
        deprecated_keys = ["recording_buffer_size", "supported_formats"]
        for key in deprecated_keys:
            migrated.pop(key, None)

        migrated["version"] = "1.0.0"
        return migrated

    def create_migration_backup(
    self,
    settings: dict[str,
    Any],
    backup_dir: str = "./backups") -> str:
        """Create a backup of settings before migration.

        Args:
            settings: Settings to backup
            backup_dir: Directory to store backup

        Returns:
            Path to the backup file
        """
        backup_path = Path(backup_dir)
        backup_path.mkdir(parents=True, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        current_version = settings.get("version", "unknown")
        backup_file = backup_path / f"settings_v{current_version}_{timestamp}.json"

        with open(backup_file, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2, ensure_ascii=False)

        self._notify(f"Created migration backup: {backup_file.name}")

        return str(backup_file)

    def validate_migration(self, original_settings: dict[str, Any],
                          migrated_settings: dict[str, Any]) -> list[str]:
        """Validate that migration was successful.

        Args:
            original_settings: Original settings before migration
            migrated_settings: Settings after migration

        Returns:
            List of validation warnings/errors
        """
        warnings = []

        # Check that version was updated
        if migrated_settings.get("version") != self.CURRENT_VERSION:
            warnings.append(f"Version not updated to {self.CURRENT_VERSION}")

        # Check for data loss (important settings)
        important_keys = ["selected_model", "selected_quantization", "rec_key"]
        for key in important_keys:
            if key in original_settings and key not in migrated_settings:
                warnings.append(f"Important setting lost during migration: {key}")

        # Check for type changes in critical settings
        for key in ["enable_recording_sound", "current_output_srt", "llm_enabled"]:
            if (key in original_settings and key in migrated_settings and
                type(original_settings[key]) != type(migrated_settings[key])):
                warnings.append(f"Type changed for {key}: {type(original_settings[key])} -> {type(migrated_settings[key])}")

        return warnings

    def get_supported_versions(self) -> list[str]:
        """Get list of supported versions for migration.

        Returns:
            List of supported version strings
        """
        return ["0.1.0", "0.2.0", "0.3.0", "1.0.0"]

    def add_migration_handler(
    self,
    transition: str,
    handler: Callable[[dict[str,
    Any]],
    dict[str,
    Any]]) -> None:
        """Add a custom migration handler.

        Args:
            transition: Version transition (e.g., "1.0.0->1.1.0")
            handler: Migration handler function
        """
        self._migration_handlers[transition] = handler

    def load_settings_from_json(self, ui_controls: dict[str, Any] | None = None) -> dict[str, Any]:
        """Load settings from JSON and apply defaults.

        Extracted from settings_dialog.py (lines 1265-1294).

        Args:
            ui_controls: Optional dictionary of UI controls to update

        Returns:
            Dictionary containing loaded settings with defaults
        """
        try:
            # Import here to avoid circular dependencies
            from src.infrastructure.common.configuration_service import get_config

            settings = get_config()

            # Define default values
            defaults = {
                "model": "whisper-turbo",
                "quantization": "quantized",
                "recording_sound_enabled": True,
                "sound_file_path": "",
                "output_srt": False,
                "recording_key": "F2",
                "llm_enabled": False,
                "llm_model": "gemma-3-1b-it",
                "llm_quantization": "Full",
                "llm_prompt": "You are a helpful assistant.",
            }

            # Populate default values from saved settings if available
            loaded_settings = {
                "default_model": settings.get("model", defaults["model"]),
                "default_quantization": settings.get("quantization", defaults["quantization"]),
                "default_recording_sound": settings.get("recording_sound_enabled", defaults["recording_sound_enabled"]),
                "default_sound_path": settings.get("sound_file_path", defaults["sound_file_path"]),
                "default_output_srt": settings.get("output_srt", defaults["output_srt"]),
                "default_rec_key": settings.get("recording_key", defaults["recording_key"]),
                "default_llm_enabled": settings.get("llm_enabled", defaults["llm_enabled"]),
                "default_llm_model": settings.get("llm_model", defaults["llm_model"]),
                "default_llm_quantization": settings.get("llm_quantization", defaults["llm_quantization"]),
                "default_llm_prompt": settings.get("llm_prompt", defaults["llm_prompt"]),
            }

            # Apply LLM settings to UI controls if provided
            if ui_controls:
                self._apply_settings_to_ui(loaded_settings, ui_controls)

            self._notify("Settings loaded successfully from JSON")

            return loaded_settings

        except Exception as e:
            error_msg = f"Error loading settings: {e}"
            self._notify(error_msg)
            return {}

    def _apply_settings_to_ui(self, settings: dict[str, Any], ui_controls: dict[str, Any]) -> None:
        """Apply loaded settings to UI controls.

        Args:
            settings: Dictionary of loaded settings
            ui_controls: Dictionary of UI controls to update
        """
        try:
            # Apply LLM settings to UI if controls exist
            if ui_controls.get("enable_llm_toggle"):
                ui_controls["enable_llm_toggle"].setChecked(settings.get("default_llm_enabled", False))

            if ui_controls.get("llm_model_combo"):
                ui_controls["llm_model_combo"].setCurrentText(settings.get("default_llm_model", "gemma-3-1b-it"))

            if ui_controls.get("llm_quant_combo"):
                ui_controls["llm_quant_combo"].setCurrentText(settings.get("default_llm_quantization", "Full"))

            if ui_controls.get("llm_prompt_textbox"):
                ui_controls["llm_prompt_textbox"].setText(settings.get("default_llm_prompt",
                "You are a helpful assistant."))

        except Exception as e:
            self._notify(f"Error applying settings to UI: {e}")