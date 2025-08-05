"""Stream Operations Value Objects.

This module defines value objects for stream operations and results
in the audio domain.
"""

from enum import Enum


class StreamResult(Enum):
    """Result status for stream operations."""
    SUCCESS = "success"
    FAILED = "failed"
    DEVICE_ERROR = "device_error"
    FORMAT_ERROR = "format_error"
    BUFFER_ERROR = "buffer_error"
    TIMEOUT_ERROR = "timeout_error"
    PERMISSION_ERROR = "permission_error"


class StreamOperation(Enum):
    """Types of stream operations."""
    INITIALIZE = "initialize"
    START_INPUT = "start_input"
    START_OUTPUT = "start_output"
    STOP_INPUT = "stop_input"
    STOP_OUTPUT = "stop_output"
    PAUSE_INPUT = "pause_input"
    PAUSE_OUTPUT = "pause_output"
    RESUME_INPUT = "resume_input"
    RESUME_OUTPUT = "resume_output"
    GET_BUFFER = "get_buffer"
    PUT_BUFFER = "put_buffer"
    FLUSH_BUFFERS = "flush_buffers"
    CLEANUP = "cleanup"


class StreamDirection(Enum):
    """Stream direction types."""
    INPUT = "input"
    OUTPUT = "output"
    DUPLEX = "duplex"


class BufferMode(Enum):
    """Buffer management modes."""
    BLOCKING = "blocking"
    NON_BLOCKING = "non_blocking"
    CALLBACK = "callback"
    RING_BUFFER = "ring_buffer"