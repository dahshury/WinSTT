"""Settings Repository Interface.

This module defines the abstract repository interface for settings persistence,
following the Repository pattern for clean architecture separation.
"""

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from src_refactored.domain.common.result import Result


class SettingsRepository(ABC):
    """Abstract repository interface for settings persistence.
    
    Defines the contract for settings storage and retrieval operations,
    allowing different implementations (JSON, database, etc.) while
    maintaining clean architecture principles.
    """

    @abstractmethod
    def load_settings(self) -> Result[dict[str, Any]]:
        """Load settings from storage.
        
        Returns:
            Result containing settings dictionary or error
        """

    @abstractmethod
    def save_settings(self, settings: dict[str, Any]) -> Result[None]:
        """Save settings to storage.
        
        Args:
            settings: Settings dictionary to save
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def get_setting(self, key: str, default: Any = None,
    ) -> Result[Any]:
        """Get a specific setting value.
        
        Args:
            key: Setting key to retrieve
            default: Default value if key not found
            
        Returns:
            Result containing setting value or error
        """

    @abstractmethod
    def set_setting(self, key: str, value: Any,
    ) -> Result[None]:
        """Set a specific setting value.
        
        Args:
            key: Setting key to set
            value: Value to set
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def has_setting(self, key: str,
    ) -> Result[bool]:
        """Check if a setting exists.
        
        Args:
            key: Setting key to check
            
        Returns:
            Result containing boolean indicating existence
        """

    @abstractmethod
    def delete_setting(self, key: str,
    ) -> Result[None]:
        """Delete a specific setting.
        
        Args:
            key: Setting key to delete
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def get_all_keys(self) -> Result[list[str]]:
        """Get all setting keys.
        
        Returns:
            Result containing list of all setting keys
        """

    @abstractmethod
    def clear_all_settings(self) -> Result[None]:
        """Clear all settings.
        
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def backup_settings(self, backup_path: Path | None = None) -> Result[Path]:
        """Create a backup of current settings.
        
        Args:
            backup_path: Optional path for backup file
            
        Returns:
            Result containing path to backup file
        """

    @abstractmethod
    def restore_settings(self, backup_path: Path,
    ) -> Result[None]:
        """Restore settings from backup.
        
        Args:
            backup_path: Path to backup file
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def validate_settings(self, settings: dict[str, Any]) -> Result[None]:
        """Validate settings before saving.
        
        Args:
            settings: Settings dictionary to validate
            
        Returns:
            Result indicating validation success or failure
        """

    @abstractmethod
    def get_settings_info(self) -> Result[dict[str, Any]]:
        """Get metadata about the settings storage.
        
        Returns:
            Result containing settings metadata (size, last modified, etc.)
        """
