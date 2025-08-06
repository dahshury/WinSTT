"""Audio recorder entities."""

from dataclasses import dataclass, field
from enum import Enum

from src_refactored.domain.audio.entities.audio_configuration import AudioRecorderConfiguration
from src_refactored.domain.audio.value_objects.audio_data import AudioData
from src_refactored.domain.common.entity import Entity
from src_refactored.domain.common.result import Result


class RecordingState(Enum):
    """Recording state enumeration."""
    IDLE = "idle"
    RECORDING = "recording"
    PAUSED = "paused"
    STOPPED = "stopped"


@dataclass
class AudioRecorder(Entity):
    """
    Audio recorder entity for managing recording operations.
    
    This entity encapsulates the recording logic and state management
    for audio recording operations.
    """
    
    recording_id: str = field(default="")
    state: RecordingState = RecordingState.IDLE
    configuration: AudioRecorderConfiguration | None = None
    minimum_duration: float = 0.5
    start_time: float = 0.0
    
    def __post_init__(self):
        super().__post_init__()
        if not self.recording_id:
            import uuid
            object.__setattr__(self, "recording_id", str(uuid.uuid4()))
    
    def get_state(self) -> RecordingState:
        """Get the current recording state."""
        return self.state
    
    def get_recording_id(self) -> str:
        """Get the current recording ID."""
        return self.recording_id
    
    def configure(self, configuration: AudioRecorderConfiguration) -> Result[None]:
        """Configure the audio recorder with the given configuration."""
        try:
            self.configuration = configuration
            self.update_timestamp()
            return Result.success(None)
        except Exception as e:
            return Result.failure(str(e))
    
    def start_recording(self) -> Result[None]:
        """Start audio recording."""
        try:
            import time
            self.state = RecordingState.RECORDING
            self.start_time = time.time()
            self.update_timestamp()
            return Result.success(None)
        except Exception as e:
            return Result.failure(str(e))
    
    def stop_recording(self) -> Result[None]:
        """Stop audio recording."""
        try:
            self.state = RecordingState.IDLE
            self.update_timestamp()
            return Result.success(None)
        except Exception as e:
            return Result.failure(str(e))
    
    def pause_recording(self) -> Result[None]:
        """Pause audio recording."""
        try:
            self.state = RecordingState.PAUSED
            self.update_timestamp()
            return Result.success(None)
        except Exception as e:
            return Result.failure(str(e))
    
    def resume_recording(self) -> Result[None]:
        """Resume audio recording."""
        try:
            self.state = RecordingState.RECORDING
            self.update_timestamp()
            return Result.success(None)
        except Exception as e:
            return Result.failure(str(e))
    
    def set_minimum_duration(self, duration: float) -> None:
        """Set the minimum recording duration."""
        self.minimum_duration = duration
    
    def get_recording_duration(self) -> float:
        """Get the current recording duration."""
        if self.state != RecordingState.RECORDING:
            return 0.0
        
        import time
        return time.time() - self.start_time
    
    def get_start_time(self) -> float:
        """Get the recording start time."""
        return self.start_time
    
    def get_minimum_duration(self) -> float:
        """Get the minimum recording duration."""
        return self.minimum_duration
    
    def get_configuration(self) -> AudioRecorderConfiguration | None:
        """Get the current configuration."""
        return self.configuration
    
    def was_recording_successful(self) -> bool:
        """Check if the recording was successful."""
        return self.state == RecordingState.IDLE and self.get_recording_duration() >= self.minimum_duration
    
    def get_audio_data(self) -> Result[AudioData]:
        """Get the recorded audio data."""
        # This is a placeholder - in a real implementation, this would return actual audio data
        # For now, return a failure since creating proper AudioData requires complex setup
        return Result.failure("Audio data not available in placeholder implementation")
    
    def get_pause_time(self) -> float:
        """Get the pause time."""
        # This is a placeholder - in a real implementation, this would track pause time
        return 0.0
    
    def get_total_pause_duration(self) -> float:
        """Get the total pause duration."""
        # This is a placeholder - in a real implementation, this would track total pause time
        return 0.0
    
    def validate_recording_continuity(self) -> Result[bool]:
        """Validate recording continuity."""
        # This is a placeholder - in a real implementation, this would validate continuity
        return Result.success(True) 