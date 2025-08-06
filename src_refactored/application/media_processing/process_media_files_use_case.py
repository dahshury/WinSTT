"""Process Media Files Use Case.

This module implements the ProcessMediaFilesUseCase for handling media file processing
workflows with progress tracking and error handling.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

from src_refactored.domain.media.value_objects.processing_operations import (
    MediaType,
    ProcessingPhase,
    ProcessingResult,
    ProcessingStrategy,
)

if TYPE_CHECKING:
    from collections.abc import Callable


@dataclass
class MediaFileInfo:
    """Information about a media file."""
    file_path: str
    media_type: MediaType
    file_size: int | None = None
    duration: float | None = None
    format: str | None = None
    is_valid: bool = True
    error_message: str | None = None


@dataclass
class ProcessingConfiguration:
    """Configuration for media processing."""
    strategy: ProcessingStrategy = ProcessingStrategy.SEQUENTIAL
    max_parallel_files: int = 3
    convert_videos: bool = True
    validate_files: bool = True
    create_backup: bool = False
    output_format: str = "srt"
    progress_callback_interval: float = 0.1
    timeout_seconds: float | None = None


@dataclass
class ProcessMediaFilesRequest:
    """Request for processing media files."""
    media_files: list[str]
    configuration: ProcessingConfiguration
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[ProcessingResult], None] | None = None
    error_callback: Callable[[str], None] | None = None


@dataclass
class FileProcessingStatus:
    """Status of individual file processing."""
    file_path: str
    media_type: MediaType
    status: str
    progress: float = 0.0
    error_message: str | None = None
    queue_position: int | None = None
    estimated_time: float | None = None


@dataclass
class ProcessMediaFilesResponse:
    """Response from processing media files."""
    result: ProcessingResult
    total_files: int
    processed_files: int
    failed_files: int
    queue_size: int
    file_statuses: list[FileProcessingStatus]
    processing_time: float
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class FileValidationServiceProtocol(Protocol,
    ):
    """Protocol for file validation service."""

    def validate_file(self, file_path: str,
    ) -> tuple[bool, str | None]:
        """Validate a media file.
        
        Args:
            file_path: Path to the file to validate
            
        Returns:
            Tuple of (is_valid, error_message)
        """
        ...

    def get_media_type(self, file_path: str,
    ) -> MediaType:
        """Get the media type of a file.
        
        Args:
            file_path: Path to the file
            
        Returns:
            MediaType of the file
        """
        ...

    def get_file_info(self, file_path: str,
    ) -> MediaFileInfo:
        """Get detailed information about a media file.
        
        Args:
            file_path: Path to the file
            
        Returns:
            MediaFileInfo with file details
        """
        ...


class TranscriptionQueueServiceProtocol(Protocol):
    """Protocol for transcription queue service."""

    def add_to_queue(self, file_path: str, media_type: MediaType,
    ) -> bool:
        """Add a file to the transcription queue.
        
        Args:
            file_path: Path to the file
            media_type: Type of media
            
        Returns:
            True if successfully added
        """
        ...

    def add_video_to_queue(self, video_path: str,
    ) -> bool:
        """Add a video file to the queue for conversion.
        
        Args:
            video_path: Path to the video file
            
        Returns:
            True if successfully added
        """
        ...

    def get_queue_size(self) -> int:
        """Get the current queue size.
        
        Returns:
            Number of items in queue
        """
        ...

    def clear_queue(self) -> None:
        """Clear the transcription queue."""
        ...


class VideoConversionServiceProtocol(Protocol):
    """Protocol for video conversion service."""

    def convert_video(self, video_path: str,
    ) -> tuple[str, bytes, str] | None:
        """Convert a video file to audio.
        
        Args:
            video_path: Path to the video file
            
        Returns:
            Tuple of (type, audio_bytes, output_path) or None if failed
        """
        ...

    def is_conversion_supported(self, video_path: str,
    ) -> bool:
        """Check if video conversion is supported.
        
        Args:
            video_path: Path to the video file
            
        Returns:
            True if conversion is supported
        """
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking service."""

    def initialize_progress(self, total_files: int,
    ) -> None:
        """Initialize progress tracking.
        
        Args:
            total_files: Total number of files to process
        """
        ...

    def update_progress(self, current_file: int, message: str,
    ) -> None:
        """Update progress.
        
        Args:
            current_file: Current file index
            message: Progress message
        """
        ...

    def get_progress_percentage(self, current_file: int, total_files: int,
    ) -> float:
        """Get progress percentage.
        
        Args:
            current_file: Current file index
            total_files: Total number of files
            
        Returns:
            Progress percentage (0-100)
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


class ProcessMediaFilesUseCase:
    """Use case for processing media files with progress tracking."""

    def __init__(
        self,
        file_validation_service: FileValidationServiceProtocol,
        transcription_queue_service: TranscriptionQueueServiceProtocol,
        video_conversion_service: VideoConversionServiceProtocol,
        progress_tracking_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        """Initialize the use case.
        
        Args:
            file_validation_service: Service for file validation
            transcription_queue_service: Service for queue management
            video_conversion_service: Service for video conversion
            progress_tracking_service: Service for progress tracking
            logger_service: Service for logging
        """
        self._file_validation_service = file_validation_service
        self._transcription_queue_service = transcription_queue_service
        self._video_conversion_service = video_conversion_service
        self._progress_tracking_service = progress_tracking_service
        self._logger_service = logger_service

    def execute(self, request: ProcessMediaFilesRequest,
    ) -> ProcessMediaFilesResponse:
        """Execute the media files processing use case.
        
        Args:
            request: The processing request
            
        Returns:
            ProcessMediaFilesResponse with processing results
        """
        import time
        start_time = time.time()

        try:
            # Phase 1: Initialize processing
            self._logger_service.log_info(
                "Starting media files processing",
                phase=ProcessingPhase.INITIALIZING.value,
                file_count=len(request.media_files),
            )

            if not request.media_files:
                return ProcessMediaFilesResponse(
                    result=ProcessingResult.NO_FILES,
                    total_files=0,
                    processed_files=0,
                    failed_files=0,
                    queue_size=0,
                    file_statuses=[],
                    processing_time=time.time() - start_time,
                    error_message="No files provided for processing",
                )

            # Phase 2: Validate files
            self._logger_service.log_info(
                "Validating media files",
                phase=ProcessingPhase.VALIDATING_FILES.value,
            )

            file_infos = []
            valid_files = []

            for file_path in request.media_files:
                if request.configuration.validate_files:
                    file_info = self._file_validation_service.get_file_info(file_path)
                    file_infos.append(file_info)
                    if file_info.is_valid:
                        valid_files.append(file_path,
    )
                else:
                    # Skip validation, assume all files are valid
                    media_type = self._file_validation_service.get_media_type(file_path)
                    file_info = MediaFileInfo(
                        file_path=file_path,
                        media_type=media_type,
                        is_valid=True,
                    )
                    file_infos.append(file_info)
                    valid_files.append(file_path)

            if not valid_files:
                return ProcessMediaFilesResponse(
                    result=ProcessingResult.FAILURE,
                    total_files=len(request.media_files),
                    processed_files=0,
                    failed_files=len(request.media_files),
                    queue_size=0,
                    file_statuses=[
                        FileProcessingStatus(
                            file_path=info.file_path,
                            media_type=info.media_type,
                            status="invalid",
                            error_message=info.error_message,
                        ) for info in file_infos if not info.is_valid
                    ],
                    processing_time=time.time() - start_time,
                    error_message="No valid files to process",
                )

            # Phase 3: Initialize progress tracking
            self._progress_tracking_service.initialize_progress(len(valid_files))

            if request.progress_callback:
                request.progress_callback("Initializing processing...", 0.0)

            # Phase 4: Process files and add to queue
            self._logger_service.log_info(
                "Processing files and adding to queue",
                phase=ProcessingPhase.PROCESSING_FILES.value,
                valid_files=len(valid_files),
            )

            processed_files = 0
            failed_files = 0
            file_statuses = []

            for i, file_path in enumerate(valid_files):
                try:
                    file_info = next(info for info in file_infos if info.file_path == file_path)

                    # Update progress
                    progress = self._progress_tracking_service.get_progress_percentage(i, len(valid_files))
                    message = f"Processing: {os.path.basename(file_path)}"

                    if request.progress_callback:
                        request.progress_callback(message, progress)

                    self._progress_tracking_service.update_progress(i + 1, message)

                    # Process based on media type
                    if file_info.media_type == MediaType.AUDIO:
                        # Add audio file directly to queue
                        success = self._transcription_queue_service.add_to_queue(
                            file_path, MediaType.AUDIO,
                        )

                        if success:
                            processed_files += 1
                            file_statuses.append(FileProcessingStatus(
                                file_path=file_path,
                                media_type=MediaType.AUDIO,
                                status="queued",
                                progress=100.0,
                                queue_position=self._transcription_queue_service.get_queue_size(),
                            ))

                            self._logger_service.log_info(
                                "Added audio file to queue",
                                file_path=file_path,
                            )
                        else:
                            failed_files += 1
                            file_statuses.append(FileProcessingStatus(
                                file_path=file_path,
                                media_type=MediaType.AUDIO,
                                status="failed",
                                error_message="Failed to add to queue",
                            ))

                    elif file_info.media_type == MediaType.VIDEO:
                        if request.configuration.convert_videos:
                            # Add video file to queue for conversion
                            success = self._transcription_queue_service.add_video_to_queue(file_path)

                            if success:
                                processed_files += 1
                                file_statuses.append(FileProcessingStatus(
                                    file_path=file_path,
                                    media_type=MediaType.VIDEO,
                                    status="queued_for_conversion",
                                    progress=100.0,
                                    queue_position=self._transcription_queue_service.get_queue_size(),
                                ))

                                self._logger_service.log_info(
                                    "Added video file to queue for conversion",
                                    file_path=file_path,
                                )
                            else:
                                failed_files += 1
                                file_statuses.append(FileProcessingStatus(
                                    file_path=file_path,
                                    media_type=MediaType.VIDEO,
                                    status="failed",
                                    error_message="Failed to add to queue",
                                ))
                        else:
                            # Skip video files if conversion is disabled
                            failed_files += 1
                            file_statuses.append(FileProcessingStatus(
                                file_path=file_path,
                                media_type=MediaType.VIDEO,
                                status="skipped",
                                error_message="Video conversion disabled",
                            ))

                            self._logger_service.log_warning(
                                "Skipped video file (conversion disabled)",
                                file_path=file_path,
                            )

                    else:
                        # Unknown media type
                        failed_files += 1
                        file_statuses.append(FileProcessingStatus(
                            file_path=file_path,
                            media_type=MediaType.UNKNOWN,
                            status="failed",
                            error_message="Unknown media type",
                        ))

                        self._logger_service.log_warning(
                            "Unknown media type",
                            file_path=file_path,
                        )

                except Exception as e:
                    failed_files += 1
                    file_statuses.append(FileProcessingStatus(
                        file_path=file_path,
                        media_type=MediaType.UNKNOWN,
                        status="error",
                        error_message=str(e),
                    ))

                    self._logger_service.log_error(
                        "Error processing file",
                        file_path=file_path,
                        error=str(e),
                    )

            # Phase 5: Complete processing
            processing_time = time.time() - start_time
            queue_size = self._transcription_queue_service.get_queue_size()

            # Determine result
            if processed_files == len(valid_files):
                result = ProcessingResult.SUCCESS
            elif processed_files > 0:
                result = ProcessingResult.PARTIAL_SUCCESS
            else:
                result = ProcessingResult.FAILURE

            # Final progress update
            if request.progress_callback:
                request.progress_callback("Processing complete", 100.0)

            if request.completion_callback:
                request.completion_callback(result)

            self._logger_service.log_info(
                "Media files processing completed",
                phase=ProcessingPhase.COMPLETING.value,
                result=result.value,
                processed_files=processed_files,
                failed_files=failed_files,
                processing_time=processing_time,
            )

            return ProcessMediaFilesResponse(
                result=result,
                total_files=len(request.media_files),
                processed_files=processed_files,
                failed_files=failed_files,
                queue_size=queue_size,
                file_statuses=file_statuses,
                processing_time=processing_time,
            )

        except Exception as e:
            error_message = f"Error in media files processing: {e!s}"

            self._logger_service.log_error(
                "Media files processing failed",
                phase=ProcessingPhase.ERROR_HANDLING.value,
                error=str(e),
            )

            if request.error_callback:
                request.error_callback(error_message)

            return ProcessMediaFilesResponse(
                result=ProcessingResult.FAILURE,
                total_files=len(request.media_files) if request.media_files else 0,
                processed_files=0,
                failed_files=len(request.media_files) if request.media_files else 0,
                queue_size=0,
                file_statuses=[],
                processing_time=time.time() - start_time,
                error_message=error_message,
            )