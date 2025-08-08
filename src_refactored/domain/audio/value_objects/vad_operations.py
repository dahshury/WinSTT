"""VAD (Voice Activity Detection) Value Objects.

This module defines value objects for voice activity detection
in the audio domain.
"""

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common.value_object import ValueObject


class VADResult(Enum):
    """Result status for VAD operations."""
    SUCCESS = "success"
    FAILED = "failed"
    MODEL_ERROR = "model_error"
    AUDIO_ERROR = "audio_error"
    THRESHOLD_ERROR = "threshold_error"
    TIMEOUT_ERROR = "timeout_error"


class VADOperation(Enum):
    """Types of VAD operations."""
    INITIALIZE = "initialize"
    DETECT_VOICE = "detect_voice"
    SET_THRESHOLD = "set_threshold"
    CALIBRATE = "calibrate"
    START_CONTINUOUS = "start_continuous"
    STOP_CONTINUOUS = "stop_continuous"
    CLEANUP = "cleanup"


class VADState(Enum):
    """VAD processing states."""
    INACTIVE = "inactive"
    ACTIVE = "active"
    CALIBRATING = "calibrating"
    CONTINUOUS = "continuous"
    ERROR = "error"


class VoiceActivity(Enum):
    """Voice activity detection results."""
    SPEECH = "speech"
    SILENCE = "silence"
    UNCERTAIN = "uncertain"


class VADModel(Enum):
    """Supported VAD models."""
    SILERO_V3 = "silero_v3"
    SILERO_V4 = "silero_v4"
    WEBRTC = "webrtc"
    CUSTOM = "custom"


@dataclass(frozen=True)
class VADConfiguration(ValueObject):
    """Configuration for Voice Activity Detection."""
    model: VADModel
    threshold: float
    sample_rate: int
    frame_size: int
    hop_size: int
    enable_smoothing: bool = True
    smoothing_window: int = 5
    min_speech_duration: float = 0.1
    min_silence_duration: float = 0.1

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            self.model,
            self.threshold,
            self.sample_rate,
            self.frame_size,
            self.hop_size,
            self.enable_smoothing,
            self.smoothing_window,
            self.min_speech_duration,
            self.min_silence_duration,
        )

    def __post_init__(self):
        if not 0.0 <= self.threshold <= 1.0:
            msg = "Threshold must be between 0.0 and 1.0"
            raise ValueError(msg)
        if self.min_speech_duration <= 0:
            msg = "Min speech duration must be positive"
            raise ValueError(msg)
        if self.min_silence_duration <= 0:
            msg = "Min silence duration must be positive"
            raise ValueError(msg)
        if self.sample_rate <= 0:
            msg = "Sample rate must be positive"
            raise ValueError(msg)
        if self.chunk_size <= 0:
            msg = "Chunk size must be positive"
            raise ValueError(msg)
        if self.frame_size <= 0:
            msg = "Frame size must be positive"
            raise ValueError(msg)
        if self.hop_size <= 0:
            msg = "Hop size must be positive"
            raise ValueError(msg)
        if not 0.0 <= self.overlap <= 1.0:
            msg = "Overlap must be between 0.0 and 1.0"
            raise ValueError(msg)
        if not 0.0 <= self.smoothing_factor <= 1.0:
            msg = "Smoothing factor must be between 0.0 and 1.0"
            raise ValueError(msg)


@dataclass(frozen=True)
class VADDetection(ValueObject):
    """Result of voice activity detection."""
    activity: VoiceActivity
    confidence: float
    timestamp: float
    duration: float
    chunk_id: int
    raw_score: float | None = None
    smoothed_score: float | None = None

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            self.activity,
            self.confidence,
            self.timestamp,
            self.duration,
            self.chunk_id,
            self.raw_score,
            self.smoothed_score,
        )

    def __post_init__(self):
        if not 0.0 <= self.confidence <= 1.0:
            msg = "Confidence must be between 0.0 and 1.0"
            raise ValueError(msg)
        if self.timestamp < 0:
            msg = "Timestamp must be non-negative"
            raise ValueError(msg)
        if self.duration <= 0:
            msg = "Duration must be positive"
            raise ValueError(msg)
        if self.chunk_id < 0:
            msg = "Chunk ID must be non-negative"
            raise ValueError(msg)
        if self.raw_score is not None and not 0.0 <= self.raw_score <= 1.0:
            msg = "Raw score must be between 0.0 and 1.0"
            raise ValueError(msg)
        if self.smoothed_score is not None and not 0.0 <= self.smoothed_score <= 1.0:
            msg = "Smoothed score must be between 0.0 and 1.0"
            raise ValueError(msg)