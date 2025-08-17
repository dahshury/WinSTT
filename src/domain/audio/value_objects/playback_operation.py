"""Playback Operation Value Object

Represents the types of audio playback operations.
Business domain concept for audio playback actions.
"""

from enum import Enum


class PlaybackOperation(Enum):
    """Types of playback operations."""
    INITIALIZE = "initialize"
    LOAD_AUDIO = "load_audio"
    START_PLAYBACK = "start_playback"
    STOP_PLAYBACK = "stop_playback"
    PAUSE_PLAYBACK = "pause_playback"
    RESUME_PLAYBACK = "resume_playback"
    SEEK_POSITION = "seek_position"
    SET_VOLUME = "set_volume"
    SET_SPEED = "set_speed"
    GET_PLAYBACK_STATUS = "get_playback_status"
    QUEUE_AUDIO = "queue_audio"
    CLEAR_QUEUE = "clear_queue"
    CLEANUP = "cleanup"

    @property
    def is_control_operation(self) -> bool:
        """Check if this is a playback control operation."""
        return self in [
            PlaybackOperation.START_PLAYBACK,
            PlaybackOperation.STOP_PLAYBACK,
            PlaybackOperation.PAUSE_PLAYBACK,
            PlaybackOperation.RESUME_PLAYBACK,
        ]

    @property
    def is_configuration_operation(self) -> bool:
        """Check if this is a configuration operation."""
        return self in [
            PlaybackOperation.SET_VOLUME,
            PlaybackOperation.SET_SPEED,
            PlaybackOperation.SEEK_POSITION,
        ]

    @property
    def is_lifecycle_operation(self) -> bool:
        """Check if this is a lifecycle operation."""
        return self in [
            PlaybackOperation.INITIALIZE,
            PlaybackOperation.CLEANUP,
        ]

    @property
    def is_queue_operation(self) -> bool:
        """Check if this is a queue management operation."""
        return self in [
            PlaybackOperation.QUEUE_AUDIO,
            PlaybackOperation.CLEAR_QUEUE,
        ]

    @property
    def requires_audio_loaded(self) -> bool:
        """Check if this operation requires audio to be loaded first."""
        return self in [
            PlaybackOperation.START_PLAYBACK,
            PlaybackOperation.PAUSE_PLAYBACK,
            PlaybackOperation.RESUME_PLAYBACK,
            PlaybackOperation.SEEK_POSITION,
            PlaybackOperation.GET_PLAYBACK_STATUS,
        ]