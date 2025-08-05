"""Main window domain entities.

This module contains the domain entities for main window management.
"""

from .main_window import MainWindow
from .ui_layout import UILayout
from .visualization_integration import VisualizationIntegration
from .window_configuration import WindowConfiguration

__all__ = [
    "MainWindow",
    "UILayout",
    "VisualizationIntegration",
    "WindowConfiguration",
]