"""File path value object for settings domain."""

from __future__ import annotations

import os
from dataclasses import dataclass

from src_refactored.domain.common import ValueObject


@dataclass(frozen=True)
class FilePath(ValueObject):
    """Value object for file paths with validation."""

    path: str

    def __post_init__(self):
        """Validate file path after initialization."""
        if not self.path or not self.path.strip():
            msg = "File path cannot be empty"
            raise ValueError(msg)

        # Normalize the path
        normalized_path = os.path.normpath(self.path.strip())
        object.__setattr__(self, "path", normalized_path)

    @classmethod
    def from_string(cls, path_string: str,
    ) -> FilePath:
        """Create from string path."""
        return cls(path=path_string)

    def exists(self) -> bool:
        """Check if the file exists."""
        return os.path.exists(self.path)

    def is_file(self) -> bool:
        """Check if the path points to a file."""
        return os.path.isfile(self.path)

    def is_directory(self) -> bool:
        """Check if the path points to a directory."""
        return os.path.isdir(self.path)

    def get_extension(self) -> str:
        """Get the file extension (lowercase)."""
        return os.path.splitext(self.path)[1].lower()

    def get_filename(self) -> str:
        """Get the filename without directory."""
        return os.path.basename(self.path)

    def get_directory(self) -> str:
        """Get the directory path."""
        return os.path.dirname(self.path)

    def is_absolute(self) -> bool:
        """Check if the path is absolute."""
        return os.path.isabs(self.path)

    def to_absolute(self) -> FilePath:
        """Convert to absolute path."""
        return FilePath(path=os.path.abspath(self.path))

    def __str__(self) -> str:
        """String representation."""
        return self.path


@dataclass(frozen=True)
class AudioFilePath(FilePath):
    """Value object for audio file paths with format validation."""

    SUPPORTED_EXTENSIONS = {".mp3", ".wav", ".m4a", ".flac", ".ogg"}

    def __post_init__(self):
        """Validate audio file path after initialization."""
        super().__post_init__()

        if not self.is_supported_audio_format():
            msg = f"Unsupported audio format: {self.get_extension()}"
            raise ValueError(msg)

    def is_supported_audio_format(self) -> bool:
        """Check if the file has a supported audio format."""
        return self.get_extension() in self.SUPPORTED_EXTENSIONS

    @classmethod
    def get_supported_extensions(cls) -> list[str]:
        """Get list of supported audio extensions."""
        return list(cls.SUPPORTED_EXTENSIONS)


@dataclass(frozen=True)
class ModelFilePath(FilePath):
    """Value object for model file paths with validation."""

    SUPPORTED_EXTENSIONS = {".onnx", ".bin", ".pt", ".pth"}

    def __post_init__(self):
        """Validate model file path after initialization."""
        super().__post_init__()

        if not self.is_supported_model_format():
            msg = f"Unsupported model format: {self.get_extension()}"
            raise ValueError(msg)

    def is_supported_model_format(self) -> bool:
        """Check if the file has a supported model format."""
        return self.get_extension() in self.SUPPORTED_EXTENSIONS

    @classmethod
    def get_supported_extensions(cls) -> list[str]:
        """Get list of supported model extensions."""
        return list(cls.SUPPORTED_EXTENSIONS)