"""Progress Callback Protocol.

Defines the interface for progress reporting callbacks.
Extracted from infrastructure/transcription/onnx_transcription_service.py
"""

from typing import Protocol


class ProgressCallback(Protocol):
    """Protocol for progress callback functions.
    
    Defines the interface for reporting progress during operations.
    """

    def __call__(self, current: int, total: int, message: str,
    ) -> None:
        """Report progress.
        
        Args:
            current: Current progress value
            total: Total progress value
            message: Progress message
        """
        ...