"""Recording State Value Object

Represents the current state of audio recording.
Business domain concept for audio recording status.
"""

from enum import Enum


class RecordingState(Enum):
    """Current state of audio recording."""
    IDLE = "idle"
    INITIALIZING = "initializing"
    READY = "ready"
    RECORDING = "recording"
    PAUSED = "paused"
    STOPPING = "stopping"
    STOPPED = "stopped"
    SAVING = "saving"
    ERROR = "error"
    COMPLETED = "completed"

    @property
    def is_active(self) -> bool:
        """Check if recording is actively capturing audio."""
        return self == RecordingState.RECORDING

    @property
    def is_inactive(self) -> bool:
        """Check if recording is not capturing audio."""
        return self in [
            RecordingState.IDLE,
            RecordingState.STOPPED,
            RecordingState.COMPLETED,
            RecordingState.ERROR,
        ]

    @property
    def is_paused(self) -> bool:
        """Check if recording is paused."""
        return self == RecordingState.PAUSED

    @property
    def can_start(self) -> bool:
        """Check if recording can be started."""
        return self in [RecordingState.READY, RecordingState.STOPPED]

    @property
    def can_pause(self) -> bool:
        """Check if recording can be paused."""
        return self == RecordingState.RECORDING

    @property
    def can_resume(self) -> bool:
        """Check if recording can be resumed."""
        return self == RecordingState.PAUSED

    @property
    def can_stop(self) -> bool:
        """Check if recording can be stopped."""
        return self in [RecordingState.RECORDING, RecordingState.PAUSED]

    @property
    def is_transitional(self) -> bool:
        """Check if this is a transitional state."""
        return self in [
            RecordingState.INITIALIZING,
            RecordingState.STOPPING,
            RecordingState.SAVING,
        ]

    @property
    def requires_intervention(self) -> bool:
        """Check if this state requires user or system intervention."""
        return self == RecordingState.ERROR

    @property
    def has_data(self) -> bool:
        """Check if this state indicates recorded data exists."""
        return self in [
            RecordingState.PAUSED,
            RecordingState.STOPPED,
            RecordingState.SAVING,
            RecordingState.COMPLETED,
        ]


class RecordingMode(Enum):
    """Recording operation modes."""
    CONTINUOUS = "continuous"      # Record continuously
    VOICE_ACTIVATED = "voice_activated"  # Start/stop based on voice detection
    MANUAL = "manual"              # Manual start/stop control
    SCHEDULED = "scheduled"        # Time-based recording
    TRIGGERED = "triggered"        # Event-triggered recording

    @property
    def is_automatic(self) -> bool:
        """Check if mode operates automatically."""
        return self in [RecordingMode.VOICE_ACTIVATED, RecordingMode.SCHEDULED, RecordingMode.TRIGGERED]

    @property
    def requires_trigger(self) -> bool:
        """Check if mode requires external trigger."""
        return self in [RecordingMode.VOICE_ACTIVATED, RecordingMode.TRIGGERED]


class RecordingQuality(Enum):
    """Quality levels for audio recording."""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    LOSSLESS = "lossless"
    CUSTOM = "custom"

    @property
    def is_compressed(self) -> bool:
        """Check if this quality uses compression."""
        return self in [RecordingQuality.LOW, RecordingQuality.MEDIUM, RecordingQuality.HIGH]

    @property
    def is_lossless(self) -> bool:
        """Check if this quality is lossless."""
        return self == RecordingQuality.LOSSLESS

    @property
    def sample_rate(self) -> int:
        """Get the recommended sample rate for this quality."""
        quality_map = {
            RecordingQuality.LOW: 16000,
            RecordingQuality.MEDIUM: 22050,
            RecordingQuality.HIGH: 44100,
            RecordingQuality.LOSSLESS: 48000,
            RecordingQuality.CUSTOM: 44100,  # Default for custom
        }
        return quality_map.get(self, 44100)

    @property
    def bit_depth(self) -> int:
        """Get the recommended bit depth for this quality."""
        quality_map = {
            RecordingQuality.LOW: 16,
            RecordingQuality.MEDIUM: 16,
            RecordingQuality.HIGH: 24,
            RecordingQuality.LOSSLESS: 24,
            RecordingQuality.CUSTOM: 16,  # Default for custom
        }
        return quality_map.get(self, 16)