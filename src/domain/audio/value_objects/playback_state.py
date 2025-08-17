"""Playback State Value Object

Represents the current state of audio playback.
Business domain concept for audio playback status.
"""

from enum import Enum


class PlaybackState(Enum):
    """Current state of audio playback."""
    IDLE = "idle"
    LOADING = "loading"
    READY = "ready"
    PLAYING = "playing"
    PAUSED = "paused"
    STOPPED = "stopped"
    BUFFERING = "buffering"
    ERROR = "error"
    FINISHED = "finished"

    @property
    def is_active(self) -> bool:
        """Check if playback is actively running."""
        return self == PlaybackState.PLAYING

    @property
    def is_inactive(self) -> bool:
        """Check if playback is not running."""
        return self in [PlaybackState.IDLE, PlaybackState.STOPPED, PlaybackState.FINISHED]

    @property
    def is_paused(self) -> bool:
        """Check if playback is paused."""
        return self == PlaybackState.PAUSED

    @property
    def can_resume(self) -> bool:
        """Check if playback can be resumed."""
        return self == PlaybackState.PAUSED

    @property
    def can_pause(self) -> bool:
        """Check if playback can be paused."""
        return self == PlaybackState.PLAYING

    @property
    def can_start(self) -> bool:
        """Check if playback can be started."""
        return self in [PlaybackState.READY, PlaybackState.STOPPED, PlaybackState.FINISHED]

    @property
    def is_transitional(self) -> bool:
        """Check if this is a transitional state."""
        return self in [PlaybackState.LOADING, PlaybackState.BUFFERING]

    @property
    def requires_intervention(self) -> bool:
        """Check if this state requires user or system intervention."""
        return self == PlaybackState.ERROR