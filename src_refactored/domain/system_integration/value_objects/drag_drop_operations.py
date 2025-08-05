"""Domain value objects for drag and drop operations.

This module defines domain concepts related to drag and drop functionality,
including drop actions, file types, and operation configurations.
"""

from dataclasses import dataclass
from enum import Enum
from pathlib import Path


class DropAction(Enum):
    """Types of drop actions."""
    COPY = "copy"
    MOVE = "move"
    LINK = "link"
    IGNORE = "ignore"


class FileType(Enum):
    """Supported file types for drag and drop."""
    AUDIO = "audio"
    VIDEO = "video"
    TEXT = "text"
    DIRECTORY = "directory"
    ALL = "all"


@dataclass
class DragDropConfig:
    """Configuration for drag and drop functionality."""
    enabled: bool = True
    accepted_file_types: list[FileType] = None
    accepted_extensions: list[str] = None
    max_file_size_mb: int | None = None
    allow_directories: bool = True
    show_drop_indicator: bool = True
    auto_process: bool = True

    def __post_init__(self,
    ):
        if self.accepted_file_types is None:
            self.accepted_file_types = [FileType.AUDIO, FileType.VIDEO]
        if self.accepted_extensions is None:
            self.accepted_extensions = [
                ".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg",
                ".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv",
            ]


@dataclass
class DropResult:
    """Result of a drop operation."""
    success: bool
    files_processed: list[Path]
    directories_processed: list[Path]
    errors: list[str]
    total_files: int