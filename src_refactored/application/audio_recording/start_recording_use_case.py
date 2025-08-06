"""Start recording use case.

This module contains the use case for starting audio recording.
"""

import time
from dataclasses import dataclass

from src_refactored.domain.audio.entities import AudioRecorder, AudioRecorderConfiguration
from src_refactored.domain.audio.value_objects import RecordingState
from src_refactored.domain.common.abstractions import UseCase
from src_refactored.domain.common.domain_result import DomainResult
from src_refactored.domain.common.errors import (
    AudioDomainException,
    DomainError,
    ErrorCategory,
    ErrorSeverity,
)


@dataclass
class StartRecordingRequest:
    """Request for starting audio recording."""

    configuration: AudioRecorderConfiguration | None = None
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
        sound_player_service: SoundPlayerServiceProtocol | None = None,
        error_callback_service: ErrorCallbackServiceProtocol | None = None,
    ):
        """Initialize the start recording use case.
        
        Args:
            audio_recorder: The audio recorder entity
            sound_player_service: Optional service for playing start sounds
            error_callback_service: Optional service for error notifications
        """
        self._audio_recorder = audio_recorder
        self._sound_player_service = sound_player_service or self._get_default_sound_player()
        self._error_callback_service = error_callback_service or self._get_default_error_callback()

    def _get_default_sound_player(self) -> SoundPlayerServiceProtocol:
        """Get default sound player service."""
        return DefaultSoundPlayerService()

    def _get_default_error_callback(self) -> ErrorCallbackServiceProtocol:
        """Get default error callback service."""
        return DefaultErrorCallbackService()

    def execute(self, request: StartRecordingRequest,
    ) -> DomainResult[StartRecordingResponse]:
        """Execute the start recording use case.
        
        Args:
            request: The start recording request
            
        Returns:
            DomainResult containing StartRecordingResponse or domain error
        """
        try:
            # Validate current state
            if self._audio_recorder.get_state() == RecordingState.RECORDING:
                error = DomainError(
                    message="Recording is already in progress",
                    category=ErrorCategory.BUSINESS_RULE_VIOLATION,
                    severity=ErrorSeverity.WARNING,
                    context={"current_state": RecordingState.RECORDING.value},
                )
                return DomainResult.failure_from_error(error)

            # Apply configuration if provided
            if request.configuration:
                config_result = self._audio_recorder.configure(request.configuration)
                if config_result.is_failure():
                    error = DomainError(
                        message=f"Configuration failed: {config_result.error}",
                        category=ErrorCategory.VALIDATION_ERROR,
                        severity=ErrorSeverity.ERROR,
                        context={"configuration": str(request.configuration)},
                    )
                    return DomainResult.failure_from_error(error)

            # Start recording
            start_time = time.time()
            start_result = self._audio_recorder.start_recording()

            if start_result.is_failure():
                # Notify error callback if available
                if self._error_callback_service:
                    self._error_callback_service.notify_error(
                        f"Cannot start recording: {start_result.error}",
                    )

                error = DomainError(
                    message=f"Failed to start recording: {start_result.error}",
                    category=ErrorCategory.EXTERNAL_SERVICE_ERROR,
                    severity=ErrorSeverity.ERROR,
                    context={"start_time": start_time},
                )
                return DomainResult.failure_from_error(error)

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

            response = StartRecordingResponse(
                success=True,
                recording_id=recording_id,
                start_time=start_time,
            )
            return DomainResult.success(response)

        except AudioDomainException as e:
            # Handle domain-specific audio errors
            if self._error_callback_service:
                self._error_callback_service.notify_error(e.domain_error.message)
            return DomainResult.failure_from_exception(e)

        except RuntimeError as e:
            # Handle specific runtime errors (device issues, etc.)
            error = DomainError(
                message=f"Runtime error during recording start: {e!s}",
                category=ErrorCategory.EXTERNAL_SERVICE_ERROR,
                severity=ErrorSeverity.ERROR,
                context={"exception_type": "RuntimeError"},
            )
            if self._error_callback_service:
                self._error_callback_service.notify_error(error.message)
            return DomainResult.failure_from_error(error)

        except Exception as e:
            # Handle unexpected errors
            error = DomainError(
                message=f"Unexpected error during recording start: {e!s}",
                category=ErrorCategory.SYSTEM_ERROR,
                severity=ErrorSeverity.CRITICAL,
                context={"exception_type": type(e).__name__},
            )
            if self._error_callback_service:
                self._error_callback_service.notify_error(error.message)
            return DomainResult.failure_from_error(error)