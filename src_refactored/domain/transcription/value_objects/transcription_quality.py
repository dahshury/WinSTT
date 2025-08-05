"""Transcription Quality Value Object.

Defines quality levels for transcription processing.
Extracted from infrastructure/transcription/onnx_transcription_service.py
"""

from enum import Enum


class TranscriptionQuality(Enum):
    """Transcription quality levels.
    
    Defines the quality/performance trade-off for transcription models.
    """
    QUANTIZED = "quantized"
    FULL = "full"

    def __str__(self) -> str:
        return self.value

    @property
    def is_high_quality(self) -> bool:
        """Check if this is a high quality setting."""
        return self == TranscriptionQuality.FULL

    @property
    def is_optimized(self) -> bool:
        """Check if this is an optimized/fast setting."""
        return self == TranscriptionQuality.QUANTIZED