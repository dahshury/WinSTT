"""Processing Operations Value Objects.

This module defines value objects for media file processing operations including
results, phases, media types, and processing strategies.
"""

from enum import Enum


class ProcessingResult(Enum):
    """Enumeration of processing results."""
    SUCCESS = "success"
    PARTIAL_SUCCESS = "partial_success"
    FAILURE = "failure"
    CANCELLED = "cancelled"
    NO_FILES = "no_files"
    INVALID_INPUT = "invalid_input"


class ProcessingStatus(Enum):
    """Enumeration of processing status states."""
    IDLE = "idle"
    PROCESSING = "processing"
    PAUSED = "paused"
    COMPLETED = "completed"
    ERROR = "error"


class ProcessingPhase(Enum):
    """Enumeration of processing phases."""
    INITIALIZING = "initializing"
    VALIDATING_FILES = "validating_files"
    PREPARING_QUEUE = "preparing_queue"
    PROCESSING_FILES = "processing_files"
    CONVERTING_VIDEOS = "converting_videos"
    ADDING_TO_QUEUE = "adding_to_queue"
    UPDATING_PROGRESS = "updating_progress"
    COMPLETING = "completing"
    ERROR_HANDLING = "error_handling"


class MediaType(Enum):
    """Enumeration of media types."""
    AUDIO = "audio"
    VIDEO = "video"
    UNKNOWN = "unknown"


class ProcessingStrategy(Enum):
    """Enumeration of processing strategies."""
    SEQUENTIAL = "sequential"
    PARALLEL = "parallel"
    BATCH = "batch"
    PRIORITY_BASED = "priority_based"