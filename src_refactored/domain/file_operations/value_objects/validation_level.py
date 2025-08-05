"""Validation Level Value Object

Defines the levels of validation for file operations.
"""

from enum import Enum


class ValidationLevel(Enum):
    """File validation levels."""
    NONE = "none"
    BASIC = "basic"
    STRICT = "strict"
    CUSTOM = "custom"