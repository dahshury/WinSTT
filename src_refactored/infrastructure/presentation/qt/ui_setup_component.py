"""UI Setup Component for main window UI initialization.

This module provides UI setup functionality following the
hexagonal architecture pattern.
"""

import logging

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QFrame,
    QLabel,
    QMainWindow,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from src_refactored.domain.ui_coordination.value_objects.ui_state import UIState
from src_refactored.infrastructure.main_window.ui_layout_service import UILayoutService
from src_refactored.infrastructure.main_window.window_configuration_service import (
    WindowConfigurationService,
)


class UISetupComponent:
    """Component for setting up the main window UI.
    
    This component handles the creation and configuration of UI elements
    for the main window using the refactored services.
    """

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.layout_service = UILayoutService()
        self.window_config_service = WindowConfigurationService()

    def setup_ui(self, main_window: QMainWindow,
    ) -> None:
        """Setup the complete UI for the main window.
        
        Args:
            main_window: The main window to setup
        """
        self.logger.info("🎨 Setting up main window UI...")

        # Create central widget
        self._create_central_widget(main_window)

        # Setup main layout
        self._setup_main_layout(main_window)

        # Create UI elements
        self._create_ui_elements(main_window)

        # Apply styling
        self._apply_styling(main_window)

        # Configure size policies
        self._configure_size_policies(main_window)

        self.logger.info("✅ Main window UI setup complete")

    def _create_central_widget(self, main_window: QMainWindow,
    ) -> None:
        """Create and set the central widget.
        
        Args:
            main_window: The main window
        """
        central_widget = QWidget()
        central_widget.setObjectName("centralwidget")
        main_window.setCentralWidget(central_widget)

        # Store reference for later use
        main_window.centralwidget = central_widget

        self.logger.debug("Central widget created")

    def _setup_main_layout(self, main_window: QMainWindow,
    ) -> None:
        """Setup the main layout for the central widget.
        
        Args:
            main_window: The main window
        """
        # Create main vertical layout
        main_layout = QVBoxLayout(main_window.centralwidget)
        main_layout.setContentsMargins(10, 10, 10, 10)
        main_layout.setSpacing(10)
        main_layout.setObjectName("mainLayout")

        # Store reference
        main_window.main_layout = main_layout

        self.logger.debug("Main layout created")

    def _create_ui_elements(self, main_window: QMainWindow,
    ) -> None:
        """Create the main UI elements.
        
        Args:
            main_window: The main window
        """
        # Create title label
        self._create_title_label(main_window)

        # Create status label
        self._create_status_label(main_window)

        # Create progress area
        self._create_progress_area(main_window)

        # Create visualization area placeholder
        self._create_visualization_area(main_window)

    def _create_title_label(self, main_window: QMainWindow,
    ) -> None:
        """Create the main title label.
        
        Args:
            main_window: The main window
        """
        title_label = QLabel("WinSTT")
        title_label.setObjectName("titleLabel")
        title_label.setAlignment(Qt.AlignmentFlag.AlignCenter)

        # Set font
        font = QFont()
        font.setPointSize(24)
        font.setBold(True)
        title_label.setFont(font)

        # Add to layout
        main_window.main_layout.addWidget(title_label)

        # Store reference
        main_window.title_label = title_label

        self.logger.debug("Title label created")

    def _create_status_label(self, main_window: QMainWindow,
    ) -> None:
        """Create the status label.
        
        Args:
            main_window: The main window
        """
        status_label = QLabel("Ready")
        status_label.setObjectName("statusLabel")
        status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)

        # Set font
        font = QFont()
        font.setPointSize(12)
        status_label.setFont(font)

        # Add to layout
        main_window.main_layout.addWidget(status_label)

        # Store reference
        main_window.status_label = status_label

        self.logger.debug("Status label created")

    def _create_progress_area(self, main_window: QMainWindow,
    ) -> None:
        """Create the progress display area.
        
        Args:
            main_window: The main window
        """
        # Create progress frame
        progress_frame = QFrame()
        progress_frame.setObjectName("progressFrame")
        progress_frame.setFrameStyle(QFrame.Shape.StyledPanel)
        progress_frame.setMinimumHeight(60)

        # Create progress layout
        progress_layout = QVBoxLayout(progress_frame)
        progress_layout.setContentsMargins(5, 5, 5, 5)

        # Create progress label
        progress_label = QLabel("")
        progress_label.setObjectName("progressLabel")
        progress_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        progress_layout.addWidget(progress_label)

        # Add to main layout
        main_window.main_layout.addWidget(progress_frame)

        # Store references
        main_window.progress_frame = progress_frame
        main_window.progress_label = progress_label

        self.logger.debug("Progress area created")

    def _create_visualization_area(self, main_window: QMainWindow,
    ) -> None:
        """Create the visualization area placeholder.
        
        Args:
            main_window: The main window
        """
        # Create visualization frame
        viz_frame = QFrame()
        viz_frame.setObjectName("visualizationFrame")
        viz_frame.setFrameStyle(QFrame.Shape.StyledPanel)
        viz_frame.setMinimumHeight(100)

        # Create visualization layout
        viz_layout = QVBoxLayout(viz_frame)
        viz_layout.setContentsMargins(5, 5, 5, 5)

        # Create placeholder label
        viz_label = QLabel("Audio Visualization")
        viz_label.setObjectName("visualizationLabel")
        viz_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        viz_layout.addWidget(viz_label)

        # Add to main layout
        main_window.main_layout.addWidget(viz_frame)

        # Store references
        main_window.visualization_frame = viz_frame
        main_window.visualization_label = viz_label

        self.logger.debug("Visualization area created")

    def _apply_styling(self, main_window: QMainWindow,
    ) -> None:
        """Apply styling to UI elements.
        
        Args:
            main_window: The main window
        """
        # Apply dark theme styling
        stylesheet = """
            QMainWindow {
                background-color: #2b2b2b;
                color: #ffffff;
            }
            
            QLabel#titleLabel {
                color: #ffffff;
                font-weight: bold;
                margin: 10px;
            }
            
            QLabel#statusLabel {
                color: #cccccc;
                margin: 5px;
            }
            
            QFrame#progressFrame {
                background-color: #3c3c3c;
                border: 1px solid #555555;
                border-radius: 5px;
                margin: 5px;
            }
            
            QFrame#visualizationFrame {
                background-color: #3c3c3c;
                border: 1px solid #555555;
                border-radius: 5px;
                margin: 5px;
            }
            
            QLabel#progressLabel {
                color: #ffffff;
                font-size: 11px;
            }
            
            QLabel#visualizationLabel {
                color: #888888;
                font-style: italic;
            }
        """

        main_window.setStyleSheet(stylesheet)
        self.logger.debug("Styling applied")

    def _configure_size_policies(self, main_window: QMainWindow,
    ) -> None:
        """Configure size policies for UI elements.
        
        Args:
            main_window: The main window
        """
        # Configure central widget size policy
        main_window.centralwidget.setSizePolicy(
            QSizePolicy.Policy.Preferred,
            QSizePolicy.Policy.Preferred,
        )

        # Configure title label size policy
        main_window.title_label.setSizePolicy(
            QSizePolicy.Policy.Preferred,
            QSizePolicy.Policy.Fixed,
        )

        # Configure status label size policy
        main_window.status_label.setSizePolicy(
            QSizePolicy.Policy.Preferred,
            QSizePolicy.Policy.Fixed,
        )

        # Configure progress frame size policy
        main_window.progress_frame.setSizePolicy(
            QSizePolicy.Policy.Preferred,
            QSizePolicy.Policy.Fixed,
        )

        # Configure visualization frame size policy
        main_window.visualization_frame.setSizePolicy(
            QSizePolicy.Policy.Preferred,
            QSizePolicy.Policy.Expanding,
        )

        self.logger.debug("Size policies configured")

    def update_status(self, main_window: QMainWindow, status: str,
    ) -> None:
        """Update the status label text.
        
        Args:
            main_window: The main window
            status: The status text to display
        """
        if hasattr(main_window, "status_label"):
            main_window.status_label.setText(status)
            self.logger.debug("Status updated: {status}")

    def update_progress(self, main_window: QMainWindow, progress: str,
    ) -> None:
        """Update the progress label text.
        
        Args:
            main_window: The main window
            progress: The progress text to display
        """
        if hasattr(main_window, "progress_label"):
            main_window.progress_label.setText(progress)
            self.logger.debug("Progress updated: {progress}")

    def apply_ui_state(self, main_window: QMainWindow, state: UIState,
    ) -> None:
        """Apply UI state changes to the interface.
        
        Args:
            main_window: The main window
            state: The UI state to apply
        """
        self.logger.info("Applying UI state: {state.value}")

        if state == UIState.RECORDING:
            self._apply_recording_ui_state(main_window)
        elif state == UIState.PROCESSING:
            self._apply_processing_ui_state(main_window)
        elif state == UIState.IDLE:
            self._apply_idle_ui_state(main_window)
        elif state == UIState.ERROR:
            self._apply_error_ui_state(main_window)

    def _apply_recording_ui_state(self, main_window: QMainWindow,
    ) -> None:
        """Apply recording state to UI.
        
        Args:
            main_window: The main window
        """
        self.update_status(main_window, "Recording...")

        # Add recording visual indicators
        if hasattr(main_window, "status_label"):
            main_window.status_label.setStyleSheet(
                "QLabel { color: #ff4444; font-weight: bold; }",
            )

    def _apply_processing_ui_state(self, main_window: QMainWindow,
    ) -> None:
        """Apply processing state to UI.
        
        Args:
            main_window: The main window
        """
        self.update_status(main_window, "Processing...")

        # Add processing visual indicators
        if hasattr(main_window, "status_label"):
            main_window.status_label.setStyleSheet(
                "QLabel { color: #ffaa00; font-weight: bold; }",
            )

    def _apply_idle_ui_state(self, main_window: QMainWindow,
    ) -> None:
        """Apply idle state to UI.
        
        Args:
            main_window: The main window
        """
        self.update_status(main_window, "Ready")

        # Reset visual indicators
        if hasattr(main_window, "status_label"):
            main_window.status_label.setStyleSheet(
                "QLabel { color: #cccccc; }",
            )

    def _apply_error_ui_state(self, main_window: QMainWindow,
    ) -> None:
        """Apply error state to UI.
        
        Args:
            main_window: The main window
        """
        self.update_status(main_window, "Error")

        # Add error visual indicators
        if hasattr(main_window, "status_label"):
            main_window.status_label.setStyleSheet(
                "QLabel { color: #ff0000; font-weight: bold; }",
            )