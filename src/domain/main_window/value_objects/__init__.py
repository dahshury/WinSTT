"""Main window domain value objects.

This module contains value objects for the main window domain.
Note: UI-specific value objects have been moved to the presentation layer.
"""

from .color_palette import Color, ColorPalette
from .icon_path import IconPath
from .opacity_level import OpacityLevel
from .z_order_level import ZOrderLevel

__all__ = [
    "Color",
    "ColorPalette",
    "IconPath",
    "OpacityLevel",
    "ZOrderLevel",
]