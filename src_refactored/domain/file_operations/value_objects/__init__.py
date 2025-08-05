"""File Operations Value Objects

This module contains value objects for file operations domain concepts.
"""

from .cleanup_level import CleanupLevel
from .drop_action import DropAction
from .drop_zone_type import DropZoneType
from .file_type import FileType
from .processing_mode import ProcessingMode
from .validation_level import ValidationLevel

__all__ = [
    "CleanupLevel",
    "DropAction",
    "DropZoneType",
    "FileType",
    "ProcessingMode",
    "ValidationLevel",
]