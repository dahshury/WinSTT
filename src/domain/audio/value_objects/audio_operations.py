"""Audio Operations Value Objects.

This module defines audio operation types and results
that are core domain concepts.
"""

from dataclasses import dataclass
from enum import Enum

from src.domain.common.value_object import ValueObject


class AudioResult(Enum):
    """Result status for audio operations."""
    SUCCESS = "success"
    FAILED = "failed"
    DEVICE_ERROR = "device_error"
    FORMAT_ERROR = "format_error"
    STREAM_ERROR = "stream_error"
    PERMISSION_ERROR = "permission_error"
    TIMEOUT_ERROR = "timeout_error"


class AudioOperation(Enum):
    """Types of audio operations."""
    INITIALIZE = "initialize"
    START_RECORDING = "start_recording"
    STOP_RECORDING = "stop_recording"
    START_PLAYBACK = "start_playback"
    STOP_PLAYBACK = "stop_playback"
    LIST_DEVICES = "list_devices"
    TEST_DEVICE = "test_device"
    CLEANUP = "cleanup"


class DeviceType(Enum):
    """Audio device types."""
    INPUT = "input"
    OUTPUT = "output"
    BOTH = "both"


@dataclass(frozen=True)
class AudioChunk(ValueObject):
    """Audio chunk for processing."""
    data: bytes
    timestamp: float
    sample_rate: int
    duration: float
    chunk_id: int

    def _get_equality_components(self) -> tuple[object, ...]:
        """Get components for equality comparison."""
        return (
            self.data,
            self.timestamp,
            self.sample_rate,
            self.duration,
            self.chunk_id,
        )

    def __post_init__(self) -> None:
        if not self.data:
            msg = "Audio chunk data cannot be empty"
            raise ValueError(msg)
        if self.sample_rate <= 0:
            msg = "Sample rate must be positive"
            raise ValueError(msg)
        if self.duration <= 0:
            msg = "Duration must be positive"
            raise ValueError(msg)
        if self.chunk_id < 0:
            msg = "Chunk ID must be non-negative"
            raise ValueError(msg)


@dataclass(frozen=True)
class CalibrationResult(ValueObject):
    """Result of audio calibration."""
    optimal_threshold: float
    noise_level: float
    speech_level: float
    calibration_duration: float
    confidence: float
    samples_processed: int
    calibration_method: str

    def _get_equality_components(self) -> tuple[object, ...]:
        """Get components for equality comparison."""
        return (
            self.optimal_threshold,
            self.noise_level,
            self.speech_level,
            self.calibration_duration,
            self.confidence,
            self.samples_processed,
            self.calibration_method,
        )

    def __post_init__(self) -> None:
        if self.optimal_threshold < 0 or self.optimal_threshold > 1:
            msg = "Optimal threshold must be between 0 and 1"
            raise ValueError(msg)
        if self.confidence < 0 or self.confidence > 1:
            msg = "Confidence must be between 0 and 1"
            raise ValueError(msg)
        if self.samples_processed <= 0:
            msg = "Samples processed must be positive"
            raise ValueError(msg)
        if self.calibration_duration <= 0:
            msg = "Calibration duration must be positive"
            raise ValueError(msg)