"""Conversion Operations Value Objects.

This module defines value objects for video conversion operations including
results, phases, audio formats, and conversion strategies.
"""

from enum import Enum


class ConversionResult(Enum):
    """Enumeration of conversion results."""
    SUCCESS = "success"
    FAILURE = "failure"
    CANCELLED = "cancelled"
    INVALID_INPUT = "invalid_input"
    UNSUPPORTED_FORMAT = "unsupported_format"
    INSUFFICIENT_SPACE = "insufficient_space"
    TIMEOUT = "timeout"


class ConversionPhase(Enum):
    """Enumeration of conversion phases."""
    INITIALIZING = "initializing"
    VALIDATING_INPUT = "validating_input"
    PREPARING_CONVERSION = "preparing_conversion"
    EXTRACTING_AUDIO = "extracting_audio"
    PROCESSING_AUDIO = "processing_audio"
    FINALIZING = "finalizing"
    COMPLETING = "completing"
    ERROR_HANDLING = "error_handling"


class AudioFormat(Enum):
    """Enumeration of audio formats."""
    WAV = "wav"
    MP3 = "mp3"
    FLAC = "flac"
    AAC = "aac"
    OGG = "ogg"


class ConversionStrategy(Enum):
    """Enumeration of conversion strategies."""
    FAST = "fast"
    BALANCED = "balanced"
    HIGH_QUALITY = "high_quality"
    CUSTOM = "custom"