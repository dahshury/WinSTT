"""PyAudio Service (aggregator).

This file re-exports the recorder, protocols, types, and core service to
preserve existing imports while providing a modular structure that aligns with
the hexagonal architecture.
"""

from __future__ import annotations

import pyaudio  # Re-exported for downstream compatibility where referenced

from .pyaudio_core_service import PyAudioService
from .pyaudio_protocols import (
    AudioDataServiceProtocol,
    AudioValidationServiceProtocol,
    DeviceManagementServiceProtocol,
    LoggerServiceProtocol,
    ProgressTrackingServiceProtocol,
    StreamManagementServiceProtocol,
)
from .pyaudio_recorder import PyAudioRecorder
from .pyaudio_types import (
    AudioDeviceInfo,
    DeviceListResult,
    DeviceTestResult,
    PyAudioFormat,
    PyAudioServiceRequest,
    PyAudioServiceResponse,
    PyAudioServiceState,
    StreamOperationResult,
)

__all__ = [
    # External pyaudio symbol for compatibility
    "pyaudio",
    # Service
    "PyAudioService",
    # Recorder facade used by application listener
    "PyAudioRecorder",
    # Protocols
    "AudioDataServiceProtocol",
    "AudioValidationServiceProtocol",
    "DeviceManagementServiceProtocol",
    "StreamManagementServiceProtocol",
    "ProgressTrackingServiceProtocol",
    "LoggerServiceProtocol",
    # Types
    "AudioDeviceInfo",
    "DeviceListResult",
    "PyAudioServiceRequest",
    "PyAudioServiceResponse",
    "PyAudioServiceState",
    "PyAudioFormat",
    "StreamOperationResult",
    "DeviceTestResult",
]


