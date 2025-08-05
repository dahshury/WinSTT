"""Pause recording use case.

This module contains the use case for pausing audio recording.
"""

import time
from dataclasses import dataclass

from ....domain.audio.entities import AudioRecorder
from ....domain.audio.value_objects import RecordingState
from ....domain.common.abstractions import UseCase
from ....domain.common.result import Result


@dataclass
class PauseRecordingRequest:
    """Request for pausing audio recording."""

    save_partial_data: bool = True
    notify_user: bool = True


@dataclass
class PauseRecordingResponse:
    """Response for pausing audio recording."""

    success: bool
    recording_id: str | None = None
    pause_time: float | None = None
    duration_before_pause: float | None = None
    partial_data_saved: bool = False
    error_message: str | None = None


class PauseRecordingUseCase(UseCase[PauseRecordingRequest, PauseRecordingResponse]):
    """Use case for pausing audio recording.
    
    This use case handles the pausing of active audio recording,
    preserving the current state and optionally saving partial data.
    """

    def __init__(
        self,
        audio_recorder: AudioRecorder,
        notification_service=None,
        error_callback_service=None,
    ):
        """Initialize the pause recording use case.
        
        Args:
            audio_recorder: The audio recorder entity
            notification_service: Optional service for user notifications
            error_callback_service: Optional service for error notifications
        """
        self._audio_recorder = audio_recorder
        self._notification_service = notification_service
        self._error_callback_service = error_callback_service

    def execute(self, request: PauseRecordingRequest,
    ) -> Result[PauseRecordingResponse]:
        """Execute the pause recording use case.
        
        Args:
            request: The pause recording request
            
        Returns:
            Result containing the pause recording response
        """
        try:
            # Validate current state
            current_state = self._audio_recorder.get_state()

            if current_state != RecordingState.RECORDING:
                error_msg = f"Cannot pause recording. Current state: {current_state.value}"
                return Result.failure(
                    PauseRecordingResponse(
                        success=False,
                        error_message=error_msg,
                    )
                    error_msg,
                )

            # Get recording info before pausing
            recording_id = self._audio_recorder.get_recording_id()
            start_time = self._audio_recorder.get_start_time()
            pause_time = time.time()

            # Calculate duration before pause
            duration_before_pause = None
            if start_time:
                duration_before_pause = pause_time - start_time

            # Save partial data if requested
            partial_data_saved = False
            if request.save_partial_data:
                try:
                    save_result = self._audio_recorder.save_partial_recording()
                    partial_data_saved = save_result.is_success(,
    )

                    if not partial_data_saved and self._error_callback_service:
                        self._error_callback_service.notify_warning(
                            f"Failed to save partial recording data: {save_result.error}",
                        )

                except Exception as e:
                    if self._error_callback_service:
                        self._error_callback_service.notify_warning(
                            f"Error saving partial recording data: {e!s}",
                        )

            # Pause the recording
            pause_result = self._audio_recorder.pause_recording()

            if pause_result.is_failure():
                if self._error_callback_service:
                    self._error_callback_service.notify_error(
                        f"Failed to pause recording: {pause_result.error}",
                    )

                return Result.failure(
                    PauseRecordingResponse(
                        success=False,
                        recording_id=recording_id,
                        error_message=pause_result.error,
                    )
                    pause_result.error,
                )

            # Notify user if requested
            if request.notify_user and self._notification_service:
                try:
                    self._notification_service.notify_recording_paused(
                        recording_id=recording_id,
                        duration=duration_before_pause,
                    )
                except Exception as e:
                    # Notification failure shouldn't fail the pause operation
                    if self._error_callback_service:
                        self._error_callback_service.notify_warning(
                            f"Failed to send pause notification: {e!s}",
                        )

            return Result.success(
                PauseRecordingResponse(
                    success=True,
                    recording_id=recording_id,
                    pause_time=pause_time,
                    duration_before_pause=duration_before_pause,
                    partial_data_saved=partial_data_saved,
                ),
            )

        except Exception as e:
            # Handle unexpected errors
            error_msg = f"Unexpected error pausing recording: {e!s}"
            if self._error_callback_service:
                self._error_callback_service.notify_error(
                    "Error pausing recording. Check logs for details.",
                )

            return Result.failure(
                PauseRecordingResponse(
                    success=False,
                    error_message=error_msg,
                )
                error_msg,
            )