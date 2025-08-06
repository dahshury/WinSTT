"""Media file entity for handling media files."""

import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from src_refactored.domain.common.entity import Entity
from src_refactored.domain.media.value_objects import ConversionQuality, FileFormat, MediaDuration


@dataclass
class MediaFile(Entity):
    """Entity representing a media file for processing."""

    file_path: str
    file_format: FileFormat
    file_size: int  # bytes
    duration: MediaDuration | None = None
    created_at: datetime = field(default_factory=datetime.now,
    )
    last_modified: datetime | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        """Initialize the media file after creation."""
        super().__post_init__()

        # Validate file exists
        if not os.path.exists(self.file_path):
            msg = f"File does not exist: {self.file_path}"
            raise ValueError(msg)

        # Get file modification time
        stat = os.stat(self.file_path)
        self.last_modified = datetime.fromtimestamp(stat.st_mtime)

    @classmethod
    def from_file_path(cls, file_path: str,
    ) -> "MediaFile":
        """Create a MediaFile from a file path."""
        if not os.path.exists(file_path):
            msg = f"File does not exist: {file_path}"
            raise ValueError(msg)

        # Get file info
        stat = os.stat(file_path)
        file_size = stat.st_size

        # Determine file format
        file_format = FileFormat.from_file_path(file_path)

        return cls(
            file_path=file_path,
            file_format=file_format,
            file_size=file_size,
        )

    def get_filename(self) -> str:
        """Get the filename without path."""
        return os.path.basename(self.file_path)

    def get_filename_without_extension(self) -> str:
        """Get the filename without extension."""
        return os.path.splitext(self.get_filename())[0]

    def get_directory(self) -> str:
        """Get the directory containing the file."""
        return os.path.dirname(self.file_path)

    def get_file_size_mb(self) -> float:
        """Get file size in megabytes."""
        return self.file_size / (1024 * 1024)

    def is_audio(self) -> bool:
        """Check if this is an audio file."""
        return self.file_format.is_audio()

    def is_video(self) -> bool:
        """Check if this is a video file."""
        return self.file_format.is_video()

    def is_supported(self) -> bool:
        """Check if this file format is supported for processing."""
        return self.file_format.is_supported()

    def requires_conversion(self) -> bool:
        """Check if this file requires conversion before transcription."""
        return self.file_format.requires_conversion()

    def can_be_transcribed_directly(self) -> bool:
        """Check if this file can be transcribed without conversion."""
        return self.is_audio() and self.is_supported()

    def get_conversion_target_format(self) -> FileFormat | None:
        """Get the target format for conversion."""
        return self.file_format.get_conversion_target_format()

    def estimate_conversion_output_size(self, quality: ConversionQuality,
    ) -> float:
        """Estimate the size of converted file in MB."""
        if not self.duration:
            # Rough estimate based on file size if duration unknown
            return self.get_file_size_mb() * 0.1  # Assume 10% of original for audio

        return quality.estimate_file_size_mb(self.duration.to_seconds())

    def estimate_processing_time(self, quality: ConversionQuality | None = None) -> float:
        """Estimate processing time in seconds."""
        if not self.duration:
            # Rough estimate based on file size
            return self.get_file_size_mb() * 2  # 2 seconds per MB

        base_time = self.duration.to_seconds() * 0.1  # 10% of duration

        if quality and self.requires_conversion():
            conversion_time = quality.estimate_processing_time(self.duration.to_seconds())
            return base_time + conversion_time

        return base_time

    def set_duration(self, duration: MediaDuration,
    ) -> None:
        """Set the media duration."""
        self.duration = duration

    def add_metadata(self, key: str, value: Any,
    ) -> None:
        """Add metadata to the file."""
        self.metadata[key] = value

    def get_metadata(self, key: str, default: Any = None,
    ) -> Any:
        """Get metadata value."""
        return self.metadata.get(key, default)

    def has_metadata(self, key: str,
    ) -> bool:
        """Check if metadata key exists."""
        return key in self.metadata

    def is_large_file(self, threshold_mb: float = 100) -> bool:
        """Check if this is considered a large file."""
        return self.get_file_size_mb() > threshold_mb

    def is_long_duration(self, threshold_minutes: float = 60) -> bool:
        """Check if this has a long duration."""
        if not self.duration:
            return False
        return self.duration.to_minutes() > threshold_minutes

    def get_output_filename(self, suffix: str = "_transcription", extension: str = ".txt") -> str:
        """Get suggested output filename for transcription."""
        base_name = self.get_filename_without_extension()
        return f"{base_name}{suffix}{extension}"

    def get_srt_output_filename(self,
    ) -> str:
        """Get suggested SRT output filename."""
        return self.get_output_filename(suffix="", extension=".srt")

    def refresh_file_info(self) -> None:
        """Refresh file information from disk."""
        if not os.path.exists(self.file_path):
            msg = f"File no longer exists: {self.file_path}"
            raise ValueError(msg)

        stat = os.stat(self.file_path)
        self.file_size = stat.st_size
        self.last_modified = datetime.fromtimestamp(stat.st_mtime)

    def validate_file_integrity(self) -> bool:
        """Validate that the file still exists and is accessible."""
        try:
            return os.path.exists(self.file_path) and os.access(self.file_path, os.R_OK)
        except OSError:
            return False

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary representation."""
        return {
            "id": str(self.id),
            "file_path": self.file_path,
            "file_format": {
                "extension": self.file_format.extension,
                "media_type": self.file_format.media_type.value,
                "mime_type": self.file_format.mime_type,
                "description": self.file_format.description,
            },
            "file_size": self.file_size,
            "duration": self.duration.to_seconds() if self.duration else None,
            "created_at": self.created_at.isoformat(),
            "last_modified": self.last_modified.isoformat() if self.last_modified else None,
            "metadata": self.metadata,
        }