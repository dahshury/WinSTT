"""Transcription State Enum.

This module contains the TranscriptionState enum for representing
the various states of a transcription process.
"""

from enum import Enum


class TranscriptionState(Enum):
    """Enumeration of transcription states."""
    
    IDLE = "idle"
    INITIALIZING = "initializing"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    QUEUED = "queued"
