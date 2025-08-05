"""Main window domain value objects.

This module contains value objects for the main window domain.
"""

from .color_palette import ColorPalette
from .icon_path import IconPath
from .opacity_level import OpacityLevel
from .z_order_level import ZOrderLevel

__all__ = [
    "ColorPalette",
    "IconPath",
    "OpacityLevel",
    "ZOrderLevel",
]