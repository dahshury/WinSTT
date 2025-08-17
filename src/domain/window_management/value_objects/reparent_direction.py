"""Reparent Direction Value Object

Defines the possible directions for widget reparenting operations.
"""

from enum import Enum


class ReparentDirection(Enum):
    """Enumeration of reparenting directions."""
    TO_TARGET = "to_target"
    TO_ORIGINAL = "to_original"
    BETWEEN_WIDGETS = "between_widgets"