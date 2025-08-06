"""Transcription Segment Value Object.

This module contains the TranscriptionSegment value object for representing
individual segments of a transcription result.
"""

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class TranscriptionSegment:
    """Transcription segment value object."""
    
    id: str
    start: float
    end: float
    text: str
    confidence: float | None = None
    language: str | None = None
    metadata: dict[str, Any] | None = None
    
    def __post_init__(self):
        """Validate transcription segment."""
        if self.start < 0:
            msg = "Start time must be non-negative"
            raise ValueError(msg)
        if self.end < self.start:
            msg = "End time must be >= start time"
            raise ValueError(msg)
        if not self.text.strip():
            msg = "Text cannot be empty"
            raise ValueError(msg)
        if self.confidence is not None and not 0.0 <= self.confidence <= 1.0:
            msg = "Confidence must be between 0.0 and 1.0"
            raise ValueError(msg)
    
    @property
    def duration(self) -> float:
        """Get segment duration."""
        return self.end - self.start
    
    def __str__(self) -> str:
        return f"Segment({self.start:.2f}-{self.end:.2f}s): {self.text}"
    
    def __repr__(self) -> str:
        return f"TranscriptionSegment(id='{self.id}', start={self.start}, end={self.end}, text='{self.text}')"
