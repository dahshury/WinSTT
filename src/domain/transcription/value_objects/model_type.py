"""Model Type Enum.

This module contains the ModelType enum for representing
different types of transcription models.
"""

from enum import Enum


class ModelType(Enum):
    """Enumeration of model types."""
    
    WHISPER = "whisper"
    WHISPER_CPP = "whisper_cpp"
    FASTER_WHISPER = "faster_whisper"
    OPENAI_WHISPER = "openai_whisper"
    CUSTOM = "custom"
    
    def __str__(self) -> str:
        return self.value
    
    def __repr__(self) -> str:
        return f"ModelType.{self.name}"
