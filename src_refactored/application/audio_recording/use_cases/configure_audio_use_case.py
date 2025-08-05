"""Configure audio use case.

This module contains the use case for configuring audio recording settings.
"""

from dataclasses import dataclass

from ....domain.audio.entities import AudioConfiguration, AudioRecorder
from ....domain.audio.value_objects import AudioFormat, ChannelCount, RecordingState, SampleRate
from ....domain.common.abstractions import UseCase
from ....domain.common.result import Result


@dataclass
class ConfigureAudioRequest:
    """Request for configuring audio recording."""

    sample_rate: SampleRate | None = None
    channels: ChannelCount | None = None
    audio_format: AudioFormat | None = None
    chunk_size: int | None = None
    device_id: int | None = None
    validate_device: bool = True


@dataclass
class ConfigureAudioResponse:
    """Response for configuring audio recording."""

    success: bool
    configuration: AudioConfiguration | None = None
    previous_configuration: AudioConfiguration | None = None
    device_info: dict | None = None
    error_message: str | None = None


class ConfigureAudioUseCase(UseCase[ConfigureAudioRequest, ConfigureAudioResponse]):
    """Use case for configuring audio recording settings.
    
    This use case handles the configuration of audio recording parameters,
    device validation, and configuration persistence.
    """

    def __init__(
        self,
        audio_recorder: AudioRecorder,
        audio_device_service=None,
        error_callback_service=None,
    ):
        """Initialize the configure audio use case.
        
        Args:
            audio_recorder: The audio recorder entity
            audio_device_service: Optional service for audio device management
            error_callback_service: Optional service for error notifications
        """
        self._audio_recorder = audio_recorder
        self._audio_device_service = audio_device_service
        self._error_callback_service = error_callback_service

    def execute(self, request: ConfigureAudioRequest,
    ) -> Result[ConfigureAudioResponse]:
        """Execute the configure audio use case.
        
        Args:
            request: The configure audio request
            
        Returns:
            Result containing the configure audio response
        """
        try:
            # Check if recording is in progress
            if self._audio_recorder.get_state() == RecordingState.RECORDING:
                return Result.failure(
                    ConfigureAudioResponse(
                        success=False,
                        error_message="Cannot configure audio while recording is in progress",
                    )
                    "Cannot configure audio during recording",
                )

            # Get current configuration
            current_config = self._audio_recorder.get_configuration()

            # Build new configuration from request
            new_config_data = {
                "sample_rate": request.sample_rate or current_config.sample_rate,
                "channels": request.channels or current_config.channels,
                "audio_format": request.audio_format or current_config.audio_format,
                "chunk_size": request.chunk_size or current_config.chunk_size,
                "device_id": request.device_id if request.device_id is not None else current_config.device_id,
            }

            # Create new configuration
            try:
                new_configuration = AudioConfiguration(**new_config_data,
    )
            except Exception as e:
                return Result.failure(
                    ConfigureAudioResponse(
                        success=False,
                        error_message=f"Invalid configuration parameters: {e!s}",
                    )
                    f"Invalid configuration: {e!s}",
                )

            # Validate device if requested and service available
            device_info = None
            if request.validate_device and self._audio_device_service:
                try:
                    device_validation = self._audio_device_service.validate_device(
                        new_configuration.device_id,
                        new_configuration.sample_rate.value,
                        new_configuration.channels.value,
                        new_configuration.audio_format,
                    )

                    if not device_validation.is_valid:
                        return Result.failure(
                            ConfigureAudioResponse(
                                success=False,
error_message = (
    f"Device validation failed: {device_validation.error}",),
                            )
                            device_validation.error,
                        )

                    device_info = device_validation.device_info

                except Exception as e:
                    error_msg = f"Device validation error: {e!s}"
                    if self._error_callback_service:
                        self._error_callback_service.notify_warning(error_msg)

                    # Continue with configuration even if validation fails
                    # unless it's a critical error

            # Apply configuration to recorder
            config_result = self._audio_recorder.configure(new_configuration)

            if config_result.is_failure(,
    ):
                if self._error_callback_service:
                    self._error_callback_service.notify_error(
                        f"Failed to apply audio configuration: {config_result.error}",
                    )

                return Result.failure(
                    ConfigureAudioResponse(
                        success=False,
                        configuration=current_config,
                        error_message=config_result.error,
                    )
                    config_result.error,
                )

            # Test configuration if device service available
            if self._audio_device_service:
                try:
                    test_result = self._audio_device_service.test_configuration(new_configuration)
                    if not test_result.success:
                        # Rollback configuration
                        self._audio_recorder.configure(current_config,
    )

                        return Result.failure(
                            ConfigureAudioResponse(
                                success=False,
                                configuration=current_config,
                                error_message=f"Configuration test failed: {test_result.error}",
                            )
                            test_result.error,
                        )
                except Exception as e:
                    # Test failure is not critical, log warning
                    if self._error_callback_service:
                        self._error_callback_service.notify_warning(
                            f"Configuration test failed: {e!s}",
                        )

            return Result.success(
                ConfigureAudioResponse(
                    success=True,
                    configuration=new_configuration,
                    previous_configuration=current_config,
                    device_info=device_info,
                ),
            )

        except Exception as e:
            # Handle unexpected errors
            error_msg = f"Unexpected error configuring audio: {e!s}"
            if self._error_callback_service:
                self._error_callback_service.notify_error(
                    "Error configuring audio. Check logs for details.",
                )

            return Result.failure(
                ConfigureAudioResponse(
                    success=False,
                    error_message=error_msg,
                )
                error_msg,
            )