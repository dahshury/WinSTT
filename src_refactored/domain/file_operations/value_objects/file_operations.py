"""File Operations Value Objects

This module contains enums and value objects related to file operations,
including operation results, types, and status management.
"""

from enum import Enum

from src_refactored.domain.common.value_object import ValueObject


class FileOperationResult(ValueObject, Enum):
    """Results of file operations."""
    SUCCESS = "success"
    FAILURE = "failure"
    FILE_NOT_FOUND = "file_not_found"
    PERMISSION_DENIED = "permission_denied"
    INVALID_FORMAT = "invalid_format"
    DISK_FULL = "disk_full"
    PATH_TOO_LONG = "path_too_long"


class FileOperationType(ValueObject, Enum):
    """Types of file operations."""
    SAVE = "save"
    LOAD = "load"
    DELETE = "delete"
    COPY = "copy"
    MOVE = "move"
    VALIDATE = "validate"