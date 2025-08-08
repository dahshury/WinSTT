"""Start transcription use case.

This module contains the use case for starting audio transcription.
"""

from dataclasses import dataclass

from src_refactored.domain.common.abstractions import UseCase
from src_refactored.domain.common.ports.threading_port import IThreadingPort
from src_refactored.domain.common.result import Result
from src_refactored.domain.transcription.entities.transcription_session import TranscriptionSession
from src_refactored.domain.transcription.value_objects.audio_data import AudioData
from src_refactored.domain.transcription.value_objects.model_configuration import ModelConfiguration
from src_refactored.domain.transcription.value_objects.transcription_state import TranscriptionState


@dataclass
class StartTranscriptionRequest:
    """Request for starting transcription."""

    audio_data: AudioData
    model_configuration: ModelConfiguration | None = None
    session_id: str | None = None
    language: str | None = None
    task: str = "transcribe"  # "transcribe" or "translate"
    enable_vad: bool = True
    async_processing: bool = True


@dataclass
class StartTranscriptionResponse:
    """Response for starting transcription."""

    success: bool
    session_id: str | None = None
    transcription_id: str | None = None
    estimated_duration: float | None = None
    processing_started: bool = False
    error_message: str | None = None


class StartTranscriptionUseCase(UseCase[StartTranscriptionRequest, StartTranscriptionResponse]):
    """Use case for starting audio transcription.
    
    This use case handles the initialization and start of transcription processing,
    including model validation, audio preprocessing, and background processing setup.
    """

    def __init__(
        self,
        transcription_session: TranscriptionSession,
        threading_service: IThreadingPort,
        model_service=None,
        vad_service=None,
        progress_callback_service=None,
        error_callback_service=None,
    ):
        """Initialize the start transcription use case.
        
        Args:
            transcription_session: The transcription session entity
            threading_service: Service for threading operations
            model_service: Service for model management and inference
            vad_service: Optional voice activity detection service
            progress_callback_service: Optional service for progress updates
            error_callback_service: Optional service for error notifications
        """
        self._transcription_session = transcription_session
        self._threading_service = threading_service
        self._model_service = model_service
        self._vad_service = vad_service
        self._progress_callback_service = progress_callback_service
        self._error_callback_service = error_callback_service

    def execute(self, request: StartTranscriptionRequest,
    ) -> StartTranscriptionResponse:
        """Execute the start transcription use case.
        
        Args:
            request: The start transcription request
            
        Returns:
            StartTranscriptionResponse containing the start transcription result
        """
        try:
            # Validate current state
            if self._transcription_session.get_state() == TranscriptionState.PROCESSING:
                return StartTranscriptionResponse(
                    success=False,
                    error_message="Transcription is already in progress",
                )

            # Validate audio data
            audio_validation = self._validate_audio_data(request.audio_data)
            if not audio_validation.is_success:
                return StartTranscriptionResponse(
                    success=False,
                    error_message=f"Invalid audio data: {audio_validation.error}",
                )

            # Apply model configuration if provided
            if request.model_configuration:
                config_result = self._transcription_session.configure_model(request.model_configuration)
                if not config_result.is_success:
                    return StartTranscriptionResponse(
                        success=False,
                        error_message=f"Model configuration failed: {config_result.error}",
                    )

            # Validate model availability
            if self._model_service:
                model_validation = self._model_service.validate_model_availability(
                    self._transcription_session.get_model_configuration(),
                )
                if not model_validation.is_success:
                    return StartTranscriptionResponse(
                        success=False,
                        error_message=f"Model validation failed: {model_validation.error}",
                    )

            # Perform VAD check if enabled and service available
            if request.enable_vad and self._vad_service:
                try:
                    vad_result = self._vad_service.detect_speech(request.audio_data)
                    if not vad_result.has_speech:
                        return StartTranscriptionResponse(
                            success=True,
                            session_id=self._transcription_session.get_session_id(),
                            error_message="No speech detected in audio",
                        )
                except Exception as e:
                    # VAD failure shouldn't stop transcription
                    if self._error_callback_service:
                        self._error_callback_service.notify_warning(
                            f"VAD check failed: {e!s}",
                        )

            # Estimate processing duration
            estimated_duration = self._estimate_processing_duration(request.audio_data)

            # Start transcription session
            session_id = request.session_id or self._transcription_session.get_session_id()
            start_result = self._transcription_session.start_transcription(
                audio_data=request.audio_data,
                language=request.language,
                task=request.task,
            )

            if not start_result.is_success:
                if self._error_callback_service:
                    self._error_callback_service.notify_error(
                        f"Failed to start transcription: {start_result.error}",
                    )

                return StartTranscriptionResponse(
                    success=False,
                    session_id=session_id,
                    error_message=start_result.error,
                )

            transcription_id = start_result.value

            # Start background processing if requested
            processing_started = False
            if request.async_processing and self._model_service:
                try:
                    if transcription_id is None:
                        return StartTranscriptionResponse(
                            success=False,
                            error_message="Failed to get transcription ID",
                        )
                    
                    processing_result = self._start_background_processing(
                        transcription_id,
                        request.audio_data,
                        request.language,
                        request.task,
                    )
                    processing_started = processing_result.is_success

                    if not processing_started and self._error_callback_service:
                        self._error_callback_service.notify_warning(
                            f"Failed to start background processing: {processing_result.error}",
                        )

                except Exception as e:
                    if self._error_callback_service:
                        self._error_callback_service.notify_warning(
                            f"Error starting background processing: {e!s}",
                        )

            # Notify progress callback if available
            if self._progress_callback_service:
                self._progress_callback_service.notify_transcription_started(
                    session_id=session_id,
                    transcription_id=transcription_id,
                    estimated_duration=estimated_duration,
                )

            return StartTranscriptionResponse(
                success=True,
                session_id=session_id,
                transcription_id=transcription_id,
                estimated_duration=estimated_duration,
                processing_started=processing_started,
            )

        except Exception as e:
            # Handle unexpected errors
            error_msg = f"Unexpected error starting transcription: {e!s}"
            if self._error_callback_service:
                self._error_callback_service.notify_error(
                    "Error starting transcription. Check logs for details.",
                )

            return StartTranscriptionResponse(
                success=False,
                error_message=error_msg,
            )

    def _validate_audio_data(self, audio_data: AudioData,
    ) -> Result[None]:
        """Validate audio data for transcription.

        Args:
            audio_data: The audio data to validate

        Returns:
            Result indicating validation success or failure
        """
        if not audio_data or not len(audio_data.samples):
            return Result.failure("Audio data cannot be empty")

        if audio_data.duration_seconds < 0.1:
            return Result.failure("Audio too short for transcription (minimum 0.1 seconds)")

        if audio_data.duration_seconds > 300:  # 5 minutes
            return Result.failure("Audio too long for transcription (maximum 5 minutes)")

        if audio_data.sample_rate not in [16000, 22050, 44100, 48000]:
            return Result.failure(f"Unsupported sample rate: {audio_data.sample_rate}")

        return Result.success(None)

    def _estimate_processing_duration(self, audio_data: AudioData,
    ) -> float:
        """Estimate transcription processing duration.

        Args:
            audio_data: The audio data to process

        Returns:
            Estimated processing duration in seconds
        """
        # Base estimation: audio duration * processing factor
        base_factor = 0.3  # Typically processes faster than real-time

        # Adjust based on audio duration (longer audio may have better efficiency)
        if audio_data.duration_seconds > 30:
            base_factor *= 0.8
        elif audio_data.duration_seconds < 5:
            base_factor *= 1.5

        return max(1.0, audio_data.duration_seconds * base_factor)

    def _start_background_processing(
        self,
        transcription_id: str,
        audio_data: AudioData,
        language: str | None,
        task: str,
    ) -> Result[None]:
        """Start background transcription processing.

        Args:
            transcription_id: The transcription ID
            audio_data: The audio data to process
            language: Optional language hint
            task: Transcription task type

        Returns:
            Result indicating if background processing started successfully
        """
        try:
            def process_transcription():
                try:
                    # Start model processing
                    processing_result = self._model_service.process_transcription(
                        transcription_id=transcription_id,
                        audio_data=audio_data,
                        language=language,
                        task=task,
                        progress_callback=self._progress_callback_service,
                    )

                    if processing_result.is_success():
                        # Update session with result
                        self._transcription_session.complete_transcription(
                            transcription_id, processing_result.value,
                        )
                    else:
                        # Handle processing failure
                        self._transcription_session.fail_transcription(
                            transcription_id, processing_result.error,
                        )

                        if self._error_callback_service:
                            self._error_callback_service.notify_error(
                                f"Transcription processing failed: {processing_result.error}",
                            )

                except Exception as e:
                    # Handle unexpected processing errors
                    error_msg = f"Transcription processing error: {e!s}"
                    self._transcription_session.fail_transcription(transcription_id, error_msg)

                    if self._error_callback_service:
                        self._error_callback_service.notify_error(
                            "Transcription Error. Check logs.",
                        )

            # Start processing thread using threading service
            thread_handle = self._threading_service.create_daemon_thread(
                target=process_transcription,
                name=f"transcription-{transcription_id}",
            )
            
            if self._threading_service.start_thread(thread_handle):
                return Result.success(None)
            return Result.failure("Failed to start processing thread")

        except Exception as e:
            return Result.failure(f"Failed to start background processing: {e!s}")