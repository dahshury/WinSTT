"""Signal Emission Service Protocol.

This module defines the protocol for signal emission services.
"""

from typing import Any, Protocol

from src.domain.audio.value_objects.audio_samples import AudioSampleData


class SignalEmissionServiceProtocol(Protocol):
    """Protocol for signal emission service."""

    def emit_data_processed(self, data: AudioSampleData, metadata: dict[str, Any]) -> None:
        """Emit signal when data is processed.
        
        Args:
            data: Processed audio sample data
            metadata: Processing metadata
        """
        ...

    def emit_processing_started(self, data_size: int) -> None:
        """Emit signal when processing starts.
        
        Args:
            data_size: Size of data being processed
        """
        ...

    def emit_processing_completed(self, result: dict[str, Any]) -> None:
        """Emit signal when processing completes.
        
        Args:
            result: Processing result
        """
        ...

    def emit_processing_failed(self, error: str) -> None:
        """Emit signal when processing fails.
        
        Args:
            error: Error message
        """
        ...

    def emit_data_ready(self, data: AudioSampleData) -> None:
        """Emit signal when data is ready.
        
        Args:
            data: Ready audio sample data
        """
        ...

    def emit_buffer_updated(self, buffer_info: dict[str, Any]) -> None:
        """Emit signal when buffer is updated.
        
        Args:
            buffer_info: Buffer update information
        """
        ...

    def emit_progress_update(self, progress: float, message: str) -> None:
        """Emit progress update signal.
        
        Args:
            progress: Progress percentage (0.0 to 1.0)
            message: Progress message
        """
        ...