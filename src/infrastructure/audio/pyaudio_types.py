"""PyAudio Types.

Dataclasses and enums used by the PyAudio infrastructure services. Extracted
from the previous monolithic implementation for modularity.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from src.domain.audio.value_objects import (
        AudioConfiguration,
        AudioData,
        AudioOperation,
        AudioResult,
        DeviceType,
        StreamConfiguration,
    )


class PyAudioFormat(Enum):
    """PyAudio-specific format constants."""

    INT16 = "int16"
    INT24 = "int24"
    INT32 = "int32"
    FLOAT32 = "float32"


@dataclass
class AudioDeviceInfo:
    """Information about an audio device."""

    index: int
    name: str
    device_type: DeviceType
    max_input_channels: int
    max_output_channels: int
    default_sample_rate: float
    supported_sample_rates: list[float]
    is_default: bool = False
    host_api: str | None = None
    latency: float | None = None

    def __post_init__(self,
    ):
        if self.supported_sample_rates is None:
            self.supported_sample_rates = []


@dataclass
class PyAudioServiceRequest:
    """Request for PyAudio service operations."""

    operation: AudioOperation
    stream_config: StreamConfiguration | None = None
    device_filter: DeviceType | None = None
    test_duration: float = 1.0
    enable_logging: bool = True
    enable_progress_tracking: bool = True
    operation_timeout: float = 30.0


@dataclass
class DeviceListResult:
    """Result of device listing operation."""

    devices: list[AudioDeviceInfo]
    default_input_device: AudioDeviceInfo | None = None
    default_output_device: AudioDeviceInfo | None = None
    total_devices: int = 0
    available_devices: int = 0

    def __post_init__(self):
        self.total_devices = len(self.devices)
        self.available_devices = len(
            [d for d in self.devices if d.max_input_channels > 0 or d.max_output_channels > 0],
        )


@dataclass
class StreamOperationResult:
    """Result of stream operations."""

    stream_created: bool
    stream_started: bool
    stream_active: bool
    stream_object: Any | None = None
    stream_info: dict[str, Any] | None = None
    error_message: str | None = None


@dataclass
class DeviceTestResult:
    """Result of device testing."""

    device_working: bool
    input_test_passed: bool
    output_test_passed: bool
    latency_measured: float | None = None
    error_message: str | None = None
    test_duration: float = 0.0


@dataclass
class PyAudioServiceState:
    """Current state of PyAudio service."""

    initialized: bool = False
    active_streams: dict[str, Any] | None = None
    available_devices: DeviceListResult | None = None
    # Track the most recent configuration (recording stream or base audio)
    current_config: AudioConfiguration | StreamConfiguration | None = None
    error_message: str | None = None

    def __post_init__(self):
        if self.active_streams is None:
            self.active_streams = {}


@dataclass
class PyAudioServiceResponse:
    """Response from PyAudio service operations."""

    result: AudioResult
    state: PyAudioServiceState
    device_list: DeviceListResult | None = None
    stream_result: StreamOperationResult | None = None
    device_test: DeviceTestResult | None = None
    audio_data: list[AudioData] | None = None
    error_message: str | None = None
    warnings: list[str] | None = None
    execution_time: float = 0.0

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []
        if self.audio_data is None:
            self.audio_data = []


__all__ = [
    "PyAudioFormat",
    "AudioDeviceInfo",
    "PyAudioServiceRequest",
    "DeviceListResult",
    "StreamOperationResult",
    "DeviceTestResult",
    "PyAudioServiceState",
    "PyAudioServiceResponse",
]


