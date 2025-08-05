"""Restoration Mode Value Object

Defines the possible modes for restoring UI state.
"""

from enum import Enum


class RestorationMode(Enum):
    """Enumeration of restoration modes."""
    FULL_RESTORATION = "full_restoration"
    PARTIAL_RESTORATION = "partial_restoration"
    MINIMAL_RESTORATION = "minimal_restoration"
    CUSTOM_RESTORATION = "custom_restoration"