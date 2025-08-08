"""Audio Buffer Service Protocol.

This module defines the protocol for audio buffer services.
"""

from typing import Protocol

from src_refactored.domain.audio.value_objects.audio_samples import AudioSampleData


class AudioBufferServiceProtocol(Protocol):
    """Protocol for audio buffer service."""

    def add_to_buffer(self, data: AudioSampleData) -> None:
        """Add audio data to buffer.
        
        Args:
            data: Audio sample data to add
        """
        ...

    def get_buffer_data(self) -> AudioSampleData | None:
        """Get current buffer data.
        
        Returns:
            Current buffer data or None if empty
        """
        ...

    def clear_buffer(self) -> None:
        """Clear the audio buffer."""
        ...

    def get_buffer_size(self) -> int:
        """Get current buffer size.
        
        Returns:
            Current buffer size
        """
        ...

    def update_buffer(self, data: AudioSampleData) -> bool:
        """Update buffer with new audio data.
        
        Args:
            data: Audio sample data to update buffer with
            
        Returns:
            True if buffer was updated successfully
        """
        ...

    def is_buffer_full(self) -> bool:
        """Check if buffer is full.
        
        Returns:
            True if buffer is full
        """
        ...