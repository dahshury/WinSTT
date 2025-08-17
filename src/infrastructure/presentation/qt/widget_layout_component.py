"""Widget Layout Component for main window widget management.

This module provides widget layout and styling functionality following the
hexagonal architecture pattern.
"""

import logging
from typing import Any

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QProgressBar,
    QPushButton,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from src.domain.ui_coordination.value_objects.ui_state_management import UIState
from src.presentation.qt.services.ui_layout_service import UILayoutService
from src.presentation.qt.services.ui_text_management_service import (
    UITextManagementService,
)
from src.presentation.qt.services.widget_layering_service import WidgetLayeringService


class WidgetLayoutComponent:
    """Component for managing widget layout and styling.
    
    This component handles widget creation, positioning, styling,
    and layout management for the main window.
    """

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.layout_service = UILayoutService()
        self.layering_service = WidgetLayeringService()
        self.text_service = UITextManagementService()

        # Widget references
        self.widgets: dict[str, QWidget] = {}
        self.layouts: dict[str, Any] = {}

    def setup_widgets(self, main_window: QMainWindow,
    ) -> None:
        """Setup all widgets for the main window.
        
        Args:
            main_window: The main window to setup widgets for
        """
        self.logger.info("🎨 Setting up main window widgets...")

        # Create central widget
        self._create_central_widget(main_window)

        # Create main layout
        self._create_main_layout()

        # Create UI components
        self._create_title_label()
        self._create_status_label()
        self._create_progress_bar()
        self._create_settings_button()

        # Setup layouts
        self._setup_widget_layouts()

        # Apply styling
        self._apply_widget_styling()

        # Configure widget properties
        self._configure_widget_properties()

        # Setup widget layering
        self._setup_widget_layering()

        self.logger.info("✅ Widget setup complete")

    def _create_central_widget(self, main_window: QMainWindow,
    ) -> None:
        """Create and configure the central widget.
        
        Args:
            main_window: The main window
        """
        central_widget = QWidget()
        central_widget.setObjectName("centralwidget")

        # Set size policy
        central_widget.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Expanding,
        )

        # Set as central widget
        main_window.setCentralWidget(central_widget)

        # Store reference
        self.widgets["central_widget"] = central_widget

        self.logger.debug("Central widget created")

    def _create_main_layout(self) -> None:
        """Create the main layout for the central widget."""
        central_widget = self.widgets["central_widget"]

        # Create main vertical layout
        main_layout = QVBoxLayout(central_widget)
        main_layout.setObjectName("main_layout")
        main_layout.setContentsMargins(20, 20, 20, 20)
        main_layout.setSpacing(15)

        # Store reference
        self.layouts["main_layout"] = main_layout

        self.logger.debug("Main layout created")

    def _create_title_label(self) -> None:
        """Create the main title label."""
        title_label = QLabel()
        title_label.setObjectName("title_label")
        title_label.setText("WinSTT")
        title_label.setAlignment(Qt.AlignmentFlag.AlignCenter)

        # Set font
        font = QFont()
        font.setPointSize(24)
        font.setBold(True)
        title_label.setFont(font)

        # Store reference
        self.widgets["title_label"] = title_label

        self.logger.debug("Title label created")

    def _create_status_label(self) -> None:
        """Create the status/instruction label."""
        status_label = QLabel()
        status_label.setObjectName("status_label")
        status_label.setText("Ready to transcribe")
        status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        status_label.setWordWrap(True)

        # Set font
        font = QFont()
        font.setPointSize(10)
        status_label.setFont(font)

        # Store reference
        self.widgets["status_label"] = status_label

        self.logger.debug("Status label created")

    def _create_progress_bar(self) -> None:
        """Create the progress bar."""
        progress_bar = QProgressBar()
        progress_bar.setObjectName("progress_bar")
        progress_bar.setVisible(False)  # Hidden by default
        progress_bar.setMinimum(0)
        progress_bar.setMaximum(100)
        progress_bar.setValue(0)

        # Set size policy
        progress_bar.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Fixed,
        )
        progress_bar.setFixedHeight(20)

        # Store reference
        self.widgets["progress_bar"] = progress_bar

        self.logger.debug("Progress bar created")

    def _create_settings_button(self) -> None:
        """Create the settings button."""
        settings_button = QPushButton()
        settings_button.setObjectName("settings_button")
        settings_button.setText("Settings")

        # Set size policy
        settings_button.setSizePolicy(
            QSizePolicy.Policy.Fixed,
            QSizePolicy.Policy.Fixed,
        )
        settings_button.setFixedSize(80, 30)

        # Store reference
        self.widgets["settings_button"] = settings_button

        self.logger.debug("Settings button created")

    def _setup_widget_layouts(self) -> None:
        """Setup the widget layouts and add widgets."""
        main_layout = self.layouts["main_layout"]

        # Add widgets to main layout
        main_layout.addWidget(self.widgets["title_label"])
        main_layout.addWidget(self.widgets["status_label"])
        main_layout.addWidget(self.widgets["progress_bar"])

        # Add stretch to push settings button to bottom
        main_layout.addStretch()

        # Create bottom layout for settings button
        bottom_layout = QHBoxLayout()
        bottom_layout.addStretch()
        bottom_layout.addWidget(self.widgets["settings_button"])
        bottom_layout.addStretch()

        main_layout.addLayout(bottom_layout)

        # Store bottom layout reference
        self.layouts["bottom_layout"] = bottom_layout

        self.logger.debug("Widget layouts configured")

    def _apply_widget_styling(self) -> None:
        """Apply styling to all widgets."""
        # Title label styling
        self._style_title_label()

        # Status label styling
        self._style_status_label()

        # Progress bar styling
        self._style_progress_bar()

        # Settings button styling
        self._style_settings_button()

        # Central widget styling
        self._style_central_widget()

        self.logger.debug("Widget styling applied")

    def _style_title_label(self) -> None:
        """Apply styling to the title label."""
        title_label = self.widgets["title_label"]

        style = """
            QLabel#title_label {
                color: #ffffff;
                background-color: transparent;
                font-weight: bold;
                font-size: 24px;
                padding: 10px;
            }
        """

        title_label.setStyleSheet(style)

    def _style_status_label(self) -> None:
        """Apply styling to the status label."""
        status_label = self.widgets["status_label"]

        style = """
            QLabel#status_label {
                color: #cccccc;
                background-color: transparent;
                font-size: 10px;
                padding: 5px;
            }
        """

        status_label.setStyleSheet(style)

    def _style_progress_bar(self) -> None:
        """Apply styling to the progress bar."""
        progress_bar = self.widgets["progress_bar"]

        style = """
            QProgressBar#progress_bar {
                border: 1px solid #555555;
                border-radius: 5px;
                background-color: #2b2b2b;
                text-align: center;
                color: #ffffff;
                font-size: 9px;
            }
            
            QProgressBar#progress_bar::chunk {
                background-color: qlineargradient(
                    x1: 0, y1: 0, x2: 1, y2: 0,
                    stop: 0 #4CAF50,
                    stop: 1 #45a049
                );
                border-radius: 4px;
            }
        """

        progress_bar.setStyleSheet(style)

    def _style_settings_button(self) -> None:
        """Apply styling to the settings button."""
        settings_button = self.widgets["settings_button"]

        style = """
            QPushButton#settings_button {
                background-color: #404040;
                border: 1px solid #555555;
                border-radius: 5px;
                color: #ffffff;
                font-size: 10px;
                padding: 5px 10px;
            }
            
            QPushButton#settings_button:hover {
                background-color: #505050;
                border-color: #666666;
            }
            
            QPushButton#settings_button:pressed {
                background-color: #353535;
                border-color: #444444;
            }
        """

        settings_button.setStyleSheet(style)

    def _style_central_widget(self) -> None:
        """Apply styling to the central widget."""
        central_widget = self.widgets["central_widget"]

        style = """
            QWidget#centralwidget {
                background-color: #2b2b2b;
                border: none;
            }
        """

        central_widget.setStyleSheet(style)

    def _configure_widget_properties(self) -> None:
        """Configure additional widget properties."""
        # Configure focus policies
        self.widgets["title_label"].setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.widgets["status_label"].setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.widgets["progress_bar"].setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.widgets["settings_button"].setFocusPolicy(Qt.FocusPolicy.TabFocus)

        # Configure text interaction
        self.widgets["title_label"].setTextInteractionFlags(Qt.TextInteractionFlag.NoTextInteraction)
        self.widgets["status_label"].setTextInteractionFlags(Qt.TextInteractionFlag.NoTextInteraction)

        self.logger.debug("Widget properties configured")

    def _setup_widget_layering(self) -> None:
        """Setup widget layering and z-order."""
        # Raise widgets in proper order
        self.widgets["title_label"].raise_()
        self.widgets["status_label"].raise_()
        self.widgets["progress_bar"].raise_()
        self.widgets["settings_button"].raise_()

        self.logger.debug("Widget layering configured")

    def update_status_text(self, text: str,
    ) -> None:
        """Update the status label text.
        
        Args:
            text: The new status text
        """
        if "status_label" in self.widgets:
            self.widgets["status_label"].setText(text)
            self.logger.debug("Status text updated: {text}")

    def show_progress_bar(self, visible: bool = True) -> None:
        """Show or hide the progress bar.
        
        Args:
            visible: Whether to show the progress bar
        """
        if "progress_bar" in self.widgets:
            self.widgets["progress_bar"].setVisible(visible)
            self.logger.debug("Progress bar visibility: {visible}",
    )

    def update_progress(self, value: int,
    ) -> None:
        """Update the progress bar value.
        
        Args:
            value: Progress value (0-100)
        """
        if "progress_bar" in self.widgets:
            # Clamp value
            value = max(0, min(100, value))
            self.widgets["progress_bar"].setValue(value)
            self.logger.debug("Progress updated: {value}%")

    def apply_state_styling(self, state: UIState,
    ) -> None:
        """Apply state-specific styling to widgets.
        
        Args:
            state: The UI state to apply
        """
        self.logger.info("Applying widget state styling: {state.value}")

        # Update status text based on state
        if state == UIState.LOADING:
            self.update_status_text("Loading...")
            self._apply_loading_styling()
        elif state == UIState.RECORDING:
            self.update_status_text("Recording... Press hotkey to stop")
            self._apply_recording_styling()
        elif state == UIState.PROCESSING:
            self.update_status_text("Processing audio...")
            self._apply_processing_styling()
        elif state == UIState.ERROR:
            self.update_status_text("Error occurred")
            self._apply_error_styling()
        elif state == UIState.SUCCESS:
            self.update_status_text("Ready to transcribe")
            self._apply_idle_styling()
        else:  # ENABLED/DISABLED
            self.update_status_text("Ready to transcribe")
            self._apply_idle_styling()

    def _apply_recording_styling(self) -> None:
        """Apply styling for recording state."""
        if "title_label" in self.widgets:
            style = """
                QLabel#title_label {
                    color: #ff4444;
                    background-color: transparent;
                    font-weight: bold;
                    font-size: 24px;
                    padding: 10px;
                }
            """
            self.widgets["title_label"].setStyleSheet(style)

    def _apply_processing_styling(self) -> None:
        """Apply styling for processing state."""
        if "title_label" in self.widgets:
            style = """
                QLabel#title_label {
                    color: #ffaa00;
                    background-color: transparent;
                    font-weight: bold;
                    font-size: 24px;
                    padding: 10px;
                }
            """
            self.widgets["title_label"].setStyleSheet(style)

    def _apply_error_styling(self) -> None:
        """Apply styling for error state."""
        if "title_label" in self.widgets:
            style = """
                QLabel#title_label {
                    color: #ff0000;
                    background-color: transparent;
                    font-weight: bold;
                    font-size: 24px;
                    padding: 10px;
                }
            """
            self.widgets["title_label"].setStyleSheet(style)

    def _apply_loading_styling(self) -> None:
        """Apply styling for loading state."""
        if "title_label" in self.widgets:
            style = """
                QLabel#title_label {
                    color: #ffaa00;
                    background-color: transparent;
                    font-weight: bold;
                    font-size: 24px;
                    padding: 10px;
                }
            """
            self.widgets["title_label"].setStyleSheet(style)

    def _apply_idle_styling(self) -> None:
        """Apply styling for idle state."""
        if "title_label" in self.widgets:
            style = """
                QLabel#title_label {
                    color: #ffffff;
                    background-color: transparent;
                    font-weight: bold;
                    font-size: 24px;
                    padding: 10px;
                }
            """
            self.widgets["title_label"].setStyleSheet(style,
    )

    def get_widget(self, name: str,
    ) -> QWidget | None:
        """Get a widget by name.
        
        Args:
            name: The widget name
            
        Returns:
            The widget or None if not found
        """
        return self.widgets.get(name)

    def get_layout(self, name: str,
    ) -> Any | None:
        """Get a layout by name.
        
        Args:
            name: The layout name
            
        Returns:
            The layout or None if not found
        """
        return self.layouts.get(name)

    def cleanup(self) -> None:
        """Cleanup widget references."""
        self.logger.info("Cleaning up widget layout component")

        # Clear widget references
        self.widgets.clear()
        self.layouts.clear()

        self.logger.debug("Widget layout component cleanup complete")