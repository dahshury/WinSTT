"""PyQt Audio Adapter Infrastructure Service.

This module provides PyQt signal integration for audio recording functionality,
wrapping the core AudioToText class with PyQt signals without modifying the original implementation.
"""

from collections.abc import Callable
from typing import Any

from PyQt6.QtCore import QObject, pyqtSignal


class PyQtAudioAdapter(QObject):
    """Adapter that wraps AudioToText and provides PyQt signals.
    
    This adapter follows the Adapter pattern to add PyQt signal capabilities
    to the core AudioToText class without modifying its implementation.
    
    Signals:
        recording_started_signal: Emitted when recording starts
        recording_stopped_signal: Emitted when recording stops
    """

    recording_started_signal = pyqtSignal()
    recording_stopped_signal = pyqtSignal()

    def __init__(self, audio_to_text_instance: Any,
    ):
        """Initialize the PyQt adapter.
        
        Args:
            audio_to_text_instance: The AudioToText instance to wrap
        """
        super().__init__()
        self.audio_to_text = audio_to_text_instance

        # Store the original key event handler
        self._original_key_handler = self.audio_to_text._key_event_handler

        # Override with our signal-emitting handler
        self.audio_to_text._key_event_handler = self._key_event_handler_with_signals

    def _key_event_handler_with_signals(self, event: Any,
    ) -> None:
        """Wrapper around the original key handler that adds signal emission.
        
        Args:
            event: The key event to handle
        """
        was_recording = self.audio_to_text.is_recording

        # Call the original handler
        self._original_key_handler(event)

        # Check if state changed and emit appropriate signals
        if not was_recording and self.audio_to_text.is_recording:
            self.recording_started_signal.emit()
        elif was_recording and not self.audio_to_text.is_recording:
            self.recording_stopped_signal.emit()

    def __getattr__(self, name: str,
    ) -> Any:
        """Delegate all method calls to the wrapped instance.
        
        Args:
            name: The attribute name to access
            
        Returns:
            The attribute from the wrapped AudioToText instance
        """
        return getattr(self.audio_to_text, name)

    @property
    def start_sound_file(self) -> str | None:
        """Get the start sound file path."""
        return self.audio_to_text.start_sound_file

    @start_sound_file.setter
    def start_sound_file(self, value: str | None) -> None:
        """Set the start sound file path.
        
        Args:
            value: The path to the sound file
        """
        self.audio_to_text.start_sound_file = value

    @property
    def start_sound(self) -> bool:
        """Get the start sound enabled state."""
        return self.audio_to_text.start_sound

    @start_sound.setter
    def start_sound(self, value: bool,
    ) -> None:
        """Set the start sound enabled state.
        
        Args:
            value: Whether to enable start sound
        """
        self.audio_to_text.start_sound = value


class PyQtAudioAdapterService:
    """Service for creating and managing PyQt audio adapters.
    
    This service provides a clean interface for creating PyQt-enabled
    audio recording adapters with proper signal integration.
    """

    def create_adapter(self, audio_to_text_instance: Any,
    ) -> PyQtAudioAdapter:
        """Create a PyQt adapter for an AudioToText instance.
        
        Args:
            audio_to_text_instance: The AudioToText instance to wrap
            
        Returns:
            A PyQtAudioAdapter with signal capabilities
        """
        return PyQtAudioAdapter(audio_to_text_instance)

    def create_adapter_with_factory(
        self,
        model_cls: type,
        vad_cls: type,
        rec_key: str | None = None,
        error_callback: Callable | None = None,
    ) -> PyQtAudioAdapter:
        """Create a PyQt adapter with AudioToText factory method.
        
        Args:
            model_cls: The model class for transcription
            vad_cls: The VAD class for voice activity detection
            rec_key: The recording key binding
            error_callback: Optional error callback function
            
        Returns:
            A PyQtAudioAdapter with signal capabilities
        """
        # Import here to avoid circular dependencies
        from utils.listener import AudioToText

        audio_to_text = AudioToText(model_cls, vad_cls, rec_key or "", error_callback=error_callback)
        return self.create_adapter(audio_to_text)


class PyQtAudioAdapterManager:
    """High-level manager for PyQt audio adapter operations.
    
    This manager provides a simplified interface for common audio adapter
    patterns and lifecycle management.
    """

    def __init__(self):
        """Initialize the adapter manager."""
        self._service = PyQtAudioAdapterService()
        self._active_adapters: list[PyQtAudioAdapter] = []

    def create_recording_adapter(
        self,
        model_cls: type,
        vad_cls: type,
        rec_key: str | None = None,
        error_callback: Callable | None = None,
    ) -> PyQtAudioAdapter:
        """Create and register a recording adapter.
        
        Args:
            model_cls: The model class for transcription
            vad_cls: The VAD class for voice activity detection
            rec_key: The recording key binding
            error_callback: Optional error callback function
            
        Returns:
            A configured PyQtAudioAdapter
        """
        adapter = self._service.create_adapter_with_factory(
            model_cls, vad_cls, rec_key, error_callback,
        )
        self._active_adapters.append(adapter)
        return adapter

    def cleanup_adapters(self) -> None:
        """Clean up all active adapters."""
        for adapter in self._active_adapters:
            # Restore original key handler if needed
            if hasattr(adapter, "_original_key_handler"):
                adapter.audio_to_text._key_event_handler = adapter._original_key_handler

        self._active_adapters.clear()

    def get_active_adapters(self) -> list[PyQtAudioAdapter]:
        """Get all active adapters.
        
        Returns:
            List of active PyQtAudioAdapter instances
        """
        return self._active_adapters.copy()