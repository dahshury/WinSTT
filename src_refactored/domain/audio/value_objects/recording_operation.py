"""Recording Operation Value Object

Represents the types of audio recording operations.
Business domain concept for audio recording actions.
"""

from enum import Enum


class RecordingOperation(Enum):
    """Types of recording operations."""
    INITIALIZE = "initialize"
    START_RECORDING = "start_recording"
    STOP_RECORDING = "stop_recording"
    PAUSE_RECORDING = "pause_recording"
    RESUME_RECORDING = "resume_recording"
    SAVE_RECORDING = "save_recording"
    DISCARD_RECORDING = "discard_recording"
    GET_RECORDING_DATA = "get_recording_data"
    GET_RECORDING_STATUS = "get_recording_status"
    SET_RECORDING_CONFIG = "set_recording_config"
    CLEANUP = "cleanup"

    @property
    def is_control_operation(self) -> bool:
        """Check if this is a recording control operation."""
        return self in [
            RecordingOperation.START_RECORDING,
            RecordingOperation.STOP_RECORDING,
            RecordingOperation.PAUSE_RECORDING,
            RecordingOperation.RESUME_RECORDING,
        ]

    @property
    def is_data_operation(self) -> bool:
        """Check if this is a data management operation."""
        return self in [
            RecordingOperation.SAVE_RECORDING,
            RecordingOperation.DISCARD_RECORDING,
            RecordingOperation.GET_RECORDING_DATA,
        ]

    @property
    def is_configuration_operation(self) -> bool:
        """Check if this is a configuration operation."""
        return self in [
            RecordingOperation.SET_RECORDING_CONFIG,
            RecordingOperation.GET_RECORDING_STATUS,
        ]

    @property
    def is_lifecycle_operation(self) -> bool:
        """Check if this is a lifecycle operation."""
        return self in [
            RecordingOperation.INITIALIZE,
            RecordingOperation.CLEANUP,
        ]

    @property
    def requires_active_recording(self) -> bool:
        """Check if this operation requires an active recording session."""
        return self in [
            RecordingOperation.STOP_RECORDING,
            RecordingOperation.PAUSE_RECORDING,
            RecordingOperation.GET_RECORDING_DATA,
            RecordingOperation.GET_RECORDING_STATUS,
        ]

    @property
    def modifies_recording_state(self) -> bool:
        """Check if this operation modifies the recording state."""
        return self in [
            RecordingOperation.START_RECORDING,
            RecordingOperation.STOP_RECORDING,
            RecordingOperation.PAUSE_RECORDING,
            RecordingOperation.RESUME_RECORDING,
            RecordingOperation.DISCARD_RECORDING,
        ]