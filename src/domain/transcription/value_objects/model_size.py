"""Model Size Enum.

This module contains the ModelSize enum for representing
different sizes of transcription models.
"""

from enum import Enum


class ModelSize(Enum):
    """Enumeration of model sizes."""
    
    TINY = "tiny"
    BASE = "base"
    SMALL = "small"
    MEDIUM = "medium"
    LARGE = "large"
    LARGE_V2 = "large-v2"
    LARGE_V3 = "large-v3"
    
    def __str__(self) -> str:
        return self.value
    
    def __repr__(self) -> str:
        return f"ModelSize.{self.name}"
