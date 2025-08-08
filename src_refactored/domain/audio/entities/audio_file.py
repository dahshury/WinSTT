"""
Audio File Entity

Represents an audio file with metadata and business rules.
Supports various audio file operations and validation.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING

from src_refactored.domain.common.abstractions import Entity
from src_refactored.domain.common.domain_utils import DomainIdentityGenerator
from src_refactored.domain.common.value_object import ValueObject

if TYPE_CHECKING:
    from src_refactored.domain.audio.value_objects.audio_format import AudioFormat, Duration
    from src_refactored.domain.common.ports.file_system_port import FileSystemPort


class FileSource(Enum):
    """Source of the audio file."""
    RECORDING = "recording"
    UPLOAD = "upload"
    CONVERSION = "conversion"
    IMPORT = "import"


@dataclass(frozen=True)
class FilePath(ValueObject):
    """File path value object."""
    path: str

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (self.path,)

    def __post_init__(self):
        if not self.path.strip():
            msg = "File path cannot be empty"
            raise ValueError(msg)

        # Basic path validation - ensure it's a reasonable string
        if any(char in self.path for char in ["<", ">", "|", "?", "*"]):
            msg = f"Invalid characters in file path: {self.path}"
            raise ValueError(msg)

    @property
    def file_name(self) -> str:
        """Get the file name without directory."""
        # Extract filename using string operations
        if "/" in self.path:
            return self.path.split("/")[-1]
        if "\\" in self.path:
            return self.path.split("\\")[-1]
        return self.path

    @property
    def file_stem(self) -> str:
        """Get the file name without extension."""
        filename = self.file_name
        if "." in filename:
            return filename.rsplit(".", 1)[0]
        return filename

    @property
    def file_extension(self) -> str:
        """Get the file extension."""
        if "." in self.path:
            return "." + self.path.split(".")[-1].lower()
        return ""

    @property
    def directory(self) -> str:
        """Get the directory path."""
        # Extract directory using string operations
        if "/" in self.path:
            return "/".join(self.path.split("/")[:-1])
        if "\\" in self.path:
            return "\\".join(self.path.split("\\")[:-1])
        return ""

    @property
    def is_audio_file(self,
    ) -> bool:
        """Check if path represents an audio file."""
        audio_extensions = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".mp4", ".webm"}
        return self.file_extension in audio_extensions

    def with_extension(self, new_extension: str) -> FilePath:
        """Create new FilePath with different extension."""
        if not new_extension.startswith("."):
            new_extension = "." + new_extension

        # Remove current extension and add new one
        current_path = self.path
        if "." in current_path:
            current_path = current_path.rsplit(".", 1)[0]
        
        return FilePath(current_path + new_extension)


@dataclass(frozen=True)
class FileSize(ValueObject):
    """File size value object."""
    bytes: int

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (self.bytes,)

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


class Duration(ValueObject):
    """Duration value object."""
    seconds: float

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (self.seconds,)

    def __post_init__(self):
        if self.seconds < 0:
            msg = f"Duration cannot be negative: {self.seconds}"
            raise ValueError(msg)

    @property
    def is_minimum_duration(self) -> bool:
        """Check if duration is at least 0.5 seconds."""
        return self.seconds >= 0.5

    def format_human_readable(self) -> str:
        """Format duration as a human-readable string."""
        if self.seconds < 60:
            return f"{self.seconds:.1f}s"
        if self.seconds < 3600:
            return f"{self.seconds / 60:.1f}m"
        return f"{self.seconds / 3600:.1f}h"


class AudioFile(Entity):
    """
    Entity representing an audio file with metadata and operations.
    
    Manages audio file information, validation, and business rules
    for file handling operations.
    """
    
    def __init__(self, entity_id: str, file_path: FilePath, audio_format: AudioFormat, 
                 duration: Duration, file_size: FileSize, source: FileSource, **kwargs):
        """Initialize AudioFile entity."""
        super().__init__(entity_id)
        self.file_path = file_path
        self.audio_format = audio_format
        self.duration = duration
        self.file_size = file_size
        self.source = source
        
        # Set optional fields from kwargs
        self.last_accessed = kwargs.get("last_accessed", DomainIdentityGenerator.generate_timestamp())
        self.title = kwargs.get("title")
        self.description = kwargs.get("description")
        self.tags = kwargs.get("tags", [])

        # Validate file path for audio
        if not self.file_path.is_audio_file:
            msg = f"Invalid audio file extension: {self.file_path.file_extension}"
            raise ValueError(msg)

    def update_access_time(self) -> None:
        """Update last accessed timestamp."""
        self.last_accessed = DomainIdentityGenerator.generate_timestamp()
        self.update_timestamp()

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

    def create_transcription_filename(self, output_format: str = "txt", file_system_port: FileSystemPort | None = None) -> FilePath:
        """Create filename for transcription output.

        Note: Domain only composes a name; actual time-based prefixing should happen in infra via a naming service.
        """
        base_name = self.file_path.file_stem
        suffix = DomainIdentityGenerator.generate_domain_id("transcription")
        filename = f"{base_name}_{suffix}.{output_format}"

        # Join paths using string operations
        directory = self.file_path.directory
        if directory and file_system_port is not None:
            jp = file_system_port.join_paths(directory, filename)
            if jp.is_success and jp.value:
                output_path = jp.value
            else:
                # Fallback to safe string join based on existing path style
                separator = "/" if "/" in self.file_path.path else "\\"
                output_path = f"{directory}{separator}{filename}"
        else:
            output_path = filename
            
        return FilePath(output_path)