"""Audio Domain Module"""

# Export entities
from .entities import AudioDevice, AudioSession, DeviceCapabilities, DeviceType, SessionState

# Export value objects
from .value_objects import (
    AudioBuffer,
    # Configuration
    AudioConfiguration,
    # Data and buffers
    AudioData,
    AudioDataInfo,
    # Core audio concepts
    AudioFormat,
    AudioPlaybackServiceRequest,
    AudioQuality,
    AudioRecordingServiceRequest,
    AudioServiceRequest,
    AudioStreamServiceRequest,
    # Audio tracks and metadata
    AudioTrack,
    BufferOperationResult,
    DeviceListResult,
    DeviceTestRequest,
    DeviceTestResult,
    Duration,
    OperationResult,
    PlaybackConfiguration,
    PlaybackMetrics,
    PlaybackMode,
    PlaybackOperation,
    PlaybackResult,
    PlaybackState,
    PlaybackStatus,
    RecordingConfiguration,
    RecordingData,
    RecordingMetadata,
    RecordingMetrics,
    RecordingMode,
    RecordingOperation,
    RecordingResult,
    # Operations and states
    RecordingState,
    RecordingStatus,
    # Service requests and results
    RequestType,
    SampleRate,
    ServiceOperationResult,
    # Status and metrics
    ServiceStatus,
    StreamConfiguration,
    StreamMetrics,
    StreamOperationResult,
    StreamStartResult,
    StreamState,
    # Validation
    ValidationCategory,
    ValidationIssue,
    ValidationResult,
    ValidationRule,
    ValidationSeverity,
)

__all__ = [
    "AudioBuffer",
    # Configuration
    "AudioConfiguration",
    # Data and buffers
    "AudioData",
    "AudioDataInfo",
    "AudioDevice",
    # Core audio concepts
    "AudioFormat",
    "AudioPlaybackServiceRequest",
    "AudioQuality",
    "AudioRecordingServiceRequest",
    "AudioServiceRequest",
    # Entities
    "AudioSession",
    "AudioStreamServiceRequest",
    # Audio tracks and metadata
    "AudioTrack",
    "BufferOperationResult",
    "DeviceCapabilities",
    "DeviceListResult",
    "DeviceTestRequest",
    "DeviceTestResult",
    "DeviceType",
    "Duration",
    "OperationResult",
    "PlaybackConfiguration",
    "PlaybackMetrics",
    "PlaybackMode",
    "PlaybackOperation",
    "PlaybackResult",
    "PlaybackState",
    "PlaybackStatus",
    "RecordingConfiguration",
    "RecordingData",
    "RecordingMetadata",
    "RecordingMetrics",
    "RecordingMode",
    "RecordingOperation",
    "RecordingResult",
    # Operations and states
    "RecordingState",
    "RecordingStatus",
    # Service requests and results
    "RequestType",
    "SampleRate",
    "ServiceOperationResult",
    # Status and metrics
    "ServiceStatus",
    "SessionState",
    "StreamConfiguration",
    "StreamMetrics",
    "StreamOperationResult",
    "StreamStartResult",
    "StreamState",
    # Validation
    "ValidationCategory",
    "ValidationIssue",
    "ValidationResult",
    "ValidationRule",
    "ValidationSeverity",
]