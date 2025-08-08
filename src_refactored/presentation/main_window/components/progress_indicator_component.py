"""Progress Indicator Component.

This component handles progress bar and related visual indicators,
following the component pattern for better separation of concerns.
"""

from PyQt6 import QtCore
from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QProgressBar, QWidget

from src_refactored.presentation.shared.ui_theme_service import UIThemeService


class ProgressIndicatorComponent:
    """Component for handling progress indication UI elements."""
    
    def __init__(self, parent: QWidget, theme_service: UIThemeService):
        self._parent = parent
        self._theme = theme_service
        self._setup_components()
    
    def _setup_components(self) -> None:
        """Set up progress indicator components."""
        # Progress bar
        self.progress_bar = QProgressBar(parent=self._parent)
        self.progress_bar.setGeometry(QtCore.QRect(60, 120, 290, 14))
        self.progress_bar.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.progress_bar.setStyleSheet(self._theme.get_widget_style("progress_bar"))
        self.progress_bar.setVisible(False)
    
    def show_progress(self, value: int) -> None:
        """Show progress bar with specific value."""
        self.progress_bar.setVisible(True)
        self.progress_bar.setValue(value)
    
    def hide_progress(self) -> None:
        """Hide the progress bar."""
        self.progress_bar.setVisible(False)
    
    def update_progress(self, value: int) -> None:
        """Update progress bar value."""
        self.progress_bar.setValue(value)
    
    def get_progress_bar(self) -> QProgressBar:
        """Get the progress bar for external services."""
        return self.progress_bar

