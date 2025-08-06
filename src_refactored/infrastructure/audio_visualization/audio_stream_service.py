"""Audio Stream Service for Visualization.

This module implements specialized audio stream management for visualization purposes,
extracted from the original voice_visualizer.py with PyAudio stream initialization
and fallback handling capabilities.
"""

import logging
import time
from dataclasses import dataclass
from enum import Enum
from typing import Protocol

import pyaudio
from PyQt6.QtCore import QObject, pyqtSignal


class StreamInitializationResult(Enum):
    """Result of stream initialization attempt."""
    SUCCESS = "success"
    FAILED_FLOAT32 = "failed_float32"
    FAILED_INT16 = "failed_int16"
    FAILED_COMPLETE = "failed_complete"


@dataclass
class StreamConfiguration:
    """Configuration for audio stream initialization."""
    sample_rate: int = 16000
    chunk_size: int = 1024
    channels: int = 1
    primary_format: int = pyaudio.paFloat32
    fallback_format: int = pyaudio.paInt16


@dataclass
class StreamInitializationResponse:
    """Response from stream initialization."""
    result: StreamInitializationResult
    audio_instance: pyaudio.PyAudio | None = None
    stream_instance: pyaudio.Stream | None = None
    format_used: int | None = None
    error_message: str | None = None
    initialization_time: float = 0.0


class IAudioStreamInitializer(Protocol,
    ):
    """Protocol for audio stream initialization."""

    def initialize_stream(self, config: StreamConfiguration,
    ) -> StreamInitializationResponse:
        """Initialize audio stream with configuration."""
        ...

    def cleanup_stream(self, audio: pyaudio.PyAudio, stream: pyaudio.Stream) -> bool:
        """Clean up audio stream resources."""
        ...


class PyAudioStreamInitializer:
    """PyAudio-based stream initializer with fallback support."""

    def __init__(self):
        self.logger = logging.getLogger(__name__)

    def initialize_stream(self, config: StreamConfiguration,
    ) -> StreamInitializationResponse:
        """Initialize PyAudio stream with fallback handling.
        
        Attempts to initialize with primary format (float32), falls back to
        secondary format (int16) if primary fails.
        """
        start_time = time.time()

        # First attempt with primary format (float32)
        response = self._attempt_initialization(
            config, config.primary_format, "primary",
        )

        if response.result == StreamInitializationResult.SUCCESS:
            response.initialization_time = time.time() - start_time
            return response

        self.logger.warning("Primary format initialization failed: {response.error_message}")

        # Cleanup failed attempt
        if response.audio_instance:
            self._cleanup_failed_attempt(response.audio_instance, response.stream_instance)

        # Second attempt with fallback format (int16)
        response = self._attempt_initialization(
            config, config.fallback_format, "fallback",
        )

        response.initialization_time = time.time() - start_time
        return response

    def _attempt_initialization(
        self,
        config: StreamConfiguration,
        audio_format: int,
        attempt_type: str,
    ) -> StreamInitializationResponse:
        """Attempt stream initialization with specific format."""
        try:
            # Initialize PyAudio instance
            audio = pyaudio.PyAudio()

            # Open input stream
            stream = audio.open(
                format=audio_format,
                channels=config.channels,
                rate=config.sample_rate,
                input=True,
                frames_per_buffer=config.chunk_size,
                start=True,
            )

            self.logger.info(
                f"Successfully initialized {attempt_type} audio stream "
                f"(format: {audio_format}, rate: {config.sample_rate})",
            )

            return StreamInitializationResponse(
                result=StreamInitializationResult.SUCCESS,
                audio_instance=audio,
                stream_instance=stream,
                format_used=audio_format,
            )

        except Exception as e:
            error_msg = f"Failed to initialize {attempt_type} audio stream: {e}"
            self.logger.exception(error_msg)

            result = (
                StreamInitializationResult.FAILED_FLOAT32
                if audio_format == pyaudio.paFloat32
                else StreamInitializationResult.FAILED_INT16
            )

            return StreamInitializationResponse(
                result=result,
                error_message=error_msg,
            )

    def _cleanup_failed_attempt(
        self,
        audio: pyaudio.PyAudio,
        stream: pyaudio.Stream | None,
    ) -> None:
        """Clean up resources from failed initialization attempt."""
        try:
            if stream:
                stream.close()
            if audio:
                audio.terminate()
        except Exception:
            self.logger.warning("Error during cleanup of failed attempt: {e}")

    def cleanup_stream(self, audio: pyaudio.PyAudio, stream: pyaudio.Stream) -> bool:
        """Clean up audio stream resources."""
        try:
            if stream:
                stream.stop_stream()
                stream.close()
            if audio:
                audio.terminate()
            return True
        except Exception as e:
            self.logger.exception(f"Error during stream cleanup: {e}")
            return False


class AudioStreamManager(QObject):
    """Manager for audio stream lifecycle with PyQt integration."""

    # Signals
    stream_initialized = pyqtSignal(int)  # format_used
    stream_failed = pyqtSignal(str)       # error_message
    stream_cleaned_up = pyqtSignal()

    def __init__(self, initializer: IAudioStreamInitializer | None = None):
        super().__init__()
        self.initializer = initializer or PyAudioStreamInitializer()
        self.logger = logging.getLogger(__name__)

        # Current stream state
        self.audio_instance: pyaudio.PyAudio | None = None
        self.stream_instance: pyaudio.Stream | None = None
        self.current_format: int | None = None
        self.is_initialized = False

    def initialize_stream(self, config: StreamConfiguration | None = None) -> bool:
        """Initialize audio stream with configuration."""
        if self.is_initialized:
            self.logger.warning("Stream already initialized")
            return True

        config = config or StreamConfiguration()

        response = self.initializer.initialize_stream(config)

        if response.result == StreamInitializationResult.SUCCESS:
            self.audio_instance = response.audio_instance
            self.stream_instance = response.stream_instance
            self.current_format = response.format_used
            self.is_initialized = True

            self.stream_initialized.emit(response.format_used)
            self.logger.info(f"Stream initialized successfully in {response.initialization_time:.3f}s")
            return True
        error_msg = response.error_message or "Unknown initialization error"
        self.stream_failed.emit(error_msg)
        self.logger.error("Stream initialization failed: {error_msg}")
        return False

    def cleanup_stream(self) -> bool:
        """Clean up current audio stream."""
        if not self.is_initialized:
            return True

        success = self.initializer.cleanup_stream(
            self.audio_instance,
            self.stream_instance,
        )

        # Reset state regardless of cleanup success
        self.audio_instance = None
        self.stream_instance = None
        self.current_format = None
        self.is_initialized = False

        if success:
            self.stream_cleaned_up.emit()
            self.logger.info("Stream cleaned up successfully")
        else:
            self.logger.error("Stream cleanup encountered errors")

        return success

    def get_stream_info(self) -> dict:
        """Get current stream information."""
        return {
            "initialized": self.is_initialized,
            "format": self.current_format,
            "has_audio_instance": self.audio_instance is not None,
            "has_stream_instance": self.stream_instance is not None,
        }


class AudioStreamService:
    """High-level service for audio stream management in visualization context."""

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self._managers: dict[str, AudioStreamManager] = {}

    def create_stream_manager(
        self,
        manager_id: str,
        initializer: IAudioStreamInitializer | None = None,
    ) -> AudioStreamManager:
        """Create a new audio stream manager."""
        if manager_id in self._managers:
            self.logger.warning("Manager {manager_id} already exists")
            return self._managers[manager_id]

        manager = AudioStreamManager(initializer)
        self._managers[manager_id] = manager

        self.logger.info("Created audio stream manager: {manager_id}")
        return manager

    def get_stream_manager(self, manager_id: str,
    ) -> AudioStreamManager | None:
        """Get existing stream manager by ID."""
        return self._managers.get(manager_id)

    def remove_stream_manager(self, manager_id: str,
    ) -> bool:
        """Remove and cleanup stream manager."""
        manager = self._managers.get(manager_id)
        if not manager:
            return False

        # Cleanup stream before removal
        manager.cleanup_stream()
        del self._managers[manager_id]

        self.logger.info("Removed audio stream manager: {manager_id}")
        return True

    def cleanup_all_streams(self) -> None:
        """Clean up all managed streams."""
        for manager in self._managers.values():
            manager.cleanup_stream()
            self.logger.info("Cleaned up stream manager: {manager_id}")

        self._managers.clear()

    def get_service_stats(self) -> dict:
        """Get service statistics."""
        return {
            "total_managers": len(self._managers),
            "initialized_streams": sum(
                1 for manager in self._managers.values()
                if manager.is_initialized
            ),
            "manager_ids": list(self._managers.keys()),
        }