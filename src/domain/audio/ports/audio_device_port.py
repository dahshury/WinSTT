"""Audio Device Port for audio device operations."""

from abc import ABC, abstractmethod
from typing import Any

from src.domain.common.result import Result


class IAudioDevicePort(ABC):
    """Port interface for audio device operations."""
    
    @abstractmethod
    def get_available_devices(self) -> Result[list[dict[str, Any]]]:
        """Get list of available audio devices.
        
        Returns:
            Result containing list of audio device information
        """
        ...
    
    @abstractmethod
    def get_default_device(self) -> Result[dict[str, Any]]:
        """Get default audio device.
        
        Returns:
            Result containing default device information
        """
        ...
    
    @abstractmethod
    def configure_device(self, device_id: str, sample_rate: int, channels: int) -> Result[None]:
        """Configure audio device settings.
        
        Args:
            device_id: Device identifier
            sample_rate: Audio sample rate
            channels: Number of audio channels
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def test_device(self, device_id: str) -> Result[bool]:
        """Test if audio device is working.
        
        Args:
            device_id: Device identifier to test
            
        Returns:
            Result containing test success status
        """
        ...


class IErrorCallbackPort(ABC):
    """Port interface for error callback operations."""
    
    @abstractmethod
    def register_error_callback(self, callback_id: str, handler: Any) -> Result[None]:
        """Register an error callback handler.
        
        Args:
            callback_id: Unique identifier for the callback
            handler: Error handler function
            
        Returns:
            Result indicating registration success
        """
        ...
    
    @abstractmethod
    def unregister_error_callback(self, callback_id: str) -> Result[None]:
        """Unregister an error callback handler.
        
        Args:
            callback_id: Callback identifier to remove
            
        Returns:
            Result indicating unregistration success
        """
        ...
    
    @abstractmethod
    def trigger_error_callback(self, callback_id: str, error_data: dict[str, Any]) -> Result[None]:
        """Trigger a specific error callback.
        
        Args:
            callback_id: Callback identifier to trigger
            error_data: Error information to pass to callback
            
        Returns:
            Result indicating callback execution success
        """
        ...