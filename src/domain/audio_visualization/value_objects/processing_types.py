"""Audio Processing Value Objects.

This module defines value objects for audio data processing operations,
including processing results, phases, and data types.
"""

from enum import Enum


class ProcessingResult(Enum):
    """Enumeration of processing results."""
    SUCCESS = "success"
    FAILURE = "failure"
    INVALID_DATA = "invalid_data"
    NORMALIZATION_FAILED = "normalization_failed"
    BUFFER_UPDATE_FAILED = "buffer_update_failed"
    SIGNAL_EMISSION_FAILED = "signal_emission_failed"
    CANCELLED = "cancelled"


class ProcessingPhase(Enum):
    """Enumeration of processing phases."""
    INITIALIZING = "initializing"
    VALIDATING_DATA = "validating_data"
    CONVERTING_DATA = "converting_data"
    NORMALIZING = "normalizing"
    UPDATING_BUFFER = "updating_buffer"
    EMITTING_SIGNAL = "emitting_signal"
    COMPLETING = "completing"
    ERROR_HANDLING = "error_handling"


class AudioDataType(Enum):
    """Enumeration of audio data types."""
    RAW_BYTES = "raw_bytes"
    NUMPY_ARRAY = "numpy_array"
    FLOAT_ARRAY = "float_array"
    INT16_ARRAY = "int16_array"
    INT32_ARRAY = "int32_array"