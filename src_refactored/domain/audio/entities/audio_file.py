"""
Audio File Entity

Represents an audio file with metadata and business rules.
Supports various audio file operations and validation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING

from src_refactored.domain.common.abstractions import Entity
from src_refactored.domain.common.value_object import ValueObject

if TYPE_CHECKING:
    from src_refactored.domain.audio.value_objects.audio_format import AudioFormat, Duration


class FileSource(Enum):
    """Source of the audio file."""
    RECORDING = "recording"
    UPLOAD = "upload"
    CONVERSION = "conversion"
    IMPORT = "import"


@dataclass(frozen=True)
class FilePath(ValueObject):
    """Value object for file paths with validation."""
    path: str

    def __post_init__(self):
        if not self.path.strip():
            msg = "File path cannot be empty"
            raise ValueError(msg)

        # Basic path validation
        try:
            path_obj = Path(self.path)
            if path_obj.is_absolute() and not path_obj.parent.exists(,
    ):
                # Allow non-existent absolute paths for future creation
                pass
        except (OSError, ValueError) as e:
            msg = f"Invalid file path: {self.path} - {e}"
            raise ValueError(msg)

    @property
    def file_name(self) -> str:
        """Get the file name without directory."""
        return Path(self.path).name

    @property
    def file_stem(self) -> str:
        """Get the file name without extension."""
        return Path(self.path).stem

    @property
    def file_extension(self) -> str:
        """Get the file extension."""
        return Path(self.path).suffix.lower()

    @property
    def directory(self) -> str:
        """Get the directory path."""
        return str(Path(self.path).parent)

    @property
    def is_audio_file(self,
    ) -> bool:
        """Check if path represents an audio file."""
        audio_extensions = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".mp4", ".webm"}
        return self.file_extension in audio_extensions

    def with_extension(self, new_extension: str,
    ) -> FilePath:
        """Create new FilePath with different extension."""
        if not new_extension.startswith("."):
            new_extension = "." + new_extension

        path_obj = Path(self.path)
        new_path = path_obj.with_suffix(new_extension)
        return FilePath(str(new_path))


@dataclass(frozen=True)
class FileSize(ValueObject):
    """Value object for file sizes."""
    bytes: int

    def __post_init__(self):
        if self.bytes < 0:
            msg = f"File size cannot be negative: {self.bytes}"
            raise ValueError(msg)

    @property
    def kb(self) -> float:
        """Size in kilobytes."""
        return self.bytes / 1024.0

    @property
    def mb(self) -> float:
        """Size in megabytes."""
        return self.bytes / (1024.0 * 1024.0)

    @property
    def gb(self) -> float:
        """Size in gigabytes."""
        return self.bytes / (1024.0 * 1024.0 * 1024.0)

    def format_human_readable(self) -> str:
        """Format as human-readable string."""
        if self.bytes < 1024:
            return f"{self.bytes} B"
        if self.bytes < 1024 * 1024:
            return f"{self.kb:.1f} KB"
        if self.bytes < 1024 * 1024 * 1024:
            return f"{self.mb:.1f} MB"
        return f"{self.gb:.1f} GB"


@dataclass
class AudioFile(Entity,
    ):
    """
    Entity representing an audio file with metadata and operations.
    
    Manages audio file information, validation, and business rules
    for file handling operations.
    """
    file_path: FilePath
    audio_format: AudioFormat
    duration: Duration
    file_size: FileSize
    source: FileSource
    created_at: datetime = field(default_factory=datetime.now)
    last_accessed: datetime = field(default_factory=datetime.now)
    title: str | None = None
    description: str | None = None
    tags: list[str] = field(default_factory=list)

    def __post_init__(self):
        super().__post_init__()

        # Validate file path for audio
        if not self.file_path.is_audio_file:
            msg = f"Invalid audio file extension: {self.file_path.file_extension}"
            raise ValueError(msg)

    def update_access_time(self) -> None:
        """Update last accessed timestamp."""
        self.last_accessed = datetime.now()
        self.update_timestamp(,
    )

    def add_tag(self, tag: str,
    ) -> None:
        """Add a tag to the file."""
        tag = tag.strip().lower()
        if tag and tag not in self.tags:
            self.tags.append(tag)
            self.update_timestamp()

    def remove_tag(self, tag: str,
    ) -> None:
        """Remove a tag from the file."""
        tag = tag.strip().lower()
        if tag in self.tags:
            self.tags.remove(tag)
            self.update_timestamp()

    def update_metadata(self, title: str | None = None, description: str | None = None) -> None:
        """Update file metadata."""
        if title is not None:
            self.title = title.strip() if title.strip() else None

        if description is not None:
            self.description = description.strip() if description.strip() else None

        self.update_timestamp()

    @property
    def estimated_bitrate(self) -> float:
        """Calculate estimated bitrate in kbps."""
        if self.duration.seconds <= 0:
            return 0.0

        bits_per_second = (self.file_size.bytes * 8) / self.duration.seconds
        return bits_per_second / 1000.0  # Convert to kbps

    @property
    def is_high_quality(self) -> bool:
        """Check if file is considered high quality."""
        return (
            self.audio_format.sample_rate >= 44100 and
            self.audio_format.bit_depth.value >= 16 and
            self.estimated_bitrate >= 128  # kbps
        )

    @property
    def is_speech_optimized(self) -> bool:
        """Check if file format is optimized for speech."""
        return (
            self.audio_format.sample_rate == 16000 and
            self.audio_format.is_mono and
            self.audio_format.bit_depth.value == 16
        )

    @property
    def compression_ratio(self) -> float:
        """Calculate compression ratio vs uncompressed size."""
        uncompressed_size = (
            self.duration.seconds *
            self.audio_format.sample_rate *
            self.audio_format.bytes_per_frame
        )

        if uncompressed_size <= 0:
            return 0.0

        return self.file_size.bytes / uncompressed_size

    @property
    def display_name(self) -> str:
        """Get display name for the file."""
        if self.title:
            return self.title
        return self.file_path.file_stem

    @property
    def file_info_summary(self) -> str:
        """Get a summary of file information."""
        return (
            f"{self.display_name} - "
            f"{self.duration.format_human_readable()} - "
            f"{self.file_size.format_human_readable()} - "
            f"{self.audio_format.sample_rate}Hz/{self.audio_format.bit_depth.value}-bit"
        )

    def validate_for_transcription(self) -> bool:
        """
        Validate if file is suitable for transcription.
        
        Business rules:
        - Minimum duration (avoid processing very short files)
        - Reasonable file size
        - Supported audio format
        """
        # Check minimum duration (0.5 seconds)
        if not self.duration.is_minimum_duration:
            return False

        # Check maximum duration (prevent excessive processing)
        if self.duration.seconds > 3600:  # 1 hour max
            return False

        # Check file size limits
        if self.file_size.mb > 1000:  # 1GB max
            return False

        # Check audio format compatibility
        return not self.audio_format.sample_rate < 8000

    def create_transcription_filename(self, output_format: str = "txt") -> FilePath:
        """Create filename for transcription output."""
        base_name = self.file_path.file_stem
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{base_name}_transcription_{timestamp}.{output_format}"

        output_path = Path(self.file_path.directory) / filename
        return FilePath(str(output_path),
    )