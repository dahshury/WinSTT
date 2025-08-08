"""Sound Settings Port for managing sound configuration."""

from abc import ABC, abstractmethod
from typing import Any

from src_refactored.domain.common.result import Result


class ISoundSettingsManager(ABC):
    """Port interface for sound settings management."""
    
    @abstractmethod
    def update_sound_settings(self, sound_path: str, enabled: bool) -> Result[None]:
        """Update sound settings.
        
        Args:
            sound_path: Path to sound file as string
            enabled: Whether sound is enabled
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def reset_sound_settings(self) -> Result[None]:
        """Reset sound settings to defaults.
        
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def get_sound_settings(self) -> Result[dict[str, Any]]:
        """Get current sound settings.
        
        Returns:
            Result containing sound settings or error
        """
        ...
    
    @abstractmethod
    def validate_sound_file(self, sound_path: str) -> Result[bool]:
        """Validate a sound file.
        
        Args:
            sound_path: Path to sound file to validate as string
            
        Returns:
            Result containing validation result
        """
        ...
