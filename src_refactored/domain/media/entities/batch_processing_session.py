"""Batch processing session entity for handling multiple media files."""

import os
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

from src_refactored.domain.common.entity import Entity
from src_refactored.domain.media.value_objects import ConversionQuality, MediaDuration

from .conversion_job import ConversionJob, ConversionStatus
from .media_file import MediaFile


class SessionStatus(Enum):
    """Status of a batch processing session."""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    PAUSED = "paused"


@dataclass
class BatchProcessingSession(Entity):
    """Entity representing a batch processing session for multiple media files."""

    name: str
    media_files: list[MediaFile] = field(default_factory=list)
    conversion_jobs: list[ConversionJob] = field(default_factory=list)
    transcription_queue: list[str] = field(default_factory=list)  # File paths or job IDs
    status: SessionStatus = SessionStatus.PENDING
    current_file_index: int = 0
    total_files_count: int = 0
    started_at: datetime | None = None
    completed_at: datetime | None = None
    paused_at: datetime | None = None
    error_message: str | None = None
    progress_callback: Callable[[float, str], None] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        """Initialize the batch processing session."""
        super().__post_init__()
        self.total_files_count = len(self.media_files)

    @classmethod
    def create_from_file_paths(cls, name: str, file_paths: list[str]) -> "BatchProcessingSession":
        """Create a session from a list of file paths."""
        media_files = []

        for file_path in file_paths:
            try:
                media_file = MediaFile.from_file_path(file_path)
                if media_file.is_supported():
                    media_files.append(media_file,
    )
            except (ValueError, OSError):
                # Skip invalid files but could log the error
                continue

        return cls(
            name=name,
            media_files=media_files,
            total_files_count=len(media_files),
        )

    @classmethod
    def create_from_folder(cls, name: str, folder_path: str, recursive: bool = True,
    ) -> "BatchProcessingSession":
        """Create a session by scanning a folder for media files."""
        file_paths = []

        if recursive:
            for root, _, files in os.walk(folder_path):
                for file in files:
                    file_path = os.path.join(root, file)
                    file_paths.append(file_path)
        else:
            for file in os.listdir(folder_path):
                file_path = os.path.join(folder_path, file)
                if os.path.isfile(file_path):
                    file_paths.append(file_path)

        return cls.create_from_file_paths(name, file_paths)

    def add_media_file(self, media_file: MediaFile,
    ) -> None:
        """Add a media file to the session."""
        if self.status != SessionStatus.PENDING:
            msg = f"Cannot add files to session in status: {self.status}"
            raise ValueError(msg)

        if media_file.is_supported():
            self.media_files.append(media_file)
            self.total_files_count = len(self.media_files,
    )

    def add_media_files(self, media_files: list[MediaFile]) -> None:
        """Add multiple media files to the session."""
        for media_file in media_files:
            self.add_media_file(media_file)

    def remove_media_file(self, media_file: MediaFile,
    ) -> None:
        """Remove a media file from the session."""
        if self.status != SessionStatus.PENDING:
            msg = f"Cannot remove files from session in status: {self.status}"
            raise ValueError(msg)

        if media_file in self.media_files:
            self.media_files.remove(media_file)
            self.total_files_count = len(self.media_files,
    )

    def prepare_processing_queue(self, conversion_quality: ConversionQuality | None = None) -> None:
        """Prepare the processing queue with conversion jobs and direct transcription files."""
        if not conversion_quality:
            conversion_quality = ConversionQuality.create_default()

        self.transcription_queue.clear()
        self.conversion_jobs.clear()

        for media_file in self.media_files:
            if media_file.can_be_transcribed_directly():
                # Add audio files directly to transcription queue
                self.transcription_queue.append(media_file.file_path)
            elif media_file.requires_conversion(
    ):
                # Create conversion job for video files
                conversion_job = ConversionJob.create_with_quality(media_file, conversion_quality)
                self.conversion_jobs.append(conversion_job)
                self.transcription_queue.append(f"conversion_job:{conversion_job.id}")

    def start(self, progress_callback: Callable[[float, str], None] | None = None) -> None:
        """Start the batch processing session."""
        if self.status != SessionStatus.PENDING:
            msg = f"Cannot start session in status: {self.status}"
            raise ValueError(msg)

        if not self.media_files:
            msg = "No media files to process"
            raise ValueError(msg)

        self.status = SessionStatus.IN_PROGRESS
        self.started_at = datetime.now()
        self.current_file_index = 0
        self.progress_callback = progress_callback

        # Prepare processing queue if not already done
        if not self.transcription_queue:
            self.prepare_processing_queue()

    def pause(self) -> None:
        """Pause the processing session."""
        if self.status != SessionStatus.IN_PROGRESS:
            msg = f"Cannot pause session in status: {self.status}"
            raise ValueError(msg)

        self.status = SessionStatus.PAUSED
        self.paused_at = datetime.now()

    def resume(self) -> None:
        """Resume the processing session."""
        if self.status != SessionStatus.PAUSED:
            msg = f"Cannot resume session in status: {self.status}"
            raise ValueError(msg)

        self.status = SessionStatus.IN_PROGRESS
        self.paused_at = None

    def complete(self,
    ) -> None:
        """Mark the session as completed."""
        if self.status not in [SessionStatus.IN_PROGRESS, SessionStatus.PAUSED]:
            msg = f"Cannot complete session in status: {self.status}"
            raise ValueError(msg)

        self.status = SessionStatus.COMPLETED
        self.completed_at = datetime.now()
        self.current_file_index = self.total_files_count

        if self.progress_callback:
            self.progress_callback(100.0, "Processing completed")

    def fail(self, error_message: str,
    ) -> None:
        """Mark the session as failed."""
        if self.status not in [SessionStatus.IN_PROGRESS, SessionStatus.PAUSED]:
            msg = f"Cannot fail session in status: {self.status}"
            raise ValueError(msg)

        self.status = SessionStatus.FAILED
        self.completed_at = datetime.now()
        self.error_message = error_message

        if self.progress_callback:
            self.progress_callback(self.get_progress_percentage(), f"Failed: {error_message}")

    def cancel(self) -> None:
        """Cancel the processing session."""
        if self.status not in [SessionStatus.PENDING, SessionStatus.IN_PROGRESS, SessionStatus.PAUSED]:
            msg = f"Cannot cancel session in status: {self.status}"
            raise ValueError(msg)

        # Cancel any in-progress conversion jobs
        for job in self.conversion_jobs:
            if job.is_in_progress():
                job.cancel()

        self.status = SessionStatus.CANCELLED
        self.completed_at = datetime.now()

        if self.progress_callback:
            self.progress_callback(self.get_progress_percentage(), "Processing cancelled")

    def advance_to_next_file(self) -> None:
        """Advance to the next file in the processing queue."""
        if self.status != SessionStatus.IN_PROGRESS:
            return

        self.current_file_index += 1

        # Update progress
        progress = self.get_progress_percentage()
        current_file = self.get_current_file()
        message = f"Processing: {current_file.get_filename()}" if current_file else "Processing..."

        if self.progress_callback:
            self.progress_callback(progress, message)

        # Check if all files are processed
        if self.current_file_index >= self.total_files_count:
            self.complete()

    def get_current_file(self) -> MediaFile | None:
        """Get the currently processing file."""
        if 0 <= self.current_file_index < len(self.media_files):
            return self.media_files[self.current_file_index]
        return None

    def get_next_queue_item(self) -> str | None:
        """Get the next item from the transcription queue."""
        if self.transcription_queue:
            return self.transcription_queue.pop(0)
        return None

    def get_progress_percentage(self) -> float:
        """Get the current progress percentage."""
        if self.total_files_count == 0:
            return 0.0

        return min(100.0, (self.current_file_index / self.total_files_count) * 100)

    def get_remaining_files_count(self) -> int:
        """Get the number of remaining files to process."""
        return max(0, self.total_files_count - self.current_file_index)

    def get_processed_files_count(self) -> int:
        """Get the number of processed files."""
        return min(self.current_file_index, self.total_files_count)

    def get_audio_files(self) -> list[MediaFile]:
        """Get all audio files in the session."""
        return [f for f in self.media_files if f.is_audio()]

    def get_video_files(self) -> list[MediaFile]:
        """Get all video files in the session."""
        return [f for f in self.media_files if f.is_video()]

    def get_conversion_jobs_by_status(self, status: ConversionStatus,
    ) -> list[ConversionJob]:
        """Get conversion jobs by status."""
        return [job for job in self.conversion_jobs if job.status == status]

    def get_pending_conversion_jobs(self) -> list[ConversionJob]:
        """Get pending conversion jobs."""
        return self.get_conversion_jobs_by_status(ConversionStatus.PENDING)

    def get_completed_conversion_jobs(self) -> list[ConversionJob]:
        """Get completed conversion jobs."""
        return self.get_conversion_jobs_by_status(ConversionStatus.COMPLETED)

    def get_failed_conversion_jobs(self) -> list[ConversionJob]:
        """Get failed conversion jobs."""
        return self.get_conversion_jobs_by_status(ConversionStatus.FAILED)

    def estimate_total_processing_time(self) -> MediaDuration:
        """Estimate total processing time for all files."""
        total_seconds = 0.0

        for media_file in self.media_files:
            total_seconds += media_file.estimate_processing_time()

        return MediaDuration.from_seconds(total_seconds)

    def estimate_remaining_processing_time(self) -> MediaDuration:
        """Estimate remaining processing time."""
        remaining_seconds = 0.0

        for i in range(self.current_file_index, len(self.media_files)):
            remaining_seconds += self.media_files[i].estimate_processing_time()

        return MediaDuration.from_seconds(remaining_seconds)

    def get_session_duration(self) -> MediaDuration | None:
        """Get the total duration of the session so far."""
        if not self.started_at:
            return None

        end_time = self.completed_at or datetime.now()
        duration_seconds = (end_time - self.started_at).total_seconds()
        return MediaDuration.from_seconds(duration_seconds)

    def is_empty(self) -> bool:
        """Check if session has no files."""
        return len(self.media_files) == 0

    def has_video_files(self) -> bool:
        """Check if session contains video files."""
        return any(f.is_video() for f in self.media_files)

    def has_audio_files(self) -> bool:
        """Check if session contains audio files."""
        return any(f.is_audio() for f in self.media_files)

    def add_metadata(self, key: str, value: Any,
    ) -> None:
        """Add metadata to the session."""
        self.metadata[key] = value

    def get_metadata(self, key: str, default: Any = None,
    ) -> Any:
        """Get metadata value."""
        return self.metadata.get(key, default)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary representation."""
        return {
            "id": str(self.id),
            "name": self.name,
            "status": self.status.value,
            "current_file_index": self.current_file_index,
            "total_files_count": self.total_files_count,
            "progress_percentage": self.get_progress_percentage(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "paused_at": self.paused_at.isoformat() if self.paused_at else None,
            "error_message": self.error_message,
            "media_files": [f.to_dict() for f in self.media_files],
            "conversion_jobs": [j.to_dict() for j in self.conversion_jobs],
            "session_duration": self.get_session_duration().to_seconds() if self.get_session_duration() else None,
            "estimated_remaining_time": self.estimate_remaining_processing_time().to_seconds(),
            "metadata": self.metadata,
        }