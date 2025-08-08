"""Audio Value Objects.

This module contains all audio-related value objects.
"""

from .audio_configuration import (
    AudioConfiguration,
    PlaybackConfiguration,
    RecordingConfiguration,
    StreamConfiguration,
)
from .audio_data import AudioBuffer, AudioData, StreamMetrics, StreamState
from .audio_format import AudioFormat, AudioFormatType, BitDepth
from .audio_operations import (
    AudioChunk,
    AudioOperation,
    AudioResult,
    CalibrationResult,
    DeviceType,
)
from .audio_quality import AudioQuality
from .audio_track import AudioTrack, RecordingData, RecordingMetadata
from .channel_count import ChannelCount
from .duration import Duration
from .playback_mode import PlaybackMode
from .playback_operation import PlaybackOperation
from .playback_result import PlaybackResult
from .playback_state import PlaybackState
from .recording_operation import RecordingOperation
from .recording_result import RecordingResult
from .recording_state import RecordingMode, RecordingState
from .sample_rate import SampleRate
from .service_requests import (
    AudioPlaybackServiceRequest,
    AudioRecordingServiceRequest,
    AudioServiceRequest,
    AudioStreamServiceRequest,
    BufferOperationResult,
    DeviceListResult,
    DeviceTestRequest,
    DeviceTestResult,
    OperationResult,
    RequestType,
    ServiceOperationResult,
    StreamOperationResult,
    StreamStartResult,
)
from .status_metrics import (
    PlaybackMetrics,
    PlaybackStatus,
    RecordingMetrics,
    RecordingStatus,
    ServiceStatus,
)
from .stream_operations import BufferMode, StreamDirection, StreamOperation, StreamResult
from .vad_operations import (
    VADConfiguration,
    VADDetection,
    VADModel,
    VADOperation,
    VADResult,
    VADState,
    VoiceActivity,
)
from .validation import (
    AudioDataInfo,
    ValidationCategory,
    ValidationIssue,
    ValidationResult,
    ValidationRule,
    ValidationSeverity,
)
from .validation_operations import (
    ValidationType,
)

__all__ = [
    "AudioBuffer",
    "AudioChunk",
    # Configuration value objects
    "AudioConfiguration",
    # Audio data and streaming
    "AudioData",
    "AudioDataInfo",
    # Basic audio properties
    "AudioFormat",
    "AudioOperation",
    "AudioPlaybackServiceRequest",
    "AudioQuality",
    "AudioRecordingServiceRequest",
    # Audio operations
    "AudioResult",
    "AudioServiceRequest",
    "AudioStreamServiceRequest",
    # Audio tracks and recordings
    "AudioTrack",
    "BufferMode",
    "BufferOperationResult",
    "CalibrationResult",
    "ChannelCount",
    "DeviceListResult",
    "DeviceTestRequest",
    "DeviceTestResult",
    "DeviceType",
    "Duration",
    "OperationResult",
    "PlaybackConfiguration",
    "PlaybackMetrics",
    # Playback domain concepts
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
    # Recording domain concepts
    "RecordingOperation",
    "RecordingResult",
    "RecordingState",
    "RecordingStatus",
    # Service requests and results
    "RequestType",
    "SampleRate",
    "ServiceOperationResult",
    # Status and metrics
    "ServiceStatus",
    "StreamConfiguration",
    "StreamDirection",
    "StreamMetrics",
    "StreamOperation",
    "StreamOperationResult",
    # Stream operations
    "StreamResult",
    "StreamStartResult",
    "StreamState",
    "VADConfiguration",
    "VADDetection",
    "VADModel",
    "VADOperation",
    # VAD operations
    "VADResult",
    "VADState",
    # Validation concepts
    "ValidationCategory",
    "ValidationIssue", 
    "ValidationResult",
    "ValidationRule",
    "ValidationSeverity",
    # Validation operations
    "ValidationType",
    "VoiceActivity",
]