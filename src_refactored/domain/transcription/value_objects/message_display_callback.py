"""Message Display Callback Protocol.

Defines the interface for message display callbacks.
Extracted from infrastructure/transcription/onnx_transcription_service.py
"""

from typing import Protocol


class MessageDisplayCallback(Protocol):
    """Protocol for message display callback functions.
    
    Defines the interface for displaying messages with progress and error information.
    """

    def __call__(self, message: str, details: str | None, progress: int,
                 is_error: bool, auto_close: bool,
    ) -> None:
        """Display message with progress.
        
        Args:
            message: Main message to display
            details: Optional additional details
            progress: Progress percentage (0-100)
            is_error: Whether this is an error message
            auto_close: Whether to auto-close the message
        """
        ...