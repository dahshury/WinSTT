"""Process Next File Use Case.

This module implements the ProcessNextFileUseCase for handling individual file
processing from the transcription queue with progress tracking.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable


class ProcessingResult(Enum):
    """Enumeration of processing results."""
    SUCCESS = "success"
    FAILURE = "failure"
    QUEUE_EMPTY = "queue_empty"
    CONVERSION_FAILED = "conversion_failed"
    TRANSCRIPTION_FAILED = "transcription_failed"
    SAVE_FAILED = "save_failed"
    CANCELLED = "cancelled"


class ProcessingPhase(Enum):
    """Enumeration of processing phases."""
    INITIALIZING = "initializing"
    CHECKING_QUEUE = "checking_queue"
    RETRIEVING_FILE = "retrieving_file"
    UPDATING_PROGRESS = "updating_progress"
    CONVERTING_VIDEO = "converting_video"
    TRANSCRIBING = "transcribing"
    SAVING_OUTPUT = "saving_output"
    CONTINUING_BATCH = "continuing_batch"
    COMPLETING = "completing"
    ERROR_HANDLING = "error_handling"


class FileType(Enum):
    """Enumeration of file types."""
    AUDIO_FILE = "audio_file"
    VIDEO_FILE = "video_file"
    MEMORY_AUDIO = "memory_audio"
    UNKNOWN = "unknown"


class OutputFormat(Enum):
    """Enumeration of output formats."""
    SRT = "srt"
    TXT = "txt"
    VTT = "vtt"
    JSON = "json"


@dataclass
class QueueItem:
    """Item in the transcription queue."""
    file_path: str
    file_type: FileType
    priority: int = 0
    metadata: dict[str, Any] | None = None
    estimated_duration: float | None = None
    retry_count: int = 0
    max_retries: int = 3


@dataclass
class ProcessingConfiguration:
    """Configuration for file processing."""
    output_format: OutputFormat = OutputFormat.SRT
    auto_continue: bool = True
    max_retries: int = 3
    save_intermediate_results: bool = True
    create_backup: bool = False
    timeout_per_file: float | None = None
    cleanup_temp_files: bool = True


@dataclass
class ProcessNextFileRequest:
    """Request for processing next file."""
    configuration: ProcessingConfiguration
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[ProcessingResult], None] | None = None
    error_callback: Callable[[str], None] | None = None
    continue_batch_callback: Callable[[], None] | None = None


@dataclass
class ProcessNextFileResponse:
    """Response from processing next file."""
    result: ProcessingResult
    processed_file: str | None = None
    output_path: str | None = None
    file_type: FileType | None = None
    processing_time: float | None = None
    queue_size_remaining: int = 0
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class TranscriptionQueueServiceProtocol(Protocol):
    """Protocol for transcription queue service."""

    def get_queue_size(self) -> int:
        """Get the current queue size.
        
        Returns:
            Number of items in queue
        """
        ...

    def get_next_item(self) -> QueueItem | None:
        """Get the next item from the queue.
        
        Returns:
            Next queue item or None if empty
        """
        ...

    def is_empty(self) -> bool:
        """Check if the queue is empty.
        
        Returns:
            True if queue is empty
        """
        ...

    def peek_next_item(self) -> QueueItem | None:
        """Peek at the next item without removing it.
        
        Returns:
            Next queue item or None if empty
        """
        ...


class VideoConversionServiceProtocol(Protocol,
    ):
    """Protocol for video conversion service."""

    def convert_video_to_audio(self, video_path: str,
    ) -> tuple[str, bytes, str] | None:
        """Convert a video file to audio.
        
        Args:
            video_path: Path to the video file
            
        Returns:
            Tuple of (type, audio_bytes, output_path) or None if failed
        """
        ...


class TranscriptionServiceProtocol(Protocol):
    """Protocol for transcription service."""

    def transcribe_file(self, file_path: str,
    ) -> dict[str, Any] | None:
        """Transcribe an audio file.
        
        Args:
            file_path: Path to the audio file
            
        Returns:
            Transcription result with text and segments
        """
        ...

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


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking service."""

    def update_file_progress(self, current_file: int, total_files: int, message: str,
    ) -> None:
        """Update file progress.
        
        Args:
            current_file: Current file index
            total_files: Total number of files
            message: Progress message
        """
        ...

    def get_batch_progress_percentage(self, completed_files: int, total_files: int,
    ) -> float:
        """Get batch progress percentage.
        
        Args:
            completed_files: Number of completed files
            total_files: Total number of files
            
        Returns:
            Progress percentage (0-100)
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

    def increment_file_index(self) -> int:
        """Increment and return current file index.
        
        Returns:
            New current file index
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


class ProcessNextFileUseCase:
    """Use case for processing the next file in the transcription queue."""

    def __init__(
        self,
        transcription_queue_service: TranscriptionQueueServiceProtocol,
        video_conversion_service: VideoConversionServiceProtocol,
        transcription_service: TranscriptionServiceProtocol,
        output_service: OutputServiceProtocol,
        progress_tracking_service: ProgressTrackingServiceProtocol,
        batch_management_service: BatchManagementServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        """Initialize the use case.
        
        Args:
            transcription_queue_service: Service for queue management
            video_conversion_service: Service for video conversion
            transcription_service: Service for transcription
            output_service: Service for output handling
            progress_tracking_service: Service for progress tracking
            batch_management_service: Service for batch management
            logger_service: Service for logging
        """
        self._transcription_queue_service = transcription_queue_service
        self._video_conversion_service = video_conversion_service
        self._transcription_service = transcription_service
        self._output_service = output_service
        self._progress_tracking_service = progress_tracking_service
        self._batch_management_service = batch_management_service
        self._logger_service = logger_service

    def execute(self, request: ProcessNextFileRequest,
    ) -> ProcessNextFileResponse:
        """Execute the process next file use case.
        
        Args:
            request: The processing request
            
        Returns:
            ProcessNextFileResponse with processing results
        """
        import time
        start_time = time.time()

        try:
            # Phase 1: Check queue status
            self._logger_service.log_info(
                "Processing next file",
                phase=ProcessingPhase.CHECKING_QUEUE.value,
            )

            if self._transcription_queue_service.is_empty():
                self._logger_service.log_info("Transcription queue is empty")

                # Hide progress bar when queue is empty
                self._progress_tracking_service.set_progress_visible(False)

                if request.progress_callback:
                    request.progress_callback("Transcription complete!", 100.0)

                if request.completion_callback:
                    request.completion_callback(ProcessingResult.QUEUE_EMPTY)

                return ProcessNextFileResponse(
                    result=ProcessingResult.QUEUE_EMPTY,
                    queue_size_remaining=0,
                    processing_time=time.time() - start_time,
                )

            # Phase 2: Get next file from queue
            queue_item = self._transcription_queue_service.get_next_item()
            if not queue_item:
                return ProcessNextFileResponse(
                    result=ProcessingResult.QUEUE_EMPTY,
                    queue_size_remaining=0,
                    processing_time=time.time() - start_time,
                )

            # Phase 3: Update progress tracking
            current_file_index = self._batch_management_service.increment_file_index()
            total_files = self._batch_management_service.get_total_files_count()

            file_count_text = f" ({current_file_index}/{total_files})"
            os.path.basename(queue_item.file_path)

            # Calculate progress percentage
            progress_percentage = self._progress_tracking_service.get_batch_progress_percentage(
                current_file_index - 1, total_files,
            )

            self._logger_service.log_info(
                "Processing file from queue",
                phase=ProcessingPhase.RETRIEVING_FILE.value,
                file_path=queue_item.file_path,
                file_type=queue_item.file_type.value,
                current_index=current_file_index,
                total_files=total_files,
            )

            # Phase 4: Process file based on type
            if queue_item.file_type == FileType.VIDEO_FILE:
                result = self._process_video_file(
                    queue_item, request, progress_percentage, file_count_text,
                )
            elif queue_item.file_type == FileType.MEMORY_AUDIO:
                result = self._process_memory_audio(
                    queue_item, request, progress_percentage, file_count_text,
                )
            else:
                result = self._process_audio_file(
                    queue_item, request, progress_percentage, file_count_text,
                )

            # Phase 5: Continue batch processing if configured
            if (request.configuration.auto_continue and
                not self._transcription_queue_service.is_empty() and
                result.result == ProcessingResult.SUCCESS) and request.continue_batch_callback:
                request.continue_batch_callback()

            # Update response with queue status
            result.queue_size_remaining = self._transcription_queue_service.get_queue_size()
            result.processing_time = time.time() - start_time

            if request.completion_callback:
                request.completion_callback(result.result)

            self._logger_service.log_info(
                "File processing completed",
                phase=ProcessingPhase.COMPLETING.value,
                result=result.result.value,
                processed_file=result.processed_file,
                output_path=result.output_path,
            )

            return result

        except Exception as e:
            error_message = f"Error processing next file: {e!s}"

            self._logger_service.log_error(
                "File processing failed",
                phase=ProcessingPhase.ERROR_HANDLING.value,
                error=str(e),
            )

            if request.error_callback:
                request.error_callback(error_message)

            return ProcessNextFileResponse(
                result=ProcessingResult.FAILURE,
                queue_size_remaining=self._transcription_queue_service.get_queue_size(),
                processing_time=time.time() - start_time,
                error_message=error_message,
            )

    def _process_video_file(
        self,
        queue_item: QueueItem,
        request: ProcessNextFileRequest,
        progress_percentage: float,
        file_count_text: str,
    ) -> ProcessNextFileResponse:
        """Process a video file.
        
        Args:
            queue_item: Queue item containing video file
            request: Processing request
            progress_percentage: Current progress percentage
            file_count_text: File count text for display
            
        Returns:
            ProcessNextFileResponse with processing results
        """
        try:
            video_path = queue_item.file_path
            base_name = os.path.basename(video_path)

            # Update progress for video conversion
            message = f"Converting video: {base_name}{file_count_text}"

            if request.progress_callback:
                request.progress_callback(message, progress_percentage)

            current_file_index = self._batch_management_service.get_current_file_index()
            total_files = self._batch_management_service.get_total_files_count()

            self._progress_tracking_service.update_file_progress(
                current_file_index, total_files, message,
            )

            self._logger_service.log_info(
                "Converting video to audio",
                phase=ProcessingPhase.CONVERTING_VIDEO.value,
                video_path=video_path,
            )

            # Convert video to audio
            audio_data = self._video_conversion_service.convert_video_to_audio(video_path)

            if not audio_data:
                error_message = f"Failed to convert video: {base_name}{file_count_text}"
                self._logger_service.log_error("Video conversion failed", video_path=video_path)

                if request.error_callback:
                    request.error_callback(error_message)

                return ProcessNextFileResponse(
                    result=ProcessingResult.CONVERSION_FAILED,
                    processed_file=video_path,
                    file_type=FileType.VIDEO_FILE,
                    error_message=error_message,
                )

            # Transcribe the converted audio
            return self._transcribe_audio_data(
                audio_data, request, file_count_text, FileType.VIDEO_FILE,
            )

        except Exception as e:
            error_message = f"Error processing video file: {e!s}"
            self._logger_service.log_error("Video processing error", error=str(e))

            return ProcessNextFileResponse(
                result=ProcessingResult.FAILURE,
                processed_file=queue_item.file_path,
                file_type=FileType.VIDEO_FILE,
                error_message=error_message,
            )

    def _process_memory_audio(
        self,
        queue_item: QueueItem,
        request: ProcessNextFileRequest,
        progress_percentage: float,
        file_count_text: str,
    ) -> ProcessNextFileResponse:
        """Process memory audio data.
        
        Args:
            queue_item: Queue item containing memory audio
            request: Processing request
            progress_percentage: Current progress percentage
            file_count_text: File count text for display
            
        Returns:
            ProcessNextFileResponse with processing results
        """
        try:
            # Parse audio data from file path (stored as tuple)
            audio_data = eval(queue_item.file_path)  # Note: In real implementation, use proper serialization

            return self._transcribe_audio_data(
                audio_data, request, file_count_text, FileType.MEMORY_AUDIO,
            )

        except Exception as e:
            error_message = f"Error processing memory audio: {e!s}"
            self._logger_service.log_error("Memory audio processing error", error=str(e))

            return ProcessNextFileResponse(
                result=ProcessingResult.FAILURE,
                processed_file=queue_item.file_path,
                file_type=FileType.MEMORY_AUDIO,
                error_message=error_message,
            )

    def _process_audio_file(
        self,
        queue_item: QueueItem,
        request: ProcessNextFileRequest,
        progress_percentage: float,
        file_count_text: str,
    ) -> ProcessNextFileResponse:
        """Process an audio file.
        
        Args:
            queue_item: Queue item containing audio file
            request: Processing request
            progress_percentage: Current progress percentage
            file_count_text: File count text for display
            
        Returns:
            ProcessNextFileResponse with processing results
        """
        try:
            file_path = queue_item.file_path
            base_name = os.path.basename(file_path)

            # Update progress for transcription
            message = f"Transcribing: {base_name}{file_count_text}"

            if request.progress_callback:
                request.progress_callback(message, progress_percentage)

            current_file_index = self._batch_management_service.get_current_file_index()
            total_files = self._batch_management_service.get_total_files_count()

            self._progress_tracking_service.update_file_progress(
                current_file_index, total_files, message,
            )

            self._logger_service.log_info(
                "Transcribing audio file",
                phase=ProcessingPhase.TRANSCRIBING.value,
                file_path=file_path,
            )

            # Transcribe the file
            transcript = self._transcription_service.transcribe_file(file_path)

            if not transcript:
                error_message = f"Transcription failed for: {base_name}{file_count_text}"
                self._logger_service.log_error("Transcription failed", file_path=file_path)

                if request.error_callback:
                    request.error_callback(error_message)

                return ProcessNextFileResponse(
                    result=ProcessingResult.TRANSCRIPTION_FAILED,
                    processed_file=file_path,
                    file_type=FileType.AUDIO_FILE,
                    error_message=error_message,
                )

            # Save transcription
            output_path = os.path.splitext(file_path)[0]
            success = self._output_service.save_transcription(
                transcript, output_path, request.configuration.output_format,
            )

            if success:
                extension = request.configuration.output_format.value
                full_output_path = f"{output_path}.{extension}"
                success_message = f"Saved transcript to: {os.path.basename(full_output_path)}{file_count_text}"

                if request.progress_callback:
                    request.progress_callback(success_message, progress_percentage + 10)

                self._logger_service.log_info(
                    "File transcription completed",
                    phase=ProcessingPhase.SAVING_OUTPUT.value,
                    file_path=file_path,
                    output_path=full_output_path,
                )

                return ProcessNextFileResponse(
                    result=ProcessingResult.SUCCESS,
                    processed_file=file_path,
                    output_path=full_output_path,
                    file_type=FileType.AUDIO_FILE,
                )
            error_message = f"Failed to save transcription for: {base_name}"

            return ProcessNextFileResponse(
                result=ProcessingResult.SAVE_FAILED,
                processed_file=file_path,
                file_type=FileType.AUDIO_FILE,
                error_message=error_message,
            )

        except Exception as e:
            error_message = f"Error transcribing file: {e!s}"
            self._logger_service.log_error("File transcription error", error=str(e))

            return ProcessNextFileResponse(
                result=ProcessingResult.FAILURE,
                processed_file=queue_item.file_path,
                file_type=FileType.AUDIO_FILE,
                error_message=error_message,
            )

    def _transcribe_audio_data(
        self,
        audio_data: tuple[str, bytes, str],
        request: ProcessNextFileRequest,
        file_count_text: str,
        original_file_type: FileType,
    ) -> ProcessNextFileResponse:
        """Transcribe audio data in memory.
        
        Args:
            audio_data: Tuple of (type, audio_bytes, output_path)
            request: Processing request
            file_count_text: File count text for display
            original_file_type: Original file type (video or memory audio)
            
        Returns:
            ProcessNextFileResponse with processing results
        """
        try:
            data_type, audio_bytes, output_base_path = audio_data
            filename = os.path.basename(output_base_path)

            # Update progress for transcription
            message = f"Transcribing: {filename}{file_count_text}"

            if request.progress_callback:
                request.progress_callback(message, 50.0)

            current_file_index = self._batch_management_service.get_current_file_index()
            total_files = self._batch_management_service.get_total_files_count()

            self._progress_tracking_service.update_file_progress(
                current_file_index, total_files, message,
            )

            self._logger_service.log_info(
                "Transcribing audio data",
                phase=ProcessingPhase.TRANSCRIBING.value,
                output_base_path=output_base_path,
            )

            # Transcribe the audio data
            transcript = self._transcription_service.transcribe_audio_data(audio_data)

            if not transcript:
                error_message = f"Transcription failed for: {filename}{file_count_text}"
                self._logger_service.log_error("Audio data transcription failed")

                if request.error_callback:
                    request.error_callback(error_message,
    )

                return ProcessNextFileResponse(
                    result=ProcessingResult.TRANSCRIPTION_FAILED,
                    processed_file=output_base_path,
                    file_type=original_file_type,
                    error_message=error_message,
                )

            # Save transcription
            success = self._output_service.save_transcription(
                transcript, output_base_path, request.configuration.output_format,
            )

            if success:
                extension = request.configuration.output_format.value
                full_output_path = f"{output_base_path}.{extension}"
                success_message = f"Saved transcript to: {os.path.basename(full_output_path)}{file_count_text}"

                if request.progress_callback:
                    request.progress_callback(success_message, 90.0)

                self._logger_service.log_info(
                    "Audio data transcription completed",
                    phase=ProcessingPhase.SAVING_OUTPUT.value,
                    output_path=full_output_path,
                )

                return ProcessNextFileResponse(
                    result=ProcessingResult.SUCCESS,
                    processed_file=output_base_path,
                    output_path=full_output_path,
                    file_type=original_file_type,
                )
            error_message = f"Failed to save transcription for: {filename}"

            return ProcessNextFileResponse(
                result=ProcessingResult.SAVE_FAILED,
                processed_file=output_base_path,
                file_type=original_file_type,
                error_message=error_message,
            )

        except Exception as e:
            error_message = f"Error transcribing audio data: {e!s}"
            self._logger_service.log_error("Audio data transcription error", error=str(e))

            return ProcessNextFileResponse(
                result=ProcessingResult.FAILURE,
                processed_file=audio_data[2] if len(audio_data) > 2 else "unknown",
                file_type=original_file_type,
                error_message=error_message,
            )