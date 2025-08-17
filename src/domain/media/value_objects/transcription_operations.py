"""Transcription Operations Value Objects.

This module defines value objects for transcription operations including
results, phases, file types, and output formats.
"""

from enum import Enum


class TranscriptionResult(Enum):
    """Enumeration of transcription results."""
    SUCCESS = "success"
    PARTIAL_SUCCESS = "partial_success"
    FAILURE = "failure"
    CANCELLED = "cancelled"
    QUEUE_EMPTY = "queue_empty"
    IN_PROGRESS = "in_progress"


class TranscriptionPhase(Enum):
    """Enumeration of transcription phases."""
    INITIALIZING = "initializing"
    CHECKING_QUEUE = "checking_queue"
    PROCESSING_NEXT_FILE = "processing_next_file"
    CONVERTING_VIDEO = "converting_video"
    TRANSCRIBING_AUDIO = "transcribing_audio"
    TRANSCRIBING_FILE = "transcribing_file"
    SAVING_OUTPUT = "saving_output"
    UPDATING_PROGRESS = "updating_progress"
    COMPLETING = "completing"
    ERROR_HANDLING = "error_handling"


class FileType(Enum):
    """Enumeration of file types in queue."""
    AUDIO_FILE = "audio_file"
    VIDEO_FILE = "video_file"
    MEMORY_AUDIO = "memory_audio"
    UNKNOWN = "unknown"


class OutputFormat(Enum):
    """Enumeration of output formats."""
    TEXT = "text"
    JSON = "json"
    SRT = "srt"
    VTT = "vtt"
    CSV = "csv"
    XML = "xml"