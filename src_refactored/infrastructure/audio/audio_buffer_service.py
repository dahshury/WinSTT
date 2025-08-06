"""Audio Buffer Service.

This module implements the AudioBufferService for managing
audio data buffers according to the protocol requirements.
"""

from collections import deque

import numpy as np

from src_refactored.domain.audio_visualization.protocols import (
    AudioBufferServiceProtocol,
)


class AudioBufferService(AudioBufferServiceProtocol):
    """Service for managing audio data buffers."""

    def __init__(self, max_size: int = 100):
        """Initialize the audio buffer service.
        
        Args:
            max_size: Maximum number of chunks to keep in buffer
        """
        self._buffer = deque(maxlen=max_size)
        self._max_size = max_size

    def update_buffer(self, data: np.ndarray) -> bool:
        """Update the circular audio buffer.
        
        Args:
            data: New audio data to add
            
        Returns:
            True if buffer updated successfully
        """
        try:
            if data is None or len(data) == 0:
                return False
                
            # Add data to buffer
            self._buffer.append(data.copy())
            return True
            
        except Exception:
            return False

    def get_buffer_data(self) -> np.ndarray:
        """Get current buffer data.
        
        Returns:
            Current buffer contents
        """
        try:
            if not self._buffer:
                return np.array([], dtype=np.float32)
                
            # Concatenate all chunks in buffer
            return np.concatenate(list(self._buffer))
            
        except Exception:
            return np.array([], dtype=np.float32)

    def get_buffer_size(self) -> int:
        """Get buffer size.
        
        Returns:
            Current buffer size
        """
        return len(self._buffer)

    def clear_buffer(self) -> None:
        """Clear the buffer."""
        self._buffer.clear()

    def get_max_size(self) -> int:
        """Get maximum buffer size.
        
        Returns:
            Maximum buffer size
        """
        return self._max_size

    def set_max_size(self, max_size: int) -> None:
        """Set maximum buffer size.
        
        Args:
            max_size: New maximum buffer size
        """
        if max_size > 0:
            self._max_size = max_size
            # Create new deque with new maxlen
            old_buffer = list(self._buffer)
            self._buffer = deque(old_buffer, maxlen=max_size)
