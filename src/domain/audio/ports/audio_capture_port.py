"""
Audio Capture Port

Abstract interface for audio recording operations.
Defines the expected behaviors of the recording adapter used by the domain.
"""

from abc import ABC, abstractmethod
from io import BytesIO
from typing import Any

from src.domain.audio.value_objects.audio_format import AudioFormat
from src.domain.common.result import Result


class AudioCapturePort(ABC):
    """
    Port interface for audio capture operations.
    
    Abstracts the audio recording hardware/library dependencies behind a stable port.
    """
    
    @abstractmethod
    def configure_audio(self, audio_format: AudioFormat) -> Result[None]:
        """
        Configure audio capture with the specified format.
        
        Args:
            audio_format: Audio format configuration
            
        Returns:
            Result indicating configuration success/failure
        """
        ...
    
    @abstractmethod
    def start_capture(self) -> Result[None]:
        """
        Start audio capture.
        
        Start the underlying audio capture device.
        
        Returns:
            Result indicating start success/failure
        """
        ...
    
    @abstractmethod
    def stop_capture(self) -> Result[None]:
        """
        Stop audio capture.
        
        Stop the underlying audio capture device.
        
        Returns:
            Result indicating stop success/failure
        """
        ...
    
    @abstractmethod
    def get_captured_audio_data(self) -> Result[bytes]:
        """
        Get the captured audio data as WAV bytes.
        
        Acquire the captured audio as WAV bytes.
        
        Returns:
            Result containing WAV format audio bytes or error
        """
        ...
    
    @abstractmethod
    def is_capturing(self) -> bool:
        """
        Check if currently capturing audio.
        
        Check the current capture state.
        
        Returns:
            True if actively capturing audio
        """
        ...
    
    @abstractmethod
    def release_resources(self, reset_for_reuse: bool = False) -> Result[None]:
        """
        Release audio capture resources.
        
        Release audio resources. If `reset_for_reuse` is True, leave device ready for reuse.
        
        Args:
            reset_for_reuse: If True, prepare for reuse; if False, full cleanup
            
        Returns:
            Result indicating cleanup success/failure
        """
        ...
    
    @abstractmethod
    def get_audio_stream(self) -> Result[BytesIO]:
        """
        Get audio data as a stream for processing.
        
        Returns:
            Result containing BytesIO stream of captured audio
        """
        ...


class AudioCaptureErrorInfo:
    """Information about audio capture errors."""
    
    def __init__(
        self, 
        error_type: str,
        error_message: str,
        is_device_error: bool = False,
        is_recoverable: bool = False,
        suggested_action: str | None = None,
        context: dict[str, Any] | None = None,
    ) -> None:
        self.error_type = error_type
        self.error_message = error_message
        self.is_device_error = is_device_error
        self.is_recoverable = is_recoverable
        self.suggested_action = suggested_action
        self.context = context or {}


class AudioDeviceError(Exception):
    """Exception for audio device related errors."""
    
    def __init__(self, error_info: AudioCaptureErrorInfo) -> None:
        self.error_info = error_info
        super().__init__(error_info.error_message)
