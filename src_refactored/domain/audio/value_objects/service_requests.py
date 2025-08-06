"""Audio Service Request Value Objects.

This module defines value objects for audio service requests
and responses in the domain.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

from src_refactored.domain.common.value_object import ValueObject

from .audio_configuration import (
    AudioConfiguration,
    PlaybackConfiguration,
    RecordingConfiguration,
    StreamConfiguration,
)
from .audio_data import AudioBuffer
from .audio_format import AudioFormat
from .audio_track import AudioTrack
from .playback_operation import PlaybackOperation
from .recording_operation import RecordingOperation
from .sample_rate import SampleRate
from .stream_operations import StreamOperation


class RequestType(Enum):
    """Audio service request types."""
    CONFIGURE = "configure"
    START = "start"
    STOP = "stop"
    PAUSE = "pause"
    RESUME = "resume"
    GET_STATUS = "get_status"
    GET_DEVICES = "get_devices"
    TEST_DEVICE = "test_device"
    VALIDATE = "validate"


class OperationResult(Enum):
    """Operation result types."""
    SUCCESS = "success"
    FAILURE = "failure"
    PARTIAL_SUCCESS = "partial_success"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"


@dataclass(frozen=True)
class AudioServiceRequest(ValueObject):
    """Base audio service request."""

    request_id: str
    request_type: RequestType
    timestamp: datetime = field(default_factory=datetime.now,
    )
    timeout_seconds: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def _get_equality_components(self) -> tuple:
        return (
            self.request_id,
            self.request_type,
            self.timestamp,
            self.timeout_seconds,
            tuple(sorted(self.metadata.items())),
        )

    def __invariants__(self) -> None:
        if not self.request_id or not self.request_id.strip():
            msg = "Request ID cannot be empty"
            raise ValueError(msg)
        if self.timeout_seconds is not None and self.timeout_seconds <= 0:
            msg = "Timeout must be positive"
            raise ValueError(msg)


@dataclass(frozen=True)
class AudioRecordingServiceRequest(AudioServiceRequest):
    """Audio recording service request."""

    operation: RecordingOperation | None = None
    configuration: RecordingConfiguration | None = None
    device_id: int | None = None
    recording_id: str | None = None
    file_path: Path | None = None
    enable_progress_tracking: bool = False
    enable_logging: bool = False
    enable_real_time_callback: bool = False
    config: RecordingConfiguration | None = None  # Alias for configuration

    def _get_equality_components(self) -> tuple:
        return (*super()._get_equality_components(), self.operation, self.configuration, self.device_id, self.recording_id, self.file_path, self.enable_progress_tracking, self.enable_logging, self.enable_real_time_callback, self.config)

    def __invariants__(self) -> None:
        super().__invariants__()
        if self.operation is None:
            msg = "Operation is required"
            raise ValueError(msg)


@dataclass(frozen=True)
class AudioPlaybackServiceRequest(AudioServiceRequest):
    """Audio playback service request."""

    operation: PlaybackOperation | None = None
    configuration: PlaybackConfiguration | None = None
    device_id: int | None = None
    audio_data: bytes | None = None
    track: AudioTrack | None = None
    file_path: Path | None = None
    position: float | None = None
    volume: float | None = None
    speed: float | None = None
    enable_progress_tracking: bool = False
    enable_logging: bool = False
    enable_real_time_callback: bool = False
    config: PlaybackConfiguration | None = None

    def _get_equality_components(self) -> tuple:
        return (*super()._get_equality_components(), self.operation, self.configuration, self.device_id, self.audio_data, self.track, self.file_path, self.position, self.volume, self.speed, self.enable_progress_tracking, self.enable_logging, self.enable_real_time_callback, self.config)

    def __invariants__(self) -> None:
        super().__invariants__()
        if self.operation is None:
            msg = "Operation is required"
            raise ValueError(msg)


@dataclass(frozen=True)
class AudioStreamServiceRequest(AudioServiceRequest):
    """Audio stream service request."""

    operation: StreamOperation | None = None
    configuration: AudioConfiguration | None = None
    device_id: int | None = None
    buffer_size: int | None = None
    enable_progress_tracking: bool = False
    enable_logging: bool = False
    enable_metrics: bool = False
    config: StreamConfiguration | None = None
    buffer_data: AudioBuffer | None = None
    timeout: float = 5.0

    def _get_equality_components(self) -> tuple:
        return (*super()._get_equality_components(), self.operation, self.configuration, self.device_id, self.buffer_size, self.enable_progress_tracking, self.enable_logging, self.enable_metrics, self.config, self.buffer_data, self.timeout)

    def __invariants__(self) -> None:
        super().__invariants__()
        if self.operation is None:
            msg = "Operation is required"
            raise ValueError(msg)


@dataclass(frozen=True)
class DeviceTestRequest(AudioServiceRequest):
    """Device test request."""

    device_id: int = 0
    test_duration_seconds: float = 1.0
    sample_rate: SampleRate | None = None
    audio_format: AudioFormat | None = None

    def _get_equality_components(self) -> tuple:
        return (*super()._get_equality_components(), self.device_id, self.test_duration_seconds, self.sample_rate, self.audio_format)

    def __invariants__(self) -> None:
        super().__invariants__()
        if self.device_id < 0:
            msg = "Device ID cannot be negative"
            raise ValueError(msg)
        if self.test_duration_seconds <= 0:
            msg = "Test duration must be positive"
            raise ValueError(msg)


@dataclass(frozen=True)
class ServiceOperationResult(ValueObject):
    """Base service operation result."""

    request_id: str
    result: OperationResult
    message: str
    timestamp: datetime = field(default_factory=datetime.now,
    )
    error_code: str | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def _get_equality_components(self) -> tuple:
        return (
            self.request_id,
            self.result,
            self.message,
            self.timestamp,
            self.error_code,
            tuple(sorted(self.details.items())),
        )

    def __invariants__(self) -> None:
        if not self.request_id or not self.request_id.strip():
            msg = "Request ID cannot be empty"
            raise ValueError(msg)
        if not self.message or not self.message.strip():
            msg = "Message cannot be empty"
            raise ValueError(msg)

    @property
    def is_success(self) -> bool:
        """Check if operation was successful."""
        return self.result == OperationResult.SUCCESS

    @property
    def is_failure(self) -> bool:
        """Check if operation failed."""
        return self.result == OperationResult.FAILURE

    @property
    def has_error(self) -> bool:
        """Check if operation has an error."""
        return self.error_code is not None


@dataclass(frozen=True)
class StreamOperationResult(ServiceOperationResult):
    """Stream operation result."""

    stream_id: str | None = None
    frames_processed: int = 0
    latency_ms: float | None = None

    def _get_equality_components(self) -> tuple:
        return (*super()._get_equality_components(), self.stream_id, self.frames_processed, self.latency_ms)


@dataclass(frozen=True)
class StreamStartResult(ServiceOperationResult):
    """Stream start operation result."""

    stream_id: str | None = None
    actual_sample_rate: SampleRate | None = None
    actual_buffer_size: int | None = None
    device_latency_ms: float | None = None

    def _get_equality_components(self) -> tuple:
        return (*super()._get_equality_components(),
        self.stream_id, self.actual_sample_rate, self.actual_buffer_size, self.device_latency_ms)


@dataclass(frozen=True)
class BufferOperationResult(ServiceOperationResult):
    """Buffer operation result."""

    buffer_id: str | None = None
    frames_written: int = 0
    frames_read: int = 0
    buffer_utilization: float = 0.0

    def _get_equality_components(self) -> tuple:
        return (*super()._get_equality_components(), self.buffer_id, self.frames_written, self.frames_read, self.buffer_utilization)

    def __invariants__(self) -> None:
        super().__invariants__()
        if self.frames_written < 0:
            msg = "Frames written cannot be negative"
            raise ValueError(msg)
        if self.frames_read < 0:
            msg = "Frames read cannot be negative"
            raise ValueError(msg)
        if self.buffer_utilization < 0 or self.buffer_utilization > 100:
            msg = "Buffer utilization must be between 0 and 100"
            raise ValueError(msg)


@dataclass(frozen=True)
class DeviceListResult(ServiceOperationResult):
    """Device list operation result."""

    device_count: int = 0
    default_input_device: int | None = None
    default_output_device: int | None = None

    def _get_equality_components(self) -> tuple:
        return (*super()._get_equality_components(), self.device_count, self.default_input_device, self.default_output_device)

    def __invariants__(self) -> None:
        super().__invariants__()
        if self.device_count < 0:
            msg = "Device count cannot be negative"
            raise ValueError(msg)


@dataclass(frozen=True)
class DeviceTestResult(ServiceOperationResult):
    """Device test operation result."""

    device_id: int = 0
    test_passed: bool = False
    latency_ms: float | None = None
    max_sample_rate: SampleRate | None = None
    supported_formats: list[AudioFormat] = field(default_factory=list)

    def _get_equality_components(self) -> tuple:
        return (*super()._get_equality_components(), self.device_id, self.test_passed, self.latency_ms, self.max_sample_rate, tuple(self.supported_formats))

    def __invariants__(self) -> None:
        super().__invariants__()
        if self.device_id < 0:
            msg = "Device ID cannot be negative"
            raise ValueError(msg)
        if self.latency_ms is not None and self.latency_ms < 0:
            msg = "Latency cannot be negative"
            raise ValueError(msg)
            raise ValueError(msg)
            raise ValueError(msg)