"""Settings file repository for managing file-based settings operations."""

import json
from pathlib import Path
from typing import Any

from src.domain.transcription.value_objects import ProgressCallback


class SettingsFileRepository:
    """Infrastructure service for file-based settings persistence."""

    def __init__(self, settings_file_path: str = "settings.json",
                 progress_callback: ProgressCallback | None = None):
        """Initialize the settings file repository.
        
        Args:
            settings_file_path: Path to the settings file
            progress_callback: Optional callback for progress updates
        """
        self.settings_file_path = Path(settings_file_path)
        self.progress_callback = progress_callback
        self._ensure_settings_directory()

    def _notify(self, message: str) -> None:
        """Notify progress via domain ProgressCallback signature."""
        if self.progress_callback:
            self.progress_callback(0, 0, message)

    def _ensure_settings_directory(self) -> None:
        """Ensure settings directory exists."""
        self.settings_file_path.parent.mkdir(parents=True, exist_ok=True)

    def load_settings(self) -> dict[str, Any]:
        """Load settings from file.
        
        Returns:
            Dictionary containing settings data
        """
        if not self.settings_file_path.exists():
            self._notify("Settings file not found, using defaults")
            return {}

        try:
            with open(self.settings_file_path, encoding="utf-8") as f:
                settings = json.load(f)

            self._notify("Settings loaded successfully")

            return settings
        except (OSError, json.JSONDecodeError) as e:
            self._notify(f"Error loading settings: {e}")
            return {}

    def save_settings(self, settings: dict[str, Any]) -> bool:
        """Save settings to file.
        
        Args:
            settings: Dictionary containing settings data
            
        Returns:
            True if settings were saved successfully, False otherwise
        """
        try:
            # Create backup of existing settings
            if self.settings_file_path.exists():
                backup_path = self.settings_file_path.with_suffix(".json.backup")
                self.settings_file_path.replace(backup_path)

            with open(self.settings_file_path, "w", encoding="utf-8") as f:
                json.dump(settings, f, indent=2, ensure_ascii=False)

            self._notify("Settings saved successfully")

            return True
        except (OSError, TypeError) as e:
            self._notify(f"Error saving settings: {e}")
            return False

    def backup_settings(self, backup_suffix: str | None = None) -> str:
        """Create a backup of current settings.
        
        Args:
            backup_suffix: Optional suffix for backup file
            
        Returns:
            Path to the backup file
            
        Raises:
            FileNotFoundError: If settings file doesn't exist
        """
        if not self.settings_file_path.exists():
            msg = f"Settings file not found: {self.settings_file_path}"
            raise FileNotFoundError(msg)

        if backup_suffix:
            backup_path = self.settings_file_path.with_suffix(f".{backup_suffix}.backup")
        else:
            from datetime import datetime
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_path = self.settings_file_path.with_suffix(f".{timestamp}.backup")

        backup_path.write_bytes(self.settings_file_path.read_bytes())

        self._notify(f"Settings backed up to {backup_path.name}")

        return str(backup_path,
    )

    def restore_settings(self, backup_file_path: str,
    ) -> bool:
        """Restore settings from backup.
        
        Args:
            backup_file_path: Path to the backup file
            
        Returns:
            True if settings were restored successfully, False otherwise
        """
        backup_path = Path(backup_file_path)
        if not backup_path.exists():
            self._notify(f"Backup file not found: {backup_path}")
            return False

        try:
            # Validate backup file is valid JSON
            with open(backup_path, encoding="utf-8") as f:
                json.load(f)

            # Copy backup to settings file
            self.settings_file_path.write_bytes(backup_path.read_bytes())

            self._notify("Settings restored from backup")

            return True
        except (OSError, json.JSONDecodeError) as e:
            self._notify(f"Error restoring settings: {e}")
            return False

    def list_backups(self) -> list[str]:
        """List available backup files.
        
        Returns:
            List of backup file paths
        """
        backup_pattern = f"{self.settings_file_path.stem}.*.backup"
        backup_files = []

        for backup_file in self.settings_file_path.parent.glob(backup_pattern):
            if backup_file.is_file():
                backup_files.append(str(backup_file))

        return sorted(backup_files, reverse=True)  # Most recent first

    def delete_backup(self, backup_file_path: str,
    ) -> bool:
        """Delete a backup file.
        
        Args:
            backup_file_path: Path to the backup file
            
        Returns:
            True if backup was deleted, False otherwise
        """
        backup_path = Path(backup_file_path)
        if backup_path.exists():
            backup_path.unlink()
            self._notify(f"Deleted backup {backup_path.name}")
            return True
        return False

    def get_setting(self, key: str, default: Any = None) -> Any:
        """Get a specific setting value.
        
        Args:
            key: Setting key (supports dot notation for nested keys)
            default: Default value if key not found
            
        Returns:
            Setting value or default
        """
        settings = self.load_settings()

        # Support dot notation for nested keys
        keys = key.split(".",
    )
        value = settings

        for k in keys:
            if isinstance(value, dict) and k in value:
                value = value[k]
            else:
                return default

        return value

    def set_setting(self, key: str, value: Any,
    ) -> bool:
        """Set a specific setting value.
        
        Args:
            key: Setting key (supports dot notation for nested keys)
            value: Setting value
            
        Returns:
            True if setting was saved successfully, False otherwise
        """
        settings = self.load_settings()

        # Support dot notation for nested keys
        keys = key.split(".")
        current = settings

        # Navigate to the parent of the target key
        for k in keys[:-1]:
            if k not in current:
                current[k] = {}
            current = current[k]

        # Set the final key
        current[keys[-1]] = value

        return self.save_settings(settings)

    def delete_setting(self, key: str,
    ) -> bool:
        """Delete a specific setting.
        
        Args:
            key: Setting key (supports dot notation for nested keys)
            
        Returns:
            True if setting was deleted and saved successfully, False otherwise
        """
        settings = self.load_settings()

        # Support dot notation for nested keys
        keys = key.split(".")
        current = settings

        # Navigate to the parent of the target key
        for k in keys[:-1]:
            if k not in current or not isinstance(current[k], dict):
                return False  # Key path doesn't exist
            current = current[k]

        # Delete the final key
        if keys[-1] in current:
            del current[keys[-1]]
            return self.save_settings(settings)

        return False

    def settings_exist(self) -> bool:
        """Check if settings file exists.
        
        Returns:
            True if settings file exists, False otherwise
        """
        return self.settings_file_path.exists()

    def get_settings_file_size(self) -> int:
        """Get the size of the settings file in bytes.
        
        Returns:
            File size in bytes, 0 if file doesn't exist
        """
        if self.settings_file_path.exists():
            return self.settings_file_path.stat().st_size
        return 0