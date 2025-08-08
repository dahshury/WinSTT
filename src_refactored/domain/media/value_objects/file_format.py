"""File format value object for media files."""

from dataclasses import dataclass
from enum import Enum
from typing import Optional

from src_refactored.domain.common.value_object import ValueObject


class MediaType(Enum):
    """Enumeration of supported media types."""
    AUDIO = "audio"
    VIDEO = "video"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class FileFormat(ValueObject):
    """Value object representing a media file format."""

    extension: str
    media_type: MediaType
    mime_type: str
    description: str

    # Supported formats
    AUDIO_FORMATS = {
        ".mp3": ("audio/mpeg", "MP3 Audio"),
        ".wav": ("audio/wav", "WAV Audio"),
    }

    VIDEO_FORMATS = {
        ".mp4": ("video/mp4", "MP4 Video"),
        ".avi": ("video/x-msvideo", "AVI Video"),
        ".mkv": ("video/x-matroska", "MKV Video"),
        ".mov": ("video/quicktime", "QuickTime Video"),
        ".flv": ("video/x-flv", "FLV Video"),
        ".wmv": ("video/x-ms-wmv", "WMV Video"),
    }

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            self.extension,
            self.media_type,
            self.mime_type,
            self.description,
        )

    def __post_init__(self):
        """Validate the file format after initialization."""
        if not self.extension.startswith("."):
            msg = "Extension must start with a dot"
            raise ValueError(msg)

        if self.media_type not in MediaType:
            msg = f"Invalid media type: {self.media_type}"
            raise ValueError(msg)

    @classmethod
    def from_file_path(cls, file_path: str,
    ) -> "FileFormat":
        """Create a FileFormat from a file path."""
        # Extract extension using string operations
        extension = "." + file_path.split(".")[-1].lower() if "." in file_path else ""

        if extension in cls.AUDIO_FORMATS:
            mime_type, description = cls.AUDIO_FORMATS[extension]
            return cls(
                extension=extension,
                media_type=MediaType.AUDIO,
                mime_type=mime_type,
                description=description,
            )
        if extension in cls.VIDEO_FORMATS:
            mime_type, description = cls.VIDEO_FORMATS[extension]
            return cls(
                extension=extension,
                media_type=MediaType.VIDEO,
                mime_type=mime_type,
                description=description,
            )
        return cls(
            extension=extension,
            media_type=MediaType.UNKNOWN,
            mime_type="application/octet-stream",
            description="Unknown Format",
        )

    @classmethod
    def get_supported_audio_extensions(cls) -> list[str]:
        """Get list of supported audio file extensions."""
        return list(cls.AUDIO_FORMATS.keys())

    @classmethod
    def get_supported_video_extensions(cls) -> list[str]:
        """Get list of supported video file extensions."""
        return list(cls.VIDEO_FORMATS.keys())

    @classmethod
    def get_all_supported_extensions(cls) -> list[str]:
        """Get list of all supported file extensions."""
        return list(cls.AUDIO_FORMATS.keys()) + list(cls.VIDEO_FORMATS.keys())

    def is_audio(self) -> bool:
        """Check if this format is an audio format."""
        return self.media_type == MediaType.AUDIO

    def is_video(self) -> bool:
        """Check if this format is a video format."""
        return self.media_type == MediaType.VIDEO

    def is_supported(self) -> bool:
        """Check if this format is supported for processing."""
        return self.media_type in [MediaType.AUDIO, MediaType.VIDEO]

    def requires_conversion(self) -> bool:
        """Check if this format requires conversion for transcription."""
        return self.media_type == MediaType.VIDEO

    def get_conversion_target_format(self) -> Optional["FileFormat"]:
        """Get the target format for conversion (video -> audio)."""
        if self.is_video():
            return FileFormat(
                extension=".wav",
                media_type=MediaType.AUDIO,
                mime_type="audio/wav",
                description="WAV Audio",
            )
        return None