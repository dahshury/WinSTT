"""Conversion job entity for media file conversion."""

from datetime import datetime
from enum import Enum
from typing import Any

from src_refactored.domain.common.domain_utils import DomainIdentityGenerator
from src_refactored.domain.common.entity import Entity
from src_refactored.domain.common.ports.file_system_port import FileSystemPort
from src_refactored.domain.media.value_objects import ConversionQuality, MediaDuration

from .media_file import MediaFile


class ConversionStatus(Enum):
    """Status of a conversion job."""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ConversionJob(Entity):
    """Entity representing a media file conversion job."""

    def __init__(self, entity_id: str, source_file: MediaFile, target_quality: ConversionQuality, 
                 file_system_port: FileSystemPort, **kwargs: Any) -> None:
        """Initialize the conversion job."""
        super().__init__(entity_id)
        
        self.source_file = source_file
        self.target_quality = target_quality
        self.file_system_port = file_system_port
        self.status: ConversionStatus = kwargs.get("status", ConversionStatus.PENDING)
        self.progress_percentage: float = float(kwargs.get("progress_percentage", 0.0))
        self.started_at: float | None = kwargs.get("started_at")
        self.completed_at: float | None = kwargs.get("completed_at")
        self.error_message: str | None = kwargs.get("error_message")
        self.output_data: bytes | None = kwargs.get("output_data")
        self.output_file_path: str | None = kwargs.get("output_file_path")
        self.estimated_duration: MediaDuration | None = kwargs.get("estimated_duration")
        self.actual_duration: MediaDuration | None = kwargs.get("actual_duration")
        self.metadata: dict[str, Any] = kwargs.get("metadata", {})

        # Validate that source file requires conversion
        if not self.source_file.requires_conversion():
            msg = "Source file does not require conversion"
            raise ValueError(msg)

    @classmethod
    def create_for_transcription(cls, entity_id: str, source_file: MediaFile, file_system_port: FileSystemPort,
    ) -> "ConversionJob":
        """Create a conversion job optimized for transcription."""
        quality = ConversionQuality.create_default()
        return cls(
            entity_id=entity_id,
            source_file=source_file,
            target_quality=quality,
            file_system_port=file_system_port,
        )

    @classmethod
    def create_with_quality(cls, entity_id: str, source_file: MediaFile, quality: ConversionQuality, file_system_port: FileSystemPort,
    ) -> "ConversionJob":
        """Create a conversion job with specific quality settings."""
        return cls(
            entity_id=entity_id,
            source_file=source_file,
            target_quality=quality,
            file_system_port=file_system_port,
        )

    def start(self) -> None:
        """Mark the job as started."""
        if self.status != ConversionStatus.PENDING:
            msg = f"Cannot start job in status: {self.status}"
            raise ValueError(msg)

        self.status = ConversionStatus.IN_PROGRESS
        self.started_at = DomainIdentityGenerator.generate_timestamp()
        self.progress_percentage = 0.0

    def update_progress(self, percentage: float,
    ) -> None:
        """Update the conversion progress."""
        if self.status != ConversionStatus.IN_PROGRESS:
            msg = f"Cannot update progress for job in status: {self.status}"
            raise ValueError(msg)

        if not 0 <= percentage <= 100:
            msg = "Progress percentage must be between 0 and 100"
            raise ValueError(msg)

        self.progress_percentage = percentage

    def complete_with_data(self, output_data: bytes,
    ) -> None:
        """Mark the job as completed with in-memory output data."""
        if self.status != ConversionStatus.IN_PROGRESS:
            msg = f"Cannot complete job in status: {self.status}"
            raise ValueError(msg)

        self.status = ConversionStatus.COMPLETED
        self.completed_at = DomainIdentityGenerator.generate_timestamp()
        self.progress_percentage = 100.0
        self.output_data = output_data

        # Calculate actual duration
        if self.started_at and self.completed_at:
            duration_seconds = float(self.completed_at - self.started_at)
            self.actual_duration = MediaDuration.from_seconds(duration_seconds)

    def complete_with_file(self, output_file_path: str) -> None:
        """Mark the job as completed with file output."""
        if self.status != ConversionStatus.IN_PROGRESS:
            msg = f"Cannot complete job in status: {self.status}"
            raise ValueError(msg)

        # Check if output file exists through port
        exists_result = self.file_system_port.file_exists(output_file_path)
        if not exists_result.is_success or not exists_result.value:
            msg = f"Output file does not exist: {output_file_path}"
            raise ValueError(msg)

        self.status = ConversionStatus.COMPLETED
        self.completed_at = DomainIdentityGenerator.generate_timestamp()
        self.progress_percentage = 100.0
        self.output_file_path = output_file_path

        # Calculate actual duration
        if self.started_at and self.completed_at:
            duration_seconds = float(self.completed_at - self.started_at)
            self.actual_duration = MediaDuration.from_seconds(duration_seconds)

    def fail(self, error_message: str,
    ) -> None:
        """Mark the job as failed."""
        if self.status not in [ConversionStatus.PENDING, ConversionStatus.IN_PROGRESS]:
            msg = f"Cannot fail job in status: {self.status}"
            raise ValueError(msg)

        self.status = ConversionStatus.FAILED
        self.completed_at = DomainIdentityGenerator.generate_timestamp()
        self.error_message = error_message

        # Calculate actual duration if started
        if self.started_at and self.completed_at:
            duration_seconds = float(self.completed_at - self.started_at)
            self.actual_duration = MediaDuration.from_seconds(duration_seconds)

    def cancel(self,
    ) -> None:
        """Cancel the conversion job."""
        if self.status not in [ConversionStatus.PENDING, ConversionStatus.IN_PROGRESS]:
            msg = f"Cannot cancel job in status: {self.status}"
            raise ValueError(msg)

        self.status = ConversionStatus.CANCELLED
        self.completed_at = DomainIdentityGenerator.generate_timestamp()

        # Calculate actual duration if started
        if self.started_at and self.completed_at:
            duration_seconds = float(self.completed_at - self.started_at)
            self.actual_duration = MediaDuration.from_seconds(duration_seconds)

    def is_pending(self) -> bool:
        """Check if job is pending."""
        return bool(self.status == ConversionStatus.PENDING)

    def is_in_progress(self) -> bool:
        """Check if job is in progress."""
        return bool(self.status == ConversionStatus.IN_PROGRESS)

    def is_completed(self) -> bool:
        """Check if job is completed successfully."""
        return bool(self.status == ConversionStatus.COMPLETED)

    def is_failed(self) -> bool:
        """Check if job failed."""
        return bool(self.status == ConversionStatus.FAILED)

    def is_cancelled(self) -> bool:
        """Check if job was cancelled."""
        return bool(self.status == ConversionStatus.CANCELLED)

    def is_finished(self,
    ) -> bool:
        """Check if job is finished (completed, failed, or cancelled)."""
        return bool(self.status in [ConversionStatus.COMPLETED, ConversionStatus.FAILED, ConversionStatus.CANCELLED])

    def has_output_data(self) -> bool:
        """Check if job has in-memory output data."""
        return self.output_data is not None

    def has_output_file(self) -> bool:
        """Check if job has file output."""
        if self.output_file_path is None:
            return False
        
        # Check file existence through port
        exists_result = self.file_system_port.file_exists(self.output_file_path)
        return bool(exists_result.is_success and bool(exists_result.value))

    def get_output_size_mb(self) -> float | None:
        """Get output size in MB."""
        if self.output_data:
            return len(self.output_data) / (1024 * 1024)
        
        if self.output_file_path:
            # Check file exists and get size through port
            exists_result = self.file_system_port.file_exists(self.output_file_path)
            if exists_result.is_success and exists_result.value:
                size_result = self.file_system_port.get_file_size(self.output_file_path)
                if size_result.is_success and size_result.value is not None:
                    return float(size_result.value) / (1024 * 1024)
        
        return None

    def estimate_processing_time(self) -> MediaDuration:
        """Estimate total processing time for this job."""
        if self.source_file.duration:
            estimated_seconds = self.target_quality.estimate_processing_time(
                self.source_file.duration.to_seconds(),
            )
        else:
            # Fallback estimate based on file size
            estimated_seconds = self.source_file.get_file_size_mb() * 5  # 5 seconds per MB

        return MediaDuration.from_seconds(estimated_seconds)

    def get_estimated_output_size_mb(self) -> float:
        """Get estimated output file size in MB."""
        return self.source_file.estimate_conversion_output_size(self.target_quality)

    def get_conversion_ratio(self) -> float | None:
        """Get compression ratio (output_size / input_size)."""
        output_size = self.get_output_size_mb()
        if output_size is None:
            return None

        input_size = self.source_file.get_file_size_mb()
        if input_size == 0:
            return None

        return output_size / input_size

    def get_processing_speed_factor(self) -> float | None:
        """Get processing speed factor (duration / processing_time)."""
        if not self.actual_duration or not self.source_file.duration:
            return None

        processing_time = self.actual_duration.to_seconds()
        media_duration = self.source_file.duration.to_seconds()

        if processing_time == 0:
            return None

        return media_duration / processing_time

    def add_metadata(self, key: str, value: Any,
    ) -> None:
        """Add metadata to the job."""
        self.metadata[key] = value

    def get_metadata(self, key: str, default: Any = None,
    ) -> Any:
        """Get metadata value."""
        return self.metadata.get(key, default)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary representation."""
        return {
            "id": str(self.id),
            "source_file_id": str(self.source_file.id),
            "source_file_path": self.source_file.file_path,
            "target_quality": self.target_quality.to_dict(),
            "status": self.status.value,
            "progress_percentage": self.progress_percentage,
            "started_at": (datetime.fromtimestamp(self.started_at).isoformat() if self.started_at else None),
            "completed_at": (datetime.fromtimestamp(self.completed_at).isoformat() if self.completed_at else None),
            "error_message": self.error_message,
            "output_file_path": self.output_file_path,
            "estimated_duration": self.estimated_duration.to_seconds() if self.estimated_duration else None,
            "actual_duration": self.actual_duration.to_seconds() if self.actual_duration else None,
            "output_size_mb": self.get_output_size_mb(),
            "metadata": self.metadata,
        }