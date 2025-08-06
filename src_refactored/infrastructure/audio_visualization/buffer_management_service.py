"""Buffer Management Service for rolling buffer management.

This module implements the BufferManagementService that provides
rolling buffer management with progress tracking.
Extracted from src/ui/voice_visualizer.py lines 114-119, 20-25.
"""

import threading
from dataclasses import dataclass
from typing import Protocol

import numpy as np
from PyQt6.QtCore import QObject, pyqtSignal

from src_refactored.domain.audio_visualization.value_objects.audio_buffer import AudioBuffer
from src_refactored.infrastructure.system.logging_service import LoggingService


@dataclass
class BufferConfiguration:
    """Configuration for audio buffer management."""
    chunk_size: int = 1024
    buffer_size: int = 100  # Number of chunks
    sample_rate: int = 16000
    max_buffer_count: int = 10
    enable_overflow_protection: bool = True


class BufferManagementServiceProtocol(Protocol,
    ):
    """Protocol for buffer management service."""

    def create_buffer(self, config: BufferConfiguration,
    ) -> AudioBuffer:
        """Create a new audio buffer."""
        ...

    def update_buffer(self, buffer: AudioBuffer, new_data: np.ndarray) -> bool:
        """Update buffer with new audio data."""
        ...

    def get_buffer_data(self, buffer: AudioBuffer,
    ) -> np.ndarray:
        """Get current buffer data."""
        ...

    def clear_buffer(self, buffer: AudioBuffer,
    ) -> None:
        """Clear buffer contents."""
        ...

    def resize_buffer(self, buffer: AudioBuffer, new_size: int,
    ) -> bool:
        """Resize buffer capacity."""
        ...


class RollingAudioBuffer:
    """Thread-safe rolling audio buffer implementation.
    
    Provides efficient rolling buffer operations for audio data
    with thread safety and overflow protection.
    """

    def __init__(self, config: BufferConfiguration,
    ):
        """Initialize the rolling buffer.
        
        Args:
            config: Buffer configuration
        """
        self.config = config
        self.total_size = config.chunk_size * config.buffer_size
        self._buffer = np.zeros(self.total_size, dtype=np.float32)
        self._lock = threading.RLock()
        self._overflow_count = 0
        self.logger = LoggingService().get_logger("RollingAudioBuffer")

    def update(self, new_data: np.ndarray) -> bool:
        """Update buffer with new audio data using rolling window.
        
        Args:
            new_data: New audio data to add
            
        Returns:
            True if update successful, False otherwise
        """
        if new_data is None or len(new_data) == 0:
            return False

        with self._lock:
            try:
                # Check for overflow protection
                if self.config.enable_overflow_protection and len(new_data) > self.total_size:
                    self._overflow_count += 1
                    if self._overflow_count % 100 == 0:  # Log every 100 overflows
                        self.logger.warning("Buffer overflow detected {self._overflow_count} times")
                    # Truncate data to fit buffer
                    new_data = new_data[-self.total_size:]

                # Roll the buffer and add new data
                self._buffer = np.roll(self._buffer, -len(new_data))
                self._buffer[-len(new_data):] = new_data

                return True

            except Exception as e:
                self.logger.exception(f"Error updating buffer: {e}")
                return False

    def get_data(self) -> np.ndarray:
        """Get current buffer data (thread-safe copy).
        
        Returns:
            Copy of current buffer data
        """
        with self._lock:
            return self._buffer.copy()

    def clear(self) -> None:
        """Clear buffer contents."""
        with self._lock:
            self._buffer.fill(0.0)
            self._overflow_count = 0

    def resize(self, new_chunk_size: int, new_buffer_size: int,
    ) -> bool:
        """Resize buffer dimensions.
        
        Args:
            new_chunk_size: New chunk size
            new_buffer_size: New buffer size (number of chunks)
            
        Returns:
            True if resize successful, False otherwise
        """
        with self._lock:
            try:
                old_data = self._buffer.copy()
                new_total_size = new_chunk_size * new_buffer_size

                # Create new buffer
                new_buffer = np.zeros(new_total_size, dtype=np.float32)

                # Copy as much old data as possible
                copy_size = min(len(old_data), new_total_size)
                if copy_size > 0:
                    new_buffer[-copy_size:] = old_data[-copy_size:]

                # Update configuration and buffer
                self.config.chunk_size = new_chunk_size
                self.config.buffer_size = new_buffer_size
                self.total_size = new_total_size
                self._buffer = new_buffer

                self.logger.info("Buffer resized to {new_chunk_size}x{new_buffer_size}")
                return True

            except Exception as e:
                self.logger.exception(f"Error resizing buffer: {e}")
                return False

    @property
    def size(self) -> int:
        """Get current buffer size."""
        return self.total_size

    @property
    def overflow_count(self) -> int:
        """Get overflow count."""
        return self._overflow_count


class BufferManager(QObject):
    """Manager for multiple audio buffers with signal support.
    
    Provides high-level interface for managing multiple audio buffers
    with PyQt signal integration for UI updates.
    """

    # Signals for buffer events
    buffer_updated = pyqtSignal(str, np.ndarray)  # buffer_id, data
    buffer_overflow = pyqtSignal(str, int)  # buffer_id, overflow_count
    buffer_cleared = pyqtSignal(str)  # buffer_id
    buffer_resized = pyqtSignal(str, int, int)  # buffer_id, new_chunk_size, new_buffer_size

    def __init__(self, parent: QObject | None = None):
        """Initialize the buffer manager.
        
        Args:
            parent: Parent QObject
        """
        super().__init__(parent)
        self._buffers: dict[str, RollingAudioBuffer] = {}
        self._buffer_configs: dict[str, BufferConfiguration] = {}
        self.logger = LoggingService().get_logger("BufferManager")

    def create_buffer(self, buffer_id: str, config: BufferConfiguration,
    ) -> bool:
        """Create a new audio buffer.
        
        Args:
            buffer_id: Unique buffer identifier
            config: Buffer configuration
            
        Returns:
            True if created successfully, False otherwise
        """
        if buffer_id in self._buffers:
            self.logger.warning("Buffer already exists: {buffer_id}")
            return False

        try:
            buffer = RollingAudioBuffer(config)
            self._buffers[buffer_id] = buffer
            self._buffer_configs[buffer_id] = config

            self.logger.info("Created buffer: {buffer_id}")
            return True

        except Exception as e:
            self.logger.exception(f"Error creating buffer {buffer_id}: {e}")
            return False

    def update_buffer(self, buffer_id: str, new_data: np.ndarray) -> bool:
        """Update buffer with new audio data.
        
        Args:
            buffer_id: Buffer identifier
            new_data: New audio data
            
        Returns:
            True if updated successfully, False otherwise
        """
        buffer = self._buffers.get(buffer_id)
        if not buffer:
            self.logger.error("Buffer not found: {buffer_id}")
            return False

        success = buffer.update(new_data)
        if success:
            # Emit signal with updated data
            self.buffer_updated.emit(buffer_id, buffer.get_data())

            # Check for overflow
            if buffer.overflow_count > 0:
                self.buffer_overflow.emit(buffer_id, buffer.overflow_count)

        return success

    def get_buffer_data(self, buffer_id: str,
    ) -> np.ndarray | None:
        """Get current buffer data.
        
        Args:
            buffer_id: Buffer identifier
            
        Returns:
            Buffer data or None if buffer not found
        """
        buffer = self._buffers.get(buffer_id)
        if not buffer:
            self.logger.error("Buffer not found: {buffer_id}")
            return None

        return buffer.get_data()

    def clear_buffer(self, buffer_id: str,
    ) -> bool:
        """Clear buffer contents.
        
        Args:
            buffer_id: Buffer identifier
            
        Returns:
            True if cleared successfully, False otherwise
        """
        buffer = self._buffers.get(buffer_id)
        if not buffer:
            self.logger.error("Buffer not found: {buffer_id}")
            return False

        buffer.clear()
        self.buffer_cleared.emit(buffer_id)
        self.logger.debug("Cleared buffer: {buffer_id}")
        return True

    def resize_buffer(self, buffer_id: str, new_chunk_size: int, new_buffer_size: int,
    ) -> bool:
        """Resize buffer capacity.
        
        Args:
            buffer_id: Buffer identifier
            new_chunk_size: New chunk size
            new_buffer_size: New buffer size (number of chunks)
            
        Returns:
            True if resized successfully, False otherwise
        """
        buffer = self._buffers.get(buffer_id)
        if not buffer:
            self.logger.error("Buffer not found: {buffer_id}")
            return False

        success = buffer.resize(new_chunk_size, new_buffer_size)
        if success:
            # Update stored configuration
            config = self._buffer_configs.get(buffer_id)
            if config:
                config.chunk_size = new_chunk_size
                config.buffer_size = new_buffer_size

            self.buffer_resized.emit(buffer_id, new_chunk_size, new_buffer_size)

        return success

    def remove_buffer(self, buffer_id: str,
    ) -> bool:
        """Remove a buffer.
        
        Args:
            buffer_id: Buffer identifier
            
        Returns:
            True if removed successfully, False otherwise
        """
        if buffer_id not in self._buffers:
            self.logger.warning("Buffer not found for removal: {buffer_id}")
            return False

        try:
            del self._buffers[buffer_id]
            del self._buffer_configs[buffer_id]
            self.logger.info("Removed buffer: {buffer_id}")
            return True

        except Exception as e:
            self.logger.exception(f"Error removing buffer {buffer_id}: {e}")
            return False

    def get_buffer_info(self, buffer_id: str,
    ) -> dict | None:
        """Get buffer information.
        
        Args:
            buffer_id: Buffer identifier
            
        Returns:
            Buffer information dictionary or None if not found
        """
        buffer = self._buffers.get(buffer_id)
        config = self._buffer_configs.get(buffer_id)

        if not buffer or not config:
            return None

        return {
            "buffer_id": buffer_id,
            "chunk_size": config.chunk_size,
            "buffer_size": config.buffer_size,
            "total_size": buffer.size,
            "sample_rate": config.sample_rate,
            "overflow_count": buffer.overflow_count,
        }

    def list_buffers(self) -> list[str]:
        """Get list of active buffer IDs.
        
        Returns:
            List of buffer identifiers
        """
        return list(self._buffers.keys())

    def cleanup_all(self) -> None:
        """Clean up all buffers."""
        buffer_ids = list(self._buffers.keys())
        for buffer_id in buffer_ids:
            self.remove_buffer(buffer_id)

        self.logger.info("Cleaned up all buffers")


class BufferManagementService:
    """Service for managing audio buffers with domain integration.
    
    Provides high-level interface for buffer management that integrates
    with domain entities and application use cases.
    """

    def __init__(self, logger_service: LoggingService | None = None):
        """Initialize the buffer management service.
        
        Args:
            logger_service: Optional logger service
        """
        self.logger_service = logger_service or LoggingService()
        self.logger = self.logger_service.get_logger("BufferManagementService")
        self.buffer_manager = BufferManager()

    def create_buffer(self, config: BufferConfiguration,
    ) -> AudioBuffer:
        """Create a new audio buffer.
        
        Args:
            config: Buffer configuration
            
        Returns:
            Audio buffer domain entity
        """
        buffer_id = f"buffer_{len(self.buffer_manager.list_buffers())}"

        # Create infrastructure buffer
        success = self.buffer_manager.create_buffer(buffer_id, config)
        if not success:
            msg = f"Failed to create buffer: {buffer_id}"
            raise RuntimeError(msg)

        # Create domain entity
        from src_refactored.domain.audio_visualization.value_objects.audio_buffer import AudioBuffer
        audio_buffer = AudioBuffer.create_empty(
            max_size=config.chunk_size * config.buffer_size,
            sample_rate=config.sample_rate,
            chunk_size=config.chunk_size,
        )

        self.logger.info("Created audio buffer: {buffer_id}")
        return audio_buffer

    def update_buffer(self, buffer: AudioBuffer, new_data: np.ndarray) -> AudioBuffer:
        """Update buffer with new audio data.
        
        Args:
            buffer: Audio buffer entity
            new_data: New audio data
            
        Returns:
            Updated audio buffer
        """
        # Add samples to the buffer using the domain method
        return buffer.add_samples(new_data)

    def get_buffer_data(self, buffer: AudioBuffer,
    ) -> np.ndarray:
        """Get current buffer data.
        
        Args:
            buffer: Audio buffer entity
            
        Returns:
            Current buffer data as numpy array
        """
        if buffer.is_empty():
            return np.array([])
        
        # Concatenate all waveform data
        concatenated = buffer.concatenate_all()
        return concatenated.to_numpy_array() if concatenated else np.array([])

    def clear_buffer(self, buffer: AudioBuffer,
    ) -> AudioBuffer:
        """Clear buffer contents.
        
        Args:
            buffer: Audio buffer entity
            
        Returns:
            Cleared audio buffer
        """
        return buffer.clear()

    def resize_buffer(self, buffer: AudioBuffer, new_size: int,
    ) -> AudioBuffer:
        """Resize buffer capacity.
        
        Args:
            buffer: Audio buffer entity
            new_size: New buffer capacity
            
        Returns:
            Resized audio buffer
        """
        return buffer.resize(new_size)

    def get_buffer_manager(self) -> BufferManager:
        """Get buffer manager for signal connections.
        
        Returns:
            Buffer manager instance
        """
        return self.buffer_manager

    def cleanup_buffer(self, buffer: AudioBuffer,
    ) -> None:
        """Clean up buffer resources.
        
        Args:
            buffer: Audio buffer entity
        """
        # AudioBuffer is a value object, so no cleanup needed
        self.logger.info("Cleaned up buffer")

    def cleanup_all(self) -> None:
        """Clean up all buffer resources."""
        self.buffer_manager.cleanup_all()
        self.logger.info("Cleaned up all buffers")