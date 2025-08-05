"""Start recording use case.

This module contains the use case for starting audio recording.
"""

import time
from dataclasses import dataclass

from ....domain.audio.entities import AudioConfiguration, AudioRecorder
from ....domain.audio.value_objects import RecordingState
from ....domain.common.abstractions import UseCase
from ....domain.common.result import Result


@dataclass
class StartRecordingRequest:
    """Request for starting audio recording."""

    configuration: AudioConfiguration | None = None
    play_start_sound: bool = True
    min_duration: float = 0.5


@dataclass
class StartRecordingResponse:
    """Response for starting audio recording."""

    success: bool
    recording_id: str | None = None
    start_time: float | None = None
    error_message: str | None = None


class StartRecordingUseCase(UseCase[StartRecordingRequest, StartRecordingResponse]):
    """Use case for starting audio recording.
    
    This use case handles the initialization and start of audio recording,
    including configuration validation, device setup, and error handling.
    """

    def __init__(
        self,
        audio_recorder: AudioRecorder,
        sound_player_service=None,
        error_callback_service=None,
    ):
        """Initialize the start recording use case.
        
        Args:
            audio_recorder: The audio recorder entity
            sound_player_service: Optional service for playing start sounds
            error_callback_service: Optional service for error notifications
        """
        self._audio_recorder = audio_recorder
        self._sound_player_service = sound_player_service
        self._error_callback_service = error_callback_service

    def execute(self, request: StartRecordingRequest,
    ) -> Result[StartRecordingResponse]:
        """Execute the start recording use case.
        
        Args:
            request: The start recording request
            
        Returns:
            Result containing the start recording response
        """
        try:
            # Validate current state
            if self._audio_recorder.get_state() == RecordingState.RECORDING:
                return Result.failure(
                    StartRecordingResponse(
                        success=False,
                        error_message="Recording is already in progress",
                    )
                    "Recording already in progress",
                )

            # Apply configuration if provided
            if request.configuration:
                config_result = self._audio_recorder.configure(request.configuration)
                if config_result.is_failure(,
    ):
                    return Result.failure(
                        StartRecordingResponse(
                            success=False,
                            error_message=f"Configuration failed: {config_result.error}",
                        )
                        config_result.error,
                    )

            # Start recording
            start_time = time.time()
            start_result = self._audio_recorder.start_recording()

            if start_result.is_failure():
                # Notify error callback if available
                if self._error_callback_service:
                    self._error_callback_service.notify_error(
                        f"Cannot start recording: {start_result.error}",
                    )

                return Result.failure(
                    StartRecordingResponse(
                        success=False,
                        error_message=start_result.error,
                    )
                    start_result.error,
                )

            # Play start sound if requested and service available
            if request.play_start_sound and self._sound_player_service:
                try:
                    self._sound_player_service.play_start_sound()
                except Exception as e:
                    # Sound playback failure shouldn't stop recording
                    if self._error_callback_service:
                        self._error_callback_service.notify_warning(
                            f"Failed to play start sound: {e!s}",
                        )

            # Set minimum duration
            self._audio_recorder.set_minimum_duration(request.min_duration)

            recording_id = self._audio_recorder.get_recording_id()

            return Result.success(
                StartRecordingResponse(
                    success=True,
                    recording_id=recording_id,
                    start_time=start_time,
                ),
            )

        except RuntimeError as e:
            # Handle specific runtime errors (device issues, etc.)
            error_msg = str(e)
            if self._error_callback_service:
                self._error_callback_service.notify_error(error_msg)

            return Result.failure(
                StartRecordingResponse(
                    success=False,
                    error_message=error_msg,
                )
                error_msg,
            )

        except Exception as e:
            # Handle unexpected errors
            error_msg = f"Unexpected error starting recording: {e!s}"
            if self._error_callback_service:
                self._error_callback_service.notify_error(
                    "Cannot start recording. Check logs for details.",
                )

            return Result.failure(
                StartRecordingResponse(
                    success=False,
                    error_message=error_msg,
                )
                error_msg,
            )