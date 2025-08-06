"""Resume recording use case.

This module contains the use case for resuming paused audio recording.
"""

import time
from dataclasses import dataclass

from src_refactored.domain.audio.entities import AudioRecorder
from src_refactored.domain.audio.value_objects import RecordingState
from src_refactored.domain.common.abstractions import UseCase


@dataclass
class ResumeRecordingRequest:
    """Request for resuming audio recording."""

    play_resume_sound: bool = False
    notify_user: bool = True
    validate_continuity: bool = True


@dataclass
class ResumeRecordingResponse:
    """Response for resuming audio recording."""

    success: bool
    recording_id: str | None = None
    resume_time: float | None = None
    total_pause_duration: float | None = None
    continuity_validated: bool = False
    error_message: str | None = None


class ResumeRecordingUseCase(UseCase[ResumeRecordingRequest, ResumeRecordingResponse]):
    """Use case for resuming paused audio recording.
    
    This use case handles the resumption of paused audio recording,
    ensuring continuity and proper state management.
    """

    def __init__(
        self,
        audio_recorder: AudioRecorder,
        sound_player_service=None,
        notification_service=None,
        error_callback_service=None,
    ):
        """Initialize the resume recording use case.
        
        Args:
            audio_recorder: The audio recorder entity
            sound_player_service: Optional service for playing resume sounds
            notification_service: Optional service for user notifications
            error_callback_service: Optional service for error notifications
        """
        self._audio_recorder = audio_recorder
        self._sound_player_service = sound_player_service
        self._notification_service = notification_service
        self._error_callback_service = error_callback_service

    def execute(self, request: ResumeRecordingRequest,
    ) -> ResumeRecordingResponse:
        """Execute the resume recording use case.
        
        Args:
            request: The resume recording request
            
        Returns:
            ResumeRecordingResponse containing the result
        """
        try:
            # Validate current state
            current_state = self._audio_recorder.get_state()

            if current_state != RecordingState.PAUSED:
                error_msg = f"Cannot resume recording. Current state: {current_state.value}"
                return ResumeRecordingResponse(
                    success=False,
                    error_message=error_msg,
                )

            # Get recording info before resuming
            recording_id = self._audio_recorder.get_recording_id()
            pause_time = self._audio_recorder.get_pause_time()
            resume_time = time.time()

            # Calculate total pause duration
            total_pause_duration = None
            if pause_time:
                current_pause_duration = resume_time - pause_time
                previous_pause_duration = self._audio_recorder.get_total_pause_duration()
                total_pause_duration = previous_pause_duration + current_pause_duration

            # Validate recording continuity if requested
            continuity_validated = False
            if request.validate_continuity:
                try:
                    validation_result = self._audio_recorder.validate_recording_continuity()
                    continuity_validated = validation_result.is_success()

                    if not continuity_validated:
                        if self._error_callback_service:
                            self._error_callback_service.notify_warning(
                                f"Recording continuity validation failed: {validation_result.error}",
                            )

                        # Continue with resume despite validation failure
                        # as this might be a non-critical issue

                except Exception as e:
                    if self._error_callback_service:
                        self._error_callback_service.notify_warning(
                            f"Error validating recording continuity: {e!s}",
                        )

            # Resume the recording
            resume_result = self._audio_recorder.resume_recording()

            if resume_result.is_failure():
                if self._error_callback_service:
                    self._error_callback_service.notify_error(
                        f"Failed to resume recording: {resume_result.error}",
                    )

                return ResumeRecordingResponse(
                    success=False,
                    recording_id=recording_id,
                    error_message=resume_result.error,
                )

            # Play resume sound if requested and service available
            if request.play_resume_sound and self._sound_player_service:
                try:
                    self._sound_player_service.play_resume_sound()
                except Exception as e:
                    # Sound playback failure shouldn't stop recording
                    if self._error_callback_service:
                        self._error_callback_service.notify_warning(
                            f"Failed to play resume sound: {e!s}",
                        )

            # Notify user if requested
            if request.notify_user and self._notification_service:
                try:
                    self._notification_service.notify_recording_resumed(
                        recording_id=recording_id,
                        total_pause_duration=total_pause_duration,
                    )
                except Exception as e:
                    # Notification failure shouldn't fail the resume operation
                    if self._error_callback_service:
                        self._error_callback_service.notify_warning(
                            f"Failed to send resume notification: {e!s}",
                        )

            return ResumeRecordingResponse(
                success=True,
                recording_id=recording_id,
                resume_time=resume_time,
                total_pause_duration=total_pause_duration,
                continuity_validated=continuity_validated,
            )

        except Exception as e:
            # Handle unexpected errors
            error_msg = f"Unexpected error resuming recording: {e!s}"
            if self._error_callback_service:
                self._error_callback_service.notify_error(
                    "Error resuming recording. Check logs for details.",
                )

            return ResumeRecordingResponse(
                success=False,
                error_message=error_msg,
            )