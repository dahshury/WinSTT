"""Signal Emission Service.

This module implements the SignalEmissionService for emitting
signals for audio data processing events.
"""

from collections.abc import Callable

import numpy as np

from src_refactored.domain.audio_visualization.protocols import (
    SignalEmissionServiceProtocol,
)


class SignalEmissionService(SignalEmissionServiceProtocol):
    """Service for emitting signals for audio data processing events."""

    def __init__(self):
        """Initialize the signal emission service."""
        self._data_ready_callbacks: list[Callable[[np.ndarray], None]] = []
        self._buffer_updated_callbacks: list[Callable[[np.ndarray], None]] = []

    def emit_data_ready(self, data: np.ndarray) -> None:
        """Emit data ready signal.
        
        Args:
            data: Processed audio data
            
        Returns:
            True if signal emitted successfully
        """
        try:
            if data is None or len(data) == 0:
                return None
                
            # Call all registered callbacks
            for callback in self._data_ready_callbacks:
                try:
                    callback(data)
                except Exception:
                    # Continue with other callbacks even if one fails
                    continue
                    
            return None
            
        except Exception:
            return None

    def emit_buffer_updated(self, buffer_data: np.ndarray) -> None:
        """Emit buffer updated signal.
        
        Args:
            buffer_data: Updated buffer data
            
        Returns:
            True if signal emitted successfully
        """
        try:
            if buffer_data is None:
                return None
                
            # Call all registered callbacks
            for callback in self._buffer_updated_callbacks:
                try:
                    callback(buffer_data)
                except Exception:
                    # Continue with other callbacks even if one fails
                    continue
                    
            return None
            
        except Exception:
            return None

    def register_data_ready_callback(self, callback: Callable[[np.ndarray], None]) -> None:
        """Register a callback for data ready events.
        
        Args:
            callback: Function to call when data is ready
        """
        if callback not in self._data_ready_callbacks:
            self._data_ready_callbacks.append(callback)

    def register_buffer_updated_callback(self, callback: Callable[[np.ndarray], None]) -> None:
        """Register a callback for buffer updated events.
        
        Args:
            callback: Function to call when buffer is updated
        """
        if callback not in self._buffer_updated_callbacks:
            self._buffer_updated_callbacks.append(callback)

    def unregister_data_ready_callback(self, callback: Callable[[np.ndarray], None]) -> None:
        """Unregister a callback for data ready events.
        
        Args:
            callback: Function to unregister
        """
        if callback in self._data_ready_callbacks:
            self._data_ready_callbacks.remove(callback)

    def unregister_buffer_updated_callback(self, callback: Callable[[np.ndarray], None]) -> None:
        """Unregister a callback for buffer updated events.
        
        Args:
            callback: Function to unregister
        """
        if callback in self._buffer_updated_callbacks:
            self._buffer_updated_callbacks.remove(callback)

    def clear_callbacks(self) -> None:
        """Clear all registered callbacks."""
        self._data_ready_callbacks.clear()
        self._buffer_updated_callbacks.clear()
