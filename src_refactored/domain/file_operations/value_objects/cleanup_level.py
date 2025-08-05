"""Cleanup Level Value Object

Defines the levels of cleanup operations.
"""

from enum import Enum


class CleanupLevel(Enum):
    """Enumeration of cleanup levels."""
    BASIC = "basic"
    THOROUGH = "thorough"
    DEEP = "deep"
    CUSTOM = "custom"