"""Transcribe Audio Data Use Case.

This module implements the TranscribeAudioDataUseCase for handling transcription
of audio data in memory with progress tracking and error handling.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable


class TranscriptionResult(Enum):
    """Enumeration of transcription results."""
    SUCCESS = "success"
    FAILURE = "failure"
    INVALID_DATA = "invalid_data"
    TRANSCRIPTION_FAILED = "transcription_failed"
    SAVE_FAILED = "save_failed"
    CANCELLED = "cancelled"


class TranscriptionPhase(Enum):
    """Enumeration of transcription phases."""
    INITIALIZING = "initializing"
    VALIDATING_DATA = "validating_data"
    PREPARING_OUTPUT = "preparing_output"
    TRANSCRIBING = "transcribing"
    SAVING_OUTPUT = "saving_output"
    UPDATING_PROGRESS = "updating_progress"
    COMPLETING = "completing"
    ERROR_HANDLING = "error_handling"


class AudioDataType(Enum):
    """Enumeration of audio data types."""
    WAV = "wav"
    MP3 = "mp3"
    FLAC = "flac"
    OGG = "ogg"
    M4A = "m4a"
    UNKNOWN = "unknown"


class OutputFormat(Enum):
    """Enumeration of output formats."""
    SRT = "srt"
    TXT = "txt"
    VTT = "vtt"
    JSON = "json"


@dataclass
class AudioDataInfo:
    """Information about audio data."""
    data_type: AudioDataType
    audio_bytes: bytes
    output_base_path: str
    estimated_duration: float | None = None
    sample_rate: int | None = None
    channels: int | None = None
    bit_depth: int | None = None
    metadata: dict[str, Any] | None = None


@dataclass
class TranscriptionConfiguration:
    """Configuration for audio data transcription."""
    output_format: OutputFormat = OutputFormat.SRT
    save_intermediate_results: bool = True
    create_backup: bool = False
    progress_callback_interval: float = 0.1
    timeout: float | None = None
    cleanup_temp_files: bool = True
    validate_audio_data: bool = True


@dataclass
class TranscribeAudioDataRequest:
    """Request for transcribing audio data."""
    audio_data_info: AudioDataInfo
    configuration: TranscriptionConfiguration
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[TranscriptionResult], None] | None = None
    error_callback: Callable[[str], None] | None = None
    continue_batch_callback: Callable[[], None] | None = None


@dataclass
class TranscribeAudioDataResponse:
    """Response from transcribing audio data."""
    result: TranscriptionResult
    output_path: str | None = None
    transcription_text: str | None = None
    transcription_segments: list[dict[str, Any]] | None = None
    processing_time: float | None = None
    audio_duration: float | None = None
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class AudioDataValidationServiceProtocol(Protocol):
    """Protocol for audio data validation service."""

    def validate_audio_data(self, audio_data: tuple[str, bytes, str]) -> bool:
        """Validate audio data format and content.
        
        Args:
            audio_data: Tuple of (type, audio_bytes, output_path)
            
        Returns:
            True if audio data is valid
        """
        ...

    def get_audio_info(self, audio_data: tuple[str, bytes, str]) -> AudioDataInfo | None:
        """Get information about audio data.
        
        Args:
            audio_data: Tuple of (type, audio_bytes, output_path)
            
        Returns:
            AudioDataInfo or None if invalid
        """
        ...


class TranscriptionServiceProtocol(Protocol):
    """Protocol for transcription service."""

    def transcribe_audio_data(self, audio_data: tuple[str, bytes, str]) -> dict[str, Any] | None:
        """Transcribe audio data in memory.
        
        Args:
            audio_data: Tuple of (type, audio_bytes, output_path)
            
        Returns:
            Transcription result with text and segments
        """
        ...


class OutputServiceProtocol(Protocol):
    """Protocol for output service."""

    def save_transcription(
        self,
        transcription: dict[str, Any],
        output_path: str,
        output_format: OutputFormat,
    ) -> bool:
        """Save transcription to file.
        
        Args:
            transcription: Transcription data
            output_path: Output file path (without extension)
            output_format: Desired output format
            
        Returns:
            True if saved successfully
        """
        ...

    def format_time_srt(self, time_seconds: float,
    ) -> str:
        """Format time for SRT format.
        
        Args:
            time_seconds: Time in seconds
            
        Returns:
            Formatted time string
        """
        ...

    def get_output_extension(self, output_format: OutputFormat,
    ) -> str:
        """Get file extension for output format.
        
        Args:
            output_format: Output format
            
        Returns:
            File extension (without dot)
        """
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking service."""

    def update_transcription_progress(self, message: str, percentage: float,
    ) -> None:
        """Update transcription progress.
        
        Args:
            message: Progress message
            percentage: Progress percentage (0-100)
        """
        ...

    def set_progress_visible(self, visible: bool,
    ) -> None:
        """Set progress bar visibility.
        
        Args:
            visible: Whether progress bar should be visible
        """
        ...


class BatchManagementServiceProtocol(Protocol):
    """Protocol for batch management service."""

    def get_total_files_count(self) -> int:
        """Get total files count in current batch.
        
        Returns:
            Total number of files
        """
        ...

    def get_current_file_index(self) -> int:
        """Get current file index.
        
        Returns:
            Current file index
        """
        ...

    def is_batch_processing(self) -> bool:
        """Check if batch processing is active.
        
        Returns:
            True if batch processing is active
        """
        ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logger service."""

    def log_info(self, message: str, **kwargs) -> None:
        """Log an info message."""
        ...

    def log_warning(self, message: str, **kwargs) -> None:
        """Log a warning message."""
        ...

    def log_error(self, message: str, **kwargs) -> None:
        """Log an error message."""
        ...

    def log_debug(self, message: str, **kwargs) -> None:
        """Log a debug message."""
        ...


class TranscribeAudioDataUseCase:
    """Use case for transcribing audio data in memory."""

    def __init__(
        self,
        audio_data_validation_service: AudioDataValidationServiceProtocol,
        transcription_service: TranscriptionServiceProtocol,
        output_service: OutputServiceProtocol,
        progress_tracking_service: ProgressTrackingServiceProtocol,
        batch_management_service: BatchManagementServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        """Initialize the use case.
        
        Args:
            audio_data_validation_service: Service for audio data validation
            transcription_service: Service for transcription
            output_service: Service for output handling
            progress_tracking_service: Service for progress tracking
            batch_management_service: Service for batch management
            logger_service: Service for logging
        """
        self._audio_data_validation_service = audio_data_validation_service
        self._transcription_service = transcription_service
        self._output_service = output_service
        self._progress_tracking_service = progress_tracking_service
        self._batch_management_service = batch_management_service
        self._logger_service = logger_service

    def execute(self, request: TranscribeAudioDataRequest,
    ) -> TranscribeAudioDataResponse:
        """Execute the transcribe audio data use case.
        
        Args:
            request: The transcription request
            
        Returns:
            TranscribeAudioDataResponse with transcription results
        """
        import time
        start_time = time.time()

        try:
            # Phase 1: Initialize and validate
            self._logger_service.log_info(
                "Starting audio data transcription",
                phase=TranscriptionPhase.INITIALIZING.value,
                output_path=request.audio_data_info.output_base_path,
            )

            # Prepare audio data tuple for processing
            audio_data = (
                request.audio_data_info.data_type.value,
                request.audio_data_info.audio_bytes,
                request.audio_data_info.output_base_path,
            )

            # Phase 2: Validate audio data if configured
            if request.configuration.validate_audio_data:
                self._logger_service.log_info(
                    "Validating audio data",
                    phase=TranscriptionPhase.VALIDATING_DATA.value,
                )

                if not self._audio_data_validation_service.validate_audio_data(audio_data):
                    error_message = "Invalid audio data format or content"
                    self._logger_service.log_error("Audio data validation failed")

                    if request.error_callback:
                        request.error_callback(error_message)

                    return TranscribeAudioDataResponse(
                        result=TranscriptionResult.INVALID_DATA,
                        processing_time=time.time() - start_time,
                        error_message=error_message,
                    )

            # Phase 3: Prepare output path and progress
            filename = os.path.basename(request.audio_data_info.output_base_path)

            # Get file count text if in batch processing
            file_count_text = ""
            if self._batch_management_service.is_batch_processing():
                current_index = self._batch_management_service.get_current_file_index()
                total_files = self._batch_management_service.get_total_files_count()
                file_count_text = f" ({current_index}/{total_files})"

            # Update initial progress
            initial_message = f"Transcribing: {filename}{file_count_text}"

            if request.progress_callback:
                request.progress_callback(initial_message, 10.0)

            self._progress_tracking_service.update_transcription_progress(initial_message, 10.0)

            self._logger_service.log_info(
                "Preparing audio data transcription",
                phase=TranscriptionPhase.PREPARING_OUTPUT.value,
                filename=filename,
            )

            # Phase 4: Transcribe audio data
            self._logger_service.log_info(
                "Transcribing audio data",
                phase=TranscriptionPhase.TRANSCRIBING.value,
            )

            # Update progress for transcription start
            transcription_message = f"Processing audio: {filename}{file_count_text}"

            if request.progress_callback:
                request.progress_callback(transcription_message, 30.0)

            self._progress_tracking_service.update_transcription_progress(transcription_message, 30.0)

            # Perform transcription
            transcript = self._transcription_service.transcribe_audio_data(audio_data)

            if not transcript:
                error_message = f"Transcription failed for: {filename}{file_count_text}"
                self._logger_service.log_error("Audio data transcription failed")

                if request.error_callback:
                    request.error_callback(error_message,
    )

                return TranscribeAudioDataResponse(
                    result=TranscriptionResult.TRANSCRIPTION_FAILED,
                    processing_time=time.time() - start_time,
                    error_message=error_message,
                )

            # Update progress after transcription
            if request.progress_callback:
                request.progress_callback(f"Transcription completed: {filename}{file_count_text}", 70.0)

            self._progress_tracking_service.update_transcription_progress(
                f"Transcription completed: {filename}{file_count_text}", 70.0,
            )

            # Phase 5: Save transcription output
            self._logger_service.log_info(
                "Saving transcription output",
                phase=TranscriptionPhase.SAVING_OUTPUT.value,
            )

            # Determine output format
            output_format = request.configuration.output_format
            extension = self._output_service.get_output_extension(output_format)

            # Save transcription
            success = self._output_service.save_transcription(
                transcript, request.audio_data_info.output_base_path, output_format,
            )

            if not success:
                error_message = f"Failed to save transcription for: {filename}"
                self._logger_service.log_error("Failed to save transcription output")

                if request.error_callback:
                    request.error_callback(error_message,
    )

                return TranscribeAudioDataResponse(
                    result=TranscriptionResult.SAVE_FAILED,
                    transcription_text=transcript.get("text", ""),
                    transcription_segments=transcript.get("segments", []),
                    processing_time=time.time() - start_time,
                    error_message=error_message,
                )

            # Phase 6: Complete and update final progress
            full_output_path = f"{request.audio_data_info.output_base_path}.{extension}"
            success_message = f"Saved transcript to: {os.path.basename(full_output_path)}{file_count_text}"

            if request.progress_callback:
                request.progress_callback(success_message, 90.0)

            self._progress_tracking_service.update_transcription_progress(success_message, 90.0)

            # Extract transcription details
            transcription_text = transcript.get("text", "")
            transcription_segments = transcript.get("segments", [])
            audio_duration = transcript.get("duration")

            processing_time = time.time() - start_time

            self._logger_service.log_info(
                "Audio data transcription completed",
                phase=TranscriptionPhase.COMPLETING.value,
                output_path=full_output_path,
                processing_time=processing_time,
            )

            # Continue batch processing if configured
            if request.continue_batch_callback:
                request.continue_batch_callback()

            if request.completion_callback:
                request.completion_callback(TranscriptionResult.SUCCESS)

            return TranscribeAudioDataResponse(
                result=TranscriptionResult.SUCCESS,
                output_path=full_output_path,
                transcription_text=transcription_text,
                transcription_segments=transcription_segments,
                processing_time=processing_time,
                audio_duration=audio_duration,
            )

        except Exception as e:
            error_message = f"Error transcribing audio data: {e!s}"

            self._logger_service.log_error(
                "Audio data transcription failed",
                phase=TranscriptionPhase.ERROR_HANDLING.value,
                error=str(e),
            )

            if request.error_callback:
                request.error_callback(error_message)

            return TranscribeAudioDataResponse(
                result=TranscriptionResult.FAILURE,
                processing_time=time.time() - start_time,
                error_message=error_message,
            )

    def safe_display_message(self, message: str, percentage: float = 0.0) -> None:
        """Safely display a message with progress.

        This method provides a safe way to update progress that can be called
        from different contexts without causing UI thread issues.

        Args:
            message: Message to display
            percentage: Progress percentage (0-100,
    )
        """
        try:
            self._progress_tracking_service.update_transcription_progress(message, percentage)
            self._logger_service.log_debug("Progress updated", message=message, percentage=percentage)
        except Exception as e:
            self._logger_service.log_warning(
                "Failed to update progress display",
                error=str(e),
                message=message,
                percentage=percentage,
            )