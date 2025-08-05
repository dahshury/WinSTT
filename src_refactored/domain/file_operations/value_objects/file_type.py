"""File Type Value Object

Defines the supported file types for operations.
"""

from enum import Enum


class FileType(Enum):
    """Supported file types for drag and drop."""
    AUDIO = "audio"
    TEXT = "text"
    IMAGE = "image"
    VIDEO = "video"
    DOCUMENT = "document"
    ARCHIVE = "archive"
    EXECUTABLE = "executable"
    ANY = "any"