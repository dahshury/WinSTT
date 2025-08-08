"""Main Window Builder.

This builder creates and configures the main window UI structure,
following the builder pattern for better separation of UI construction.
"""


from PyQt6 import QtCore
from PyQt6.QtCore import QSize
from PyQt6.QtWidgets import QLabel, QPushButton, QWidget

from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.presentation.adapters.pyqtgraph_renderer_adapter import PyQtGraphRendererAdapter
from src_refactored.presentation.main_window.components.progress_indicator_component import (
    ProgressIndicatorComponent,
)
from src_refactored.presentation.main_window.components.status_display_component import (
    StatusDisplayComponent,
)
from src_refactored.presentation.shared.resource_helpers import (
    try_get_icon,
    try_get_pixmap,
)
from src_refactored.presentation.shared.ui_theme_service import UIThemeService


class MainWindowUIBuilder:
    """Builder for constructing main window UI components."""
    
    def __init__(self, parent_widget: QWidget, resource_service, theme_service: UIThemeService, logger: LoggingPort):
        self._parent = parent_widget
        self._resource_service = resource_service
        self._theme = theme_service
        self._logger = logger
        
        # Components
        self.status_display: StatusDisplayComponent | None = None
        self.progress_indicator: ProgressIndicatorComponent | None = None
        self.visualization_renderer: PyQtGraphRendererAdapter | None = None
        self.settings_button: QPushButton | None = None
        
        # Additional UI elements
        self.hw_accel_label: QLabel | None = None
        self.hw_accel_indicator: QLabel | None = None
        self.logo_label: QLabel | None = None
        self.background_label: QLabel | None = None
    
    def build_status_components(self) -> "MainWindowUIBuilder":
        """Build status display components."""
        self.status_display = StatusDisplayComponent(self._parent, self._theme)
        return self
    
    def build_progress_components(self) -> "MainWindowUIBuilder":
        """Build progress indicator components."""
        self.progress_indicator = ProgressIndicatorComponent(self._parent, self._theme)
        return self
    
    def build_visualization_renderer(self) -> "MainWindowUIBuilder":
        """Build visualization renderer using proper DDD architecture."""
        self.visualization_renderer = PyQtGraphRendererAdapter(self._parent, self._logger)
        return self
    
    def build_settings_button(self, settings_click_handler) -> "MainWindowUIBuilder":
        """Build settings button."""
        try:
            self.settings_button = QPushButton("", parent=self._parent)
            self.settings_button.setGeometry(QtCore.QRect(360, 50, 24, 24))
            self.settings_button.setToolTip("Settings")
            
            # Set gear icon
            icon = try_get_icon(self._resource_service, "resources/gear.png")
            if icon is not None:
                self.settings_button.setIcon(icon)
            
            self.settings_button.setIconSize(QSize(16, 16))
            self.settings_button.setStyleSheet(self._theme.get_widget_style("button_transparent"))
            self.settings_button.clicked.connect(settings_click_handler)
            self.settings_button.raise_()  # Ensure button is on top
            
            self._logger.log_debug("Settings button created and configured")
            
        except Exception as e:
            self._logger.log_error(f"Error building settings button: {e}")
        
        return self
    
    def build_hardware_acceleration_indicator(self, has_acceleration: bool) -> "MainWindowUIBuilder":
        """Build hardware acceleration indicator."""
        try:
            # Label
            self.hw_accel_label = QLabel("H/W Acceleration:", parent=self._parent)
            self.hw_accel_label.setGeometry(QtCore.QRect(262, 189, 161, 31))
            self.hw_accel_label.setStyleSheet(self._theme.get_text_style("status"))
            
            # Indicator
            self.hw_accel_indicator = QLabel("", parent=self._parent)
            self.hw_accel_indicator.setGeometry(QtCore.QRect(360, 190, 31, 31))
            
            # Set appropriate icon
            icon_path = "resources/switch-on.png" if has_acceleration else "resources/switch-off.png"
            pixmap = try_get_pixmap(self._resource_service, icon_path)
            if pixmap is not None:
                self.hw_accel_indicator.setPixmap(pixmap)
                self.hw_accel_indicator.setScaledContents(True)
            
        except Exception as e:
            self._logger.log_error(f"Error building hardware acceleration indicator: {e}")
        
        return self
    
    def build_logo_and_background(self) -> "MainWindowUIBuilder":
        """Build background elements (no bottom app icon)."""
        try:
            # Remove bottom app icon by not creating the logo label at the bottom

            # Background image (keep header strip only)
            self.background_label = QLabel("", parent=self._parent)
            self.background_label.setGeometry(QtCore.QRect(0, -5, 401, 51))
            bg = try_get_pixmap(self._resource_service, "resources/Untitled-1.png")
            if bg is not None:
                self.background_label.setPixmap(bg)
                self.background_label.setScaledContents(True)
            
        except Exception as e:
            self._logger.log_error(f"Error building background: {e}")
        
        return self
    
    def configure_instruction_text(self, recording_key: str) -> "MainWindowUIBuilder":
        """Configure the instruction text with recording key."""
        if self.status_display:
            self.status_display.update_instruction_text(recording_key)
        return self
    
    def get_status_display(self) -> StatusDisplayComponent:
        """Get the status display component."""
        if not self.status_display:
            msg = "Status display component not built"
            raise ValueError(msg)
        return self.status_display
    
    def get_progress_indicator(self) -> ProgressIndicatorComponent:
        """Get the progress indicator component."""
        if not self.progress_indicator:
            msg = "Progress indicator component not built"
            raise ValueError(msg)
        return self.progress_indicator
    
    def get_visualization_renderer(self) -> PyQtGraphRendererAdapter:
        """Get the visualization renderer."""
        if not self.visualization_renderer:
            msg = "Visualization renderer not built"
            raise ValueError(msg)
        return self.visualization_renderer
