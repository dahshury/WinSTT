"""Main window domain module.

This module contains entities and value objects for the main window domain.
"""

from .entities import (
    MainWindow,
    UILayout,
    VisualizationIntegration,
    WindowConfiguration,
)
from .value_objects import (
    ColorPalette,
    IconPath,
    OpacityLevel,
    ZOrderLevel,
)

__all__ = [
    "ColorPalette",
    # Value Objects
    "IconPath",
    # Entities
    "MainWindow",
    "OpacityLevel",
    "UILayout",
    "VisualizationIntegration",
    "WindowConfiguration",
    "ZOrderLevel",
]