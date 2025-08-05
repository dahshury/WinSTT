"""Stop recording use case.

This module contains the use case for stopping audio recording.
"""

import time
from dataclasses import dataclass

from ....domain.audio.entities import AudioRecorder
from ....domain.audio.value_objects import AudioData, RecordingState
from ....domain.common.abstractions import UseCase
from ....domain.common.result import Result


@dataclass
class StopRecordingRequest:
    """Request for stopping audio recording."""

    force_stop: bool = False
    save_recording: bool = True


@dataclass
class StopRecordingResponse:
    """Response for stopping audio recording."""

    success: bool
    recording_id: str | None = None
    duration: float | None = None
    audio_data: AudioData | None = None
    was_too_short: bool = False
    error_message: str | None = None


class StopRecordingUseCase(UseCase[StopRecordingRequest, StopRecordingResponse]):
    """Use case for stopping audio recording.
    
    This use case handles the termination of audio recording,
    duration validation, and audio data retrieval.
    """

    def __init__(
        self,
        audio_recorder: AudioRecorder,
        transcription_service=None,
        error_callback_service=None,
    ):
        """Initialize the stop recording use case.
        
        Args:
            audio_recorder: The audio recorder entity
            transcription_service: Optional service for transcription
            error_callback_service: Optional service for error notifications
        """
        self._audio_recorder = audio_recorder
        self._transcription_service = transcription_service
        self._error_callback_service = error_callback_service

    def execute(self, request: StopRecordingRequest,
    ) -> Result[StopRecordingResponse]:
        """Execute the stop recording use case.
        
        Args:
            request: The stop recording request
            
        Returns:
            Result containing the stop recording response
        """
        try:
            # Validate current state
            if self._audio_recorder.get_state() != RecordingState.RECORDING:
                return Result.failure(
                    StopRecordingResponse(
                        success=False,
                        error_message="No recording in progress",
                    )
                    "No recording in progress",
                )

            # Get recording info before stopping
            recording_id = self._audio_recorder.get_recording_id()
            start_time = self._audio_recorder.get_start_time()

            # Stop the recording
            stop_result = self._audio_recorder.stop_recording()

            if stop_result.is_failure():
                if self._error_callback_service:
                    self._error_callback_service.notify_error(
                        f"Failed to stop recording: {stop_result.error}",
                    )

                return Result.failure(
                    StopRecordingResponse(
                        success=False,
                        error_message=stop_result.error,
                    )
                    stop_result.error,
                )

            # Calculate duration
            duration = time.time() - start_time if start_time else 0
            min_duration = self._audio_recorder.get_minimum_duration()

            # Notify completion
            if self._error_callback_service:
                self._error_callback_service.notify_recording_complete()

            # Check if recording was successful and meets minimum duration
            if not self._audio_recorder.was_recording_successful():
                return Result.success(
                    StopRecordingResponse(
                        success=True,
                        recording_id=recording_id,
                        duration=duration,
                        error_message="Recording was not successful",
                    ),
                )

            # Check minimum duration unless force stop
            if not request.force_stop and duration < min_duration:
                error_msg
 = (
    f"Recording too short ({duration:.2f} seconds). Minimum duration is {min_duration} seconds.")

                if self._error_callback_service:
                    self._error_callback_service.notify_warning(error_msg,
    )

                return Result.success(
                    StopRecordingResponse(
                        success=True,
                        recording_id=recording_id,
                        duration=duration,
                        was_too_short=True,
                        error_message=error_msg,
                    )
                )

            # Get audio data if requested
            audio_data = None
            if request.save_recording:
                try:
                    audio_data_result = self._audio_recorder.get_audio_data()
                    if audio_data_result.is_success(,
    ):
                        audio_data = audio_data_result.value
                    else:
                        if self._error_callback_service:
                            self._error_callback_service.notify_error(
                                f"Failed to retrieve audio data: {audio_data_result.error}",
                            )

                        return Result.failure(
                            StopRecordingResponse(
                                success=False,
                                recording_id=recording_id,
                                duration=duration,
error_message = (
    f"Failed to retrieve audio data: {audio_data_result.error}",)
                            )
                            audio_data_result.error,
                        )

                except Exception as e:
                    error_msg = f"Error retrieving audio data: {e!s}"
                    if self._error_callback_service:
                        self._error_callback_service.notify_error(
                            "Error during audio processing. Check logs.",
                        )

                    return Result.failure(
                        StopRecordingResponse(
                            success=False,
                            recording_id=recording_id,
                            duration=duration,
                            error_message=error_msg,
                        )
                        error_msg,
                    )

            # Start transcription if service available and audio data exists
            if self._transcription_service and audio_data:
                try:
                    # Start transcription in background (non-blocking)
                    self._transcription_service.start_transcription_async(
                        audio_data, recording_id,
                    )
                except Exception:
                    # Transcription failure shouldn't fail the stop operation
                    if self._error_callback_service:
                        self._error_callback_service.notify_error(
                            "Transcription Error. Check logs.",
                        )

            return Result.success(
                StopRecordingResponse(
                    success=True,
                    recording_id=recording_id,
                    duration=duration,
                    audio_data=audio_data,
                )
            )

        except Exception as e:
            # Handle unexpected errors
            error_msg = f"Unexpected error stopping recording: {e!s}"
            if self._error_callback_service:
                self._error_callback_service.notify_error(
                    "Error stopping recording. Check logs for details.",
                )

            return Result.failure(
                StopRecordingResponse(
                    success=False,
                    error_message=error_msg,
                )
                error_msg,
            )