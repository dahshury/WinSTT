"""Playback Mode Value Object

Represents different modes of audio playback.
Business domain concept for audio playback behavior.
"""

from enum import Enum


class PlaybackMode(Enum):
    """Different modes of audio playback."""
    NORMAL = "normal"
    REPEAT_ONE = "repeat_one"
    REPEAT_ALL = "repeat_all"
    SHUFFLE = "shuffle"
    QUEUE = "queue"
    STREAMING = "streaming"

    @property
    def is_repeating(self) -> bool:
        """Check if this mode involves repeating."""
        return self in [PlaybackMode.REPEAT_ONE, PlaybackMode.REPEAT_ALL]

    @property
    def is_sequential(self) -> bool:
        """Check if this mode plays tracks sequentially."""
        return self in [PlaybackMode.NORMAL, PlaybackMode.REPEAT_ALL, PlaybackMode.QUEUE]

    @property
    def is_randomized(self) -> bool:
        """Check if this mode randomizes playback order."""
        return self == PlaybackMode.SHUFFLE

    @property
    def supports_queue(self) -> bool:
        """Check if this mode supports queue operations."""
        return self in [PlaybackMode.QUEUE, PlaybackMode.SHUFFLE, PlaybackMode.REPEAT_ALL]

    @property
    def is_continuous(self) -> bool:
        """Check if this mode provides continuous playback."""
        return self in [PlaybackMode.REPEAT_ALL, PlaybackMode.SHUFFLE, PlaybackMode.STREAMING]


class VolumeMode(Enum):
    """Different modes of volume control."""
    MUTED = "muted"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    MAXIMUM = "maximum"
    CUSTOM = "custom"

    @property
    def is_audible(self) -> bool:
        """Check if audio is audible in this mode."""
        return self != VolumeMode.MUTED

    @property
    def is_preset(self) -> bool:
        """Check if this is a preset volume level."""
        return self != VolumeMode.CUSTOM

    @property
    def volume_percentage(self) -> float:
        """Get the approximate volume percentage for preset modes."""
        volume_map = {
            VolumeMode.MUTED: 0.0,
            VolumeMode.LOW: 0.25,
            VolumeMode.MEDIUM: 0.5,
            VolumeMode.HIGH: 0.75,
            VolumeMode.MAXIMUM: 1.0,
            VolumeMode.CUSTOM: 0.5,  # Default for custom
        }
        return volume_map.get(self, 0.5)