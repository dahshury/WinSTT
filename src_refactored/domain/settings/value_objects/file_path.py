"""File path value object for settings domain."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from src_refactored.domain.common import ValueObject

if TYPE_CHECKING:
    from src_refactored.domain.common.ports.file_system_port import FileSystemPort


@dataclass(frozen=True)
class FilePath(ValueObject):
    """Value object for file paths with validation."""

    path: str

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (self.path,)

    def __post_init__(self):
        """Validate file path after initialization."""
        if not self.path or not self.path.strip():
            msg = "File path cannot be empty"
            raise ValueError(msg)

        # Basic path cleanup (remove trailing/leading whitespace)
        cleaned_path = self.path.strip()
        object.__setattr__(self, "path", cleaned_path)

    @classmethod
    def from_string(cls, path_string: str,
    ) -> FilePath:
        """Create from string path."""
        return cls(path=path_string)

    def exists(self, file_system_port: FileSystemPort) -> bool:
        """Check if the file exists."""
        exists_result = file_system_port.file_exists(self.path)
        return bool(exists_result.is_success and exists_result.value)

    def is_file(self, file_system_port: FileSystemPort) -> bool:
        """Check if the path points to a file."""
        file_info_result = file_system_port.get_file_info(self.path)
        return bool(file_info_result.is_success and file_info_result.value and file_info_result.value.is_file)

    def is_directory(self, file_system_port: FileSystemPort) -> bool:
        """Check if the path points to a directory."""
        dir_exists_result = file_system_port.directory_exists(self.path)
        return bool(dir_exists_result.is_success and dir_exists_result.value)

    def get_extension(self) -> str:
        """Get the file extension (lowercase)."""
        if "." in self.path:
            return "." + self.path.split(".")[-1].lower()
        return ""

    def get_filename(self, file_system_port: FileSystemPort) -> str:
        """Get the filename without directory."""
        filename_result = file_system_port.get_file_name(self.path)
        return filename_result.value if filename_result.is_success and filename_result.value else ""

    def get_directory(self, file_system_port: FileSystemPort) -> str:
        """Get the directory path."""
        directory_result = file_system_port.get_directory_name(self.path)
        return directory_result.value if directory_result.is_success and directory_result.value else ""

    def is_absolute(self, file_system_port: FileSystemPort) -> bool:
        """Check if the path is absolute."""
        absolute_result = file_system_port.is_absolute_path(self.path)
        return bool(absolute_result.is_success and absolute_result.value)

    def to_absolute(self, file_system_port: FileSystemPort) -> FilePath:
        """Convert to absolute path."""
        absolute_result = file_system_port.resolve_path(self.path)
        if absolute_result.is_success and absolute_result.value:
            return FilePath(path=absolute_result.value)
        return self  # Return self if resolution fails

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