"""Domain value objects for geometry management operations.

This module defines domain concepts related to window and widget geometry,
including geometry modes, size modes, and geometry configurations.
"""

from dataclasses import dataclass
from enum import Enum


class GeometryMode(Enum):
    """Window geometry management modes."""
    PRESERVE = "preserve"
    RESTORE_PREVIOUS = "restore_previous"
    USE_DEFAULT = "use_default"
    CALCULATE_OPTIMAL = "calculate_optimal"
    CENTER_ON_SCREEN = "center_on_screen"
    CENTER_ON_PARENT = "center_on_parent"
    CUSTOM_POSITION = "custom_position"
    FILL_PARENT = "fill_parent"


class SizeMode(Enum):
    """Widget sizing modes."""
    FIXED = "fixed"
    MINIMUM = "minimum"
    MAXIMUM = "maximum"
    PREFERRED = "preferred"
    CONTENT_BASED = "content_based"
    PROPORTIONAL = "proportional"
    FILL_PARENT = "fill_parent"
    CUSTOM = "custom"


@dataclass
class WindowGeometry:
    """Window geometry configuration."""
    x: int
    y: int
    width: int
    height: int


@dataclass
class GeometryConfiguration:
    """Configuration for geometry management."""
    mode: GeometryMode = GeometryMode.USE_DEFAULT
    target_geometry: WindowGeometry | None = None
    preserve_aspect_ratio: bool = False
    center_on_screen: bool = False