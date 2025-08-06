"""Audio Buffer Service Protocol.

This module defines the protocol for audio buffer services.
"""

from typing import Protocol

import numpy as np


class AudioBufferServiceProtocol(Protocol):
    """Protocol for audio buffer service."""

    def add_to_buffer(self, data: np.ndarray) -> None:
        """Add audio data to buffer.
        
        Args:
            data: Audio data array to add
        """
        ...

    def get_buffer_data(self) -> np.ndarray:
        """Get current buffer data.
        
        Returns:
            Current buffer data
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

    def is_buffer_full(self) -> bool:
        """Check if buffer is full.
        
        Returns:
            True if buffer is full
        """
        ...