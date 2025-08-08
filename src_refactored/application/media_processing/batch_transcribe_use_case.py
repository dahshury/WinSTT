"""Batch Transcribe Use Case.

This module implements the BatchTranscribeUseCase for handling batch transcription
workflows with progress tracking and error handling.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable

    from src_refactored.domain.common.ports.file_system_port import FileSystemPort
    from src_refactored.domain.common.ports.serialization_port import SerializationPort

from src_refactored.domain.media.value_objects.transcription_operations import (
    FileType,
    OutputFormat,
    TranscriptionPhase,
    TranscriptionResult,
)


class TranscriptionStrategy(Enum):
    """Enumeration of transcription strategies."""
    SEQUENTIAL = "sequential"
    PARALLEL = "parallel"
    PRIORITY_BASED = "priority_based"
    ADAPTIVE = "adaptive"


@dataclass
class AudioDataPayload:
    """Container for in-memory audio data."""
    audio_type: str
    audio_bytes: bytes
    output_path: str
    
    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        import base64
        return {
            "audio_type": self.audio_type,
            "audio_bytes": base64.b64encode(self.audio_bytes).decode("utf-8"),
            "output_path": self.output_path,
        }
    
    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AudioDataPayload:
        """Create from dictionary after deserialization."""
        import base64
        return cls(
            audio_type=data["audio_type"],
            audio_bytes=base64.b64decode(data["audio_bytes"].encode("utf-8")),
            output_path=data["output_path"],
        )


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
    audio_data_payload: AudioDataPayload | None = None  # For MEMORY_AUDIO type


@dataclass
class TranscriptionConfiguration:
    """Configuration for batch transcription."""
    output_format: OutputFormat = OutputFormat.SRT
    strategy: TranscriptionStrategy = TranscriptionStrategy.SEQUENTIAL
    max_parallel_jobs: int = 1
    auto_retry: bool = True
    max_retries: int = 3
    save_intermediate_results: bool = True
    create_backup: bool = False
    progress_callback_interval: float = 0.1
    timeout_per_file: float | None = None
    cleanup_temp_files: bool = True


@dataclass
class BatchTranscribeRequest:
    """Request for batch transcription."""
    configuration: TranscriptionConfiguration
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[TranscriptionResult], None] | None = None
    error_callback: Callable[[str], None] | None = None
    file_completion_callback: Callable[[str, bool], None] | None = None


@dataclass
class FileTranscriptionStatus:
    """Status of individual file transcription."""
    file_path: str
    file_type: FileType
    status: str
    progress: float = 0.0
    output_path: str | None = None
    error_message: str | None = None
    transcription_time: float | None = None
    retry_count: int = 0


@dataclass
class BatchTranscribeResponse:
    """Response from batch transcription."""
    result: TranscriptionResult
    total_files: int
    completed_files: int
    failed_files: int
    remaining_files: int
    file_statuses: list[FileTranscriptionStatus]
    total_processing_time: float
    average_time_per_file: float | None = None
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

    def clear_queue(self) -> None:
        """Clear the transcription queue."""
        ...

    def get_queue_items(self) -> list[QueueItem]:
        """Get all items in the queue.
        
        Returns:
            List of queue items
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

    def format_time_srt(self, time_seconds: float,
    ) -> str:
        """Format time for SRT format.
        
        Args:
            time_seconds: Time in seconds
            
        Returns:
            Formatted time string
        """
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking service."""

    def initialize_batch_progress(self, total_files: int,
    ) -> None:
        """Initialize batch progress tracking.
        
        Args:
            total_files: Total number of files to process
        """
        ...

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


class BatchTranscribeUseCase:
    """Use case for batch transcription with progress tracking."""

    def __init__(
        self,
        transcription_queue_service: TranscriptionQueueServiceProtocol,
        video_conversion_service: VideoConversionServiceProtocol,
        transcription_service: TranscriptionServiceProtocol,
        output_service: OutputServiceProtocol,
        progress_tracking_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
        file_system_service: FileSystemPort,
        serialization_service: SerializationPort,
    ):
        """Initialize the use case.
        
        Args:
            transcription_queue_service: Service for queue management
            video_conversion_service: Service for video conversion
            transcription_service: Service for transcription
            output_service: Service for output handling
            progress_tracking_service: Service for progress tracking
            logger_service: Service for logging
            file_system_service: Service for file system operations
            serialization_service: Service for serialization operations
        """
        self._transcription_queue_service = transcription_queue_service
        self._video_conversion_service = video_conversion_service
        self._transcription_service = transcription_service
        self._output_service = output_service
        self._progress_tracking_service = progress_tracking_service
        self._logger_service = logger_service
        self._file_system_service = file_system_service
        self._serialization_service = serialization_service
        self._is_transcribing = False
        self._current_file_index = 0
        self._total_files_count = 0

    def execute(self, request: BatchTranscribeRequest,
    ) -> BatchTranscribeResponse:
        """Execute the batch transcription use case.
        
        Args:
            request: The transcription request
            
        Returns:
            BatchTranscribeResponse with transcription results
        """
        import time
        start_time = time.time()

        try:
            # Phase 1: Initialize batch transcription
            self._logger_service.log_info(
                "Starting batch transcription",
                phase=TranscriptionPhase.INITIALIZING.value,
            )

            # Check if queue is empty
            if self._transcription_queue_service.is_empty():
                self._logger_service.log_info("Transcription queue is empty")

                if request.progress_callback:
                    request.progress_callback("Transcription complete!", 100.0)

                if request.completion_callback:
                    request.completion_callback(TranscriptionResult.QUEUE_EMPTY)

                return BatchTranscribeResponse(
                    result=TranscriptionResult.QUEUE_EMPTY,
                    total_files=0,
                    completed_files=0,
                    failed_files=0,
                    remaining_files=0,
                    file_statuses=[],
                    total_processing_time=time.time() - start_time,
                    error_message="No files in transcription queue",
                )

            # Initialize tracking variables
            self._total_files_count = self._transcription_queue_service.get_queue_size()
            self._current_file_index = 0
            self._is_transcribing = True

            completed_files = 0
            failed_files = 0
            file_statuses = []

            # Initialize progress tracking
            self._progress_tracking_service.initialize_batch_progress(self._total_files_count)
            self._progress_tracking_service.set_progress_visible(True)

            if request.progress_callback:
                request.progress_callback("Starting batch transcription...", 0.0)

            self._logger_service.log_info(
                "Processing batch transcription",
                phase=TranscriptionPhase.PROCESSING_NEXT_FILE.value,
                total_files=self._total_files_count,
            )

            # Phase 2: Process files in queue
            while not self._transcription_queue_service.is_empty():
                try:
                    # Get next file from queue
                    queue_item = self._transcription_queue_service.get_next_item()
                    if not queue_item:
                        break

                    self._current_file_index += 1

                    # Calculate progress
                    progress_percentage = self._progress_tracking_service.get_batch_progress_percentage(
                        self._current_file_index - 1, self._total_files_count,
                    )

                    # Determine file type and process accordingly
                    file_start_time = time.time()

                    if queue_item.file_type == FileType.VIDEO_FILE:
                        # Process video file
                        success, output_path, error_msg = self._process_video_file(
                            queue_item, request, progress_percentage,
                        )
                    elif queue_item.file_type == FileType.MEMORY_AUDIO:
                        # Process memory audio data
                        success, output_path, error_msg = self._process_memory_audio(
                            queue_item, request, progress_percentage,
                        )
                    else:
                        # Process regular audio file
                        success, output_path, error_msg = self._process_audio_file(
                            queue_item, request, progress_percentage,
                        )

                    file_processing_time = time.time() - file_start_time

                    # Update statistics and status
                    if success:
                        completed_files += 1
                        status = "completed"
                        if request.file_completion_callback:
                            request.file_completion_callback(queue_item.file_path, True)
                    else:
                        failed_files += 1
                        status = "failed"
                        if request.file_completion_callback:
                            request.file_completion_callback(queue_item.file_path, False)

                    file_statuses.append(FileTranscriptionStatus(
                        file_path=queue_item.file_path,
                        file_type=queue_item.file_type,
                        status=status,
                        progress=100.0,
                        output_path=output_path,
                        error_message=error_msg,
                        transcription_time=file_processing_time,
                        retry_count=queue_item.retry_count,
                    ))

                except Exception as e:
                    failed_files += 1
                    error_message = f"Error processing file: {e!s}"

                    self._logger_service.log_error(
                        "Error in batch transcription",
                        error=error_message,
                        file_index=self._current_file_index,
                    )

                    file_statuses.append(FileTranscriptionStatus(
                        file_path="unknown",
                        file_type=FileType.UNKNOWN,
                        status="error",
                        error_message=error_message,
                    ))

            # Phase 3: Complete batch transcription
            self._is_transcribing = False
            total_processing_time = time.time() - start_time
            remaining_files = self._transcription_queue_service.get_queue_size()

            # Calculate average time per file
            average_time_per_file = None
            if completed_files > 0:
                average_time_per_file = total_processing_time / completed_files

            # Determine result
            if completed_files == self._total_files_count:
                result = TranscriptionResult.SUCCESS
            elif completed_files > 0:
                result = TranscriptionResult.PARTIAL_SUCCESS
            else:
                result = TranscriptionResult.FAILURE

            # Hide progress bar
            self._progress_tracking_service.set_progress_visible(False)

            # Final progress update
            if request.progress_callback:
                if result == TranscriptionResult.SUCCESS:
                    request.progress_callback("All transcriptions completed!", 100.0)
                elif result == TranscriptionResult.PARTIAL_SUCCESS:
                    request.progress_callback(f"Batch completed with {failed_files} failures", 100.0)
                else:
                    request.progress_callback("Batch transcription failed", 100.0)

            if request.completion_callback:
                request.completion_callback(result)

            self._logger_service.log_info(
                "Batch transcription completed",
                phase=TranscriptionPhase.COMPLETING.value,
                result=result.value,
                completed_files=completed_files,
                failed_files=failed_files,
                total_processing_time=total_processing_time,
            )

            return BatchTranscribeResponse(
                result=result,
                total_files=self._total_files_count,
                completed_files=completed_files,
                failed_files=failed_files,
                remaining_files=remaining_files,
                file_statuses=file_statuses,
                total_processing_time=total_processing_time,
                average_time_per_file=average_time_per_file,
            )

        except Exception as e:
            error_message = f"Error in batch transcription: {e!s}"

            self._logger_service.log_error(
                "Batch transcription failed",
                phase=TranscriptionPhase.ERROR_HANDLING.value,
                error=str(e),
            )

            if request.error_callback:
                request.error_callback(error_message)

            self._is_transcribing = False
            self._progress_tracking_service.set_progress_visible(False)

            return BatchTranscribeResponse(
                result=TranscriptionResult.FAILURE,
                total_files=self._total_files_count,
                completed_files=0,
                failed_files=self._total_files_count,
                remaining_files=self._transcription_queue_service.get_queue_size(),
                file_statuses=[],
                total_processing_time=time.time() - start_time,
                error_message=error_message,
            )

    def _process_video_file(
        self,
        queue_item: QueueItem,
        request: BatchTranscribeRequest,
        progress_percentage: float,
    ) -> tuple[bool, str | None, str | None]:
        """Process a video file.

        Args:
            queue_item: Queue item containing video file
            request: Transcription request
            progress_percentage: Current progress percentage

        Returns:
            Tuple of (success, output_path, error_message)
        """
        try:
            video_path = queue_item.file_path
            base_name = self._file_system_service.get_basename(video_path)

            # Update progress
            file_count_text = f" ({self._current_file_index}/{self._total_files_count})"
            message = f"Converting video: {base_name}{file_count_text}"

            if request.progress_callback:
                request.progress_callback(message, progress_percentage)

            self._progress_tracking_service.update_file_progress(
                self._current_file_index, self._total_files_count, message,
            )

            # Convert video to audio
            audio_data = self._video_conversion_service.convert_video_to_audio(video_path)

            if not audio_data:
                error_message = f"Failed to convert video: {base_name}"
                self._logger_service.log_error("Video conversion failed", video_path=video_path)
                return False, None, error_message

            # Transcribe the converted audio
            return self._transcribe_audio_data(audio_data, request, file_count_text)

        except Exception as e:
            error_message = f"Error processing video file: {e!s}"
            self._logger_service.log_error("Video processing error", error=str(e))
            return False, None, error_message

    def _process_memory_audio(
        self,
        queue_item: QueueItem,
        request: BatchTranscribeRequest,
        progress_percentage: float,
    ) -> tuple[bool, str | None, str | None]:
        """Process memory audio data.

        Args:
            queue_item: Queue item containing memory audio
            request: Transcription request
            progress_percentage: Current progress percentage

        Returns:
            Tuple of (success, output_path, error_message)
        """
        try:
            # Get audio data from the payload
            if queue_item.audio_data_payload is None:
                # Fallback: try to deserialize from file_path (legacy support)
                try:
                    data_dict_result = self._serialization_service.deserialize_json_to_dict(queue_item.file_path)
                    if not data_dict_result.is_success:
                        return False, None, f"Failed to deserialize audio data: {data_dict_result.error}"
                    if data_dict_result.value is None:
                        return False, None, "Failed to deserialize audio data: no data"
                    audio_payload = AudioDataPayload.from_dict(data_dict_result.value)
                except (Exception, KeyError) as e:
                    return False, None, f"Invalid audio data format: {e!s}"
            else:
                audio_payload = queue_item.audio_data_payload

            # Convert to tuple format expected by _transcribe_audio_data
            audio_data = (
                audio_payload.audio_type,
                audio_payload.audio_bytes,
                audio_payload.output_path,
            )

            file_count_text = f" ({self._current_file_index}/{self._total_files_count})"

            return self._transcribe_audio_data(audio_data, request, file_count_text)

        except Exception as e:
            error_message = f"Error processing memory audio: {e!s}"
            self._logger_service.log_error("Memory audio processing error", error=str(e))
            return False, None, error_message

    def _process_audio_file(
        self,
        queue_item: QueueItem,
        request: BatchTranscribeRequest,
        progress_percentage: float,
    ) -> tuple[bool, str | None, str | None]:
        """Process an audio file.

        Args:
            queue_item: Queue item containing audio file
            request: Transcription request
            progress_percentage: Current progress percentage

        Returns:
            Tuple of (success, output_path, error_message)
        """
        try:
            file_path = queue_item.file_path
            base_name = self._file_system_service.get_basename(file_path)

            # Update progress
            file_count_text = f" ({self._current_file_index}/{self._total_files_count})"
            message = f"Transcribing: {base_name}{file_count_text}"

            if request.progress_callback:
                request.progress_callback(message, progress_percentage)

            self._progress_tracking_service.update_file_progress(
                self._current_file_index, self._total_files_count, message,
            )

            # Transcribe the file
            transcript = self._transcription_service.transcribe_file(file_path)

            if not transcript:
                error_message = f"Transcription failed for: {base_name}{file_count_text}"
                self._logger_service.log_error("Transcription failed", file_path=file_path)
                return False, None, error_message

            # Save transcription
            split_result = self._file_system_service.split_extension(file_path)
            if not split_result.is_success:
                error_message = f"Failed to split file extension: {split_result.error}"
                return False, None, error_message
            if split_result.value is None:
                error_message = "Failed to split file extension: no result"
                return False, None, error_message
            output_path = split_result.value[0]
            success = self._output_service.save_transcription(
                transcript, output_path, request.configuration.output_format,
            )

            if success:
                extension = request.configuration.output_format.value
                success_message = f"Saved transcript to: {self._file_system_service.get_basename(output_path)}.{extension}{file_count_text}"

                if request.progress_callback:
                    request.progress_callback(success_message, progress_percentage + 10)

                self._logger_service.log_info(
                    "File transcription completed",
                    file_path=file_path,
                    output_path=f"{output_path}.{extension}",
                )

                return True, f"{output_path}.{extension}", None
            error_message = f"Failed to save transcription for: {base_name}"
            return False, None, error_message

        except Exception as e:
            error_message = f"Error transcribing file: {e!s}"
            self._logger_service.log_error("File transcription error", error=str(e))
            return False, None, error_message

    def _transcribe_audio_data(
        self,
        audio_data: tuple[str, bytes, str],
        request: BatchTranscribeRequest,
        file_count_text: str,
    ) -> tuple[bool, str | None, str | None]:
        """Transcribe audio data in memory.

        Args:
            audio_data: Tuple of (type, audio_bytes, output_path)
            request: Transcription request
            file_count_text: File count text for display

        Returns:
            Tuple of (success, output_path, error_message)
        """
        try:
            data_type, audio_bytes, output_base_path = audio_data
            filename = self._file_system_service.get_basename(output_base_path)

            # Transcribe the audio data
            transcript = self._transcription_service.transcribe_audio_data(audio_data)

            if not transcript:
                error_message = f"Transcription failed for: {filename}{file_count_text}"
                return False, None, error_message

            # Save transcription
            success = self._output_service.save_transcription(
                transcript, output_base_path, request.configuration.output_format,
            )

            if success:
                extension = request.configuration.output_format.value
                success_message = f"Saved transcript to: {self._file_system_service.get_basename(output_base_path)}.{extension}{file_count_text}"
    

                if request.progress_callback:
                    request.progress_callback(success_message, 90.0)

                self._logger_service.log_info(
                    "Audio data transcription completed",
                    output_path=f"{output_base_path}.{extension}",
                )

                return True, f"{output_base_path}.{extension}", None
            error_message = f"Failed to save transcription for: {filename}"
            return False, None, error_message

        except Exception as e:
            error_message = f"Error transcribing audio data: {e!s}"
            self._logger_service.log_error("Audio data transcription error", error=str(e))
            return False, None, error_message

    def is_transcribing(self) -> bool:
        """Check if batch transcription is in progress.

        Returns:
            True if transcription is in progress
        """
        return self._is_transcribing

    def get_current_progress(self) -> tuple[int, int]:
        """Get current transcription progress.

        Returns:
            Tuple of (current_file_index, total_files_count)
        """
        return self._current_file_index, self._total_files_count