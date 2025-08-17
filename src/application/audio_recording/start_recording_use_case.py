"""Start recording use case.

Keeps compatibility with existing application wiring.
"""

from dataclasses import dataclass

from src.domain.audio.entities import AudioRecorder
from src.domain.audio.value_objects import RecordingState
from src.domain.common.abstractions import UseCase


@dataclass
class StartRecordingRequest:
    """Request for starting audio recording."""

    play_start_sound: bool = True


@dataclass
class StartRecordingResponse:
    """Response for starting audio recording."""

    success: bool
    recording_id: str | None = None
    start_time: float | None = None
    error_message: str | None = None


class StartRecordingUseCase(UseCase[StartRecordingRequest, StartRecordingResponse]):
    """Use case for starting audio recording.

    Minimal domain-level start used as a fallback when bridge is unavailable.
    """

    def __init__(self, audio_recorder: AudioRecorder):
        self._audio_recorder = audio_recorder

    def execute(self, request: StartRecordingRequest,
    ) -> StartRecordingResponse:
        """Execute the start recording use case."""
        try:
            # Disallow starting if already recording
            if self._audio_recorder.get_state() == RecordingState.RECORDING:
                return StartRecordingResponse(
                    success=False,
                    error_message="Recording already in progress",
                )

            result = self._audio_recorder.start_recording()
            if result.is_failure():
                return StartRecordingResponse(
                    success=False,
                    error_message=result.error,
                )

            return StartRecordingResponse(
                success=True,
                recording_id=self._audio_recorder.get_recording_id(),
                start_time=self._audio_recorder.get_start_time(),
            )

        except Exception as e:
            return StartRecordingResponse(
                success=False,
                error_message=f"Unexpected error starting recording: {e!s}",
            )