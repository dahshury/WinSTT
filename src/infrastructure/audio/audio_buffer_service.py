"""Audio Buffer Service.

This module implements the AudioBufferService for managing
audio data buffers according to the protocol requirements.
"""

from collections import deque

from src.domain.audio.value_objects.audio_samples import AudioSampleData
from src.domain.audio_visualization.protocols import (
    AudioBufferServiceProtocol,
)


class AudioBufferService(AudioBufferServiceProtocol):
    """Service for managing audio data buffers."""

    def __init__(self, max_size: int = 100):
        """Initialize the audio buffer service.
        
        Args:
            max_size: Maximum number of chunks to keep in buffer
        """
        self._buffer: deque[AudioSampleData] = deque(maxlen=max_size)
        self._max_size = max_size

    def add_to_buffer(self, data: AudioSampleData) -> None:
        """Add audio data to buffer."""
        self._buffer.append(data)

    def update_buffer(self, data: AudioSampleData) -> bool:
        """Update the circular audio buffer.
        
        Args:
            data: New audio data to add
            
        Returns:
            True if buffer updated successfully
        """
        try:
            if data is None or data.frame_count == 0:
                return False
                
            # Add data to buffer
            self._buffer.append(data)
            return True
            
        except Exception:
            return False

    def get_buffer_data(self) -> AudioSampleData | None:
        """Get current buffer data.
        
        Returns:
            Current buffer contents
        """
        try:
            if not self._buffer:
                return None

            if len(self._buffer) == 1:
                return self._buffer[0]

            # Concatenate samples from all chunks (assumes same rate/channels)
            first = self._buffer[0]
            concatenated_samples: list[float] = []
            for chunk in self._buffer:
                concatenated_samples.extend(chunk.samples)

            return AudioSampleData(
                samples=tuple(concatenated_samples),
                sample_rate=first.sample_rate,
                channels=first.channels,
                data_type=first.data_type,
                timestamp=first.timestamp,
                duration=None,
                metadata={},
            )
            
        except Exception:
            return None

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

    def is_buffer_full(self) -> bool:
        """Check if the buffer is at capacity."""
        return len(self._buffer) >= self._max_size
