"""Transcription Result Value Object.

This module contains the TranscriptionResult value object for
representing transcription results and their metadata.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from src_refactored.domain.common import ValueObject


@dataclass(frozen=True)
class TranscriptionResult(ValueObject):
    """Value object representing a transcription result."""
    
    transcription_id: str
    text: str
    language: str | None
    confidence: float
    processing_time: float
    state: str  # Will be TranscriptionState enum
    created_at: datetime
    completed_at: datetime | None = None
    error_message: str | None = None
    segments: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    
    def __post_init__(self):
        """Validate the transcription result."""
        if not self.transcription_id:
            msg = "Transcription ID is required"
            raise ValueError(msg)
        
        if self.confidence < 0.0 or self.confidence > 1.0:
            msg = "Confidence must be between 0.0 and 1.0"
            raise ValueError(msg)
        
        if self.processing_time < 0.0:
            msg = "Processing time must be non-negative"
            raise ValueError(msg)
        
        if self.completed_at and self.completed_at < self.created_at:
            msg = "Completion time cannot be before creation time"
            raise ValueError(msg)
