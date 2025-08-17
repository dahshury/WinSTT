"""Output configuration value object for file operations domain."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from src.domain.common import ValueObject

if TYPE_CHECKING:
    from src.domain.common.ports.file_system_port import FileSystemPort


@dataclass(frozen=True)
class OutputConfiguration(ValueObject):
    """Value object for output configuration settings."""

    format_type: str
    include_timestamps: bool
    output_directory: str | None = None
    filename_template: str = "transcription_{timestamp}"
    auto_save: bool = True
    overwrite_existing: bool = False

    def __post_init__(self) -> None:
        """Validate output configuration after initialization."""
        valid_formats = ["text", "json", "srt", "vtt", "csv", "docx", "pdf"]
        if self.format_type not in valid_formats:
            msg = f"Invalid format type: {self.format_type}. Must be one of {valid_formats}."
            raise ValueError(msg)

        if not self.filename_template or not self.filename_template.strip():
            msg = "Filename template cannot be empty"
            raise ValueError(msg)

    def validate_directory(self, file_system_port: FileSystemPort) -> bool:
        """Validate that the output directory exists and is accessible."""
        if self.output_directory is None:
            return True
        
        # Check directory exists
        dir_exists_result = file_system_port.directory_exists(self.output_directory)
        if not dir_exists_result.is_success or not dir_exists_result.value:
            return False
        
        # Get directory info to verify it's actually a directory
        dir_info_result = file_system_port.get_directory_info(self.output_directory)
        return bool(dir_info_result.is_success and dir_info_result.value and dir_info_result.value.exists)

    @classmethod
    def create_default(cls) -> OutputConfiguration:
        """Create default output configuration."""
        return cls(
            format_type="text",
            include_timestamps=True,
            output_directory=None,
            filename_template="transcription_{timestamp}",
            auto_save=True,
            overwrite_existing=False,
        )

    @classmethod
    def create_for_format(cls, format_type: str, output_dir: str | None = None) -> OutputConfiguration:
        """Create configuration for specific format."""
        return cls(
            format_type=format_type,
            include_timestamps=format_type in ["srt", "vtt", "json"],
            output_directory=output_dir,
            filename_template=f"transcription_{{timestamp}}.{format_type}",
            auto_save=True,
            overwrite_existing=False,
        )

    def with_directory(self, directory: str) -> OutputConfiguration:
        """Create new configuration with different output directory."""
        return OutputConfiguration(
            format_type=self.format_type,
            include_timestamps=self.include_timestamps,
            output_directory=directory,
            filename_template=self.filename_template,
            auto_save=self.auto_save,
            overwrite_existing=self.overwrite_existing,
        )

    def get_file_extension(self) -> str:
        """Get appropriate file extension for the format."""
        extensions = {
            "text": ".txt",
            "json": ".json",
            "srt": ".srt",
            "vtt": ".vtt",
            "csv": ".csv",
            "docx": ".docx",
            "pdf": ".pdf",
        }
        return extensions.get(self.format_type, ".txt")

    def is_subtitle_format(self) -> bool:
        """Check if format is a subtitle format."""
        return self.format_type in ["srt", "vtt"]

    def supports_timestamps(self) -> bool:
        """Check if format supports timestamps."""
        return self.format_type in ["srt", "vtt", "json"]