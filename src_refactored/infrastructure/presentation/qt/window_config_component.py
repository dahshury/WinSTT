"""Window Configuration Component for main window configuration.

This module provides window configuration functionality following the
hexagonal architecture pattern.
"""

import logging

from PyQt6.QtCore import QSize, Qt
from PyQt6.QtGui import QColor, QIcon, QPalette
from PyQt6.QtWidgets import QMainWindow, QSizePolicy

from src_refactored.domain.ui_coordination.value_objects.ui_state import UIState
from src_refactored.infrastructure.main_window.window_configuration_service import (
    WindowConfigurationService,
)
from src_refactored.infrastructure.system.resource_path_service import ResourcePathService


class WindowConfigComponent:
    """Component for configuring main window properties.
    
    This component handles window-specific configuration including
    size, icon, palette, and behavior settings.
    """

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.window_config_service = WindowConfigurationService()
        self.resource_service = ResourcePathService()

    def configure_window(self, main_window: QMainWindow,
    ) -> None:
        """Configure the main window properties.
        
        Args:
            main_window: The main window to configure
        """
        self.logger.info("🏗️ Configuring window properties...")

        # Set basic window properties
        self._set_window_properties(main_window)

        # Configure window appearance
        self._configure_window_appearance(main_window)

        # Set window behavior
        self._configure_window_behavior(main_window)

        # Apply window policies
        self._apply_window_policies(main_window)

        self.logger.info("✅ Window configuration complete")

    def _set_window_properties(self, main_window: QMainWindow,
    ) -> None:
        """Set basic window properties.
        
        Args:
            main_window: The main window to configure
        """
        # Set window title
        main_window.setWindowTitle("WinSTT - Speech to Text")

        # Set fixed window size (400x300 as per original)
        main_window.setFixedSize(400, 300)

        # Set minimum and maximum sizes
        main_window.setMinimumSize(QSize(400, 300))
        main_window.setMaximumSize(QSize(400, 300))

        # Set object name for styling
        main_window.setObjectName("MainWindow")

        self.logger.debug("Basic window properties set")

    def _configure_window_appearance(self, main_window: QMainWindow,
    ) -> None:
        """Configure window appearance including icon and palette.
        
        Args:
            main_window: The main window to configure
        """
        # Set window icon
        self._set_window_icon(main_window)

        # Configure color palette
        self._configure_color_palette(main_window)

        # Apply window styling
        self._apply_window_styling(main_window)

    def _set_window_icon(self, main_window: QMainWindow,
    ) -> None:
        """Set the window icon.
        
        Args:
            main_window: The main window to configure
        """
        try:
            icon_path = self.resource_service.get_resource_path("icon.ico")
            if icon_path and icon_path.exists():
                icon = QIcon(str(icon_path))
                main_window.setWindowIcon(icon)
                self.logger.debug("Window icon set: {icon_path}",
    )
            else:
                self.logger.warning("Window icon not found, using default")
                # Set a default icon if available
                main_window.setWindowIcon(main_window.style().standardIcon(
                    main_window.style().StandardPixmap.SP_ComputerIcon,
                ))
        except Exception as e:
            self.logger.exception(f"Failed to set window icon: {e}")

    def _configure_color_palette(self, main_window: QMainWindow,
    ) -> None:
        """Configure the window color palette for dark theme.
        
        Args:
            main_window: The main window to configure
        """
        try:
            palette = QPalette(,
    )

            # Dark theme colors
            palette.setColor(QPalette.ColorRole.Window, QColor(53, 53, 53))
            palette.setColor(QPalette.ColorRole.WindowText, QColor(255, 255, 255))
            palette.setColor(QPalette.ColorRole.Base, QColor(25, 25, 25))
            palette.setColor(QPalette.ColorRole.AlternateBase, QColor(53, 53, 53))
            palette.setColor(QPalette.ColorRole.ToolTipBase, QColor(0, 0, 0))
            palette.setColor(QPalette.ColorRole.ToolTipText, QColor(255, 255, 255))
            palette.setColor(QPalette.ColorRole.Text, QColor(255, 255, 255))
            palette.setColor(QPalette.ColorRole.Button, QColor(53, 53, 53))
            palette.setColor(QPalette.ColorRole.ButtonText, QColor(255, 255, 255))
            palette.setColor(QPalette.ColorRole.BrightText, QColor(255, 0, 0))
            palette.setColor(QPalette.ColorRole.Link, QColor(42, 130, 218))
            palette.setColor(QPalette.ColorRole.Highlight, QColor(42, 130, 218))
            palette.setColor(QPalette.ColorRole.HighlightedText, QColor(0, 0, 0))

            main_window.setPalette(palette)
            self.logger.debug("Dark theme palette configured")

        except Exception as e:
            self.logger.exception(f"Failed to configure palette: {e}")

    def _apply_window_styling(self, main_window: QMainWindow,
    ) -> None:
        """Apply custom styling to the window.
        
        Args:
            main_window: The main window to configure
        """
        # Base window styling
        base_style = """
            QMainWindow {
                background-color: #2b2b2b;
                color: #ffffff;
                border: none;
            }
            
            QMainWindow::separator {
                background-color: #555555;
                width: 1px;
                height: 1px;
            }
        """

        main_window.setStyleSheet(base_style)
        self.logger.debug("Window styling applied")

    def _configure_window_behavior(self, main_window: QMainWindow,
    ) -> None:
        """Configure window behavior and flags.
        
        Args:
            main_window: The main window to configure
        """
        # Set window flags
        flags = main_window.windowFlags()

        # Remove maximize button (since we have fixed size)
        flags &= ~Qt.WindowType.WindowMaximizeButtonHint

        # Ensure minimize and close buttons are available
        flags |= Qt.WindowType.WindowMinimizeButtonHint
        flags |= Qt.WindowType.WindowCloseButtonHint

        # Set the flags
        main_window.setWindowFlags(flags)

        # Configure window attributes
        main_window.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, False)

        self.logger.debug("Window behavior configured")

    def _apply_window_policies(self, main_window: QMainWindow,
    ) -> None:
        """Apply size and focus policies.
        
        Args:
            main_window: The main window to configure
        """
        # Set size policy
        main_window.setSizePolicy(
            QSizePolicy.Policy.Fixed,
            QSizePolicy.Policy.Fixed,
        )

        # Set focus policy
        main_window.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

        self.logger.debug("Window policies applied")

    def apply_state_styling(self, main_window: QMainWindow, state: UIState,
    ) -> None:
        """Apply state-specific styling to the window.
        
        Args:
            main_window: The main window to configure
            state: The UI state to apply
        """
        self.logger.info("Applying window state styling: {state.value}")

        # Get current stylesheet
        current_style = main_window.styleSheet()

        # Remove any existing state styling
        current_style = self._remove_state_styling(current_style)

        # Add new state styling
        if state == UIState.RECORDING:
            state_style = """
                QMainWindow {
                    border: 2px solid #ff4444;
                    border-radius: 3px;
                }
            """
        elif state == UIState.PROCESSING:
            state_style = """
                QMainWindow {
                    border: 2px solid #ffaa00;
                    border-radius: 3px;
                }
            """
        elif state == UIState.ERROR:
            state_style = """
                QMainWindow {
                    border: 2px solid #ff0000;
                    border-radius: 3px;
                }
            """
        else:  # IDLE or default
            state_style = """
                QMainWindow {
                    border: 1px solid #555555;
                    border-radius: 3px;
                }
            """

        # Apply the combined styling
        main_window.setStyleSheet(current_style + state_style,
    )

    def _remove_state_styling(self, stylesheet: str,
    ) -> str:
        """Remove existing state-specific styling from stylesheet.
        
        Args:
            stylesheet: The current stylesheet
            
        Returns:
            The stylesheet with state styling removed
        """
        # Remove border styling that might be state-specific
        lines = stylesheet.split("\n")
        filtered_lines = []

        skip_block = False
        for line in lines:
            if "QMainWindow {" in line and
    ("border:" in stylesheet or "border-radius:" in stylesheet):
                skip_block = True
                continue
            if skip_block and "}" in line:
                skip_block = False
                continue
            if not skip_block:
                filtered_lines.append(line)

        return "\n".join(filtered_lines,
    )

    def set_window_opacity(self, main_window: QMainWindow, opacity: float,
    ) -> None:
        """Set window opacity level.

        Args:
            main_window: The main window to configure
            opacity: Opacity value between 0.0 and 1.0
        """
        # Clamp opacity value
        opacity = max(0.0, min(1.0, opacity))

        main_window.setWindowOpacity(opacity)
        self.logger.debug("Window opacity set to {opacity}")

    def toggle_always_on_top(self, main_window: QMainWindow, enabled: bool,
    ) -> None:
        """Toggle always on top behavior.

        Args:
            main_window: The main window to configure
            enabled: Whether to enable always on top
        """
        flags = main_window.windowFlags()

        if enabled:
            flags |= Qt.WindowType.WindowStaysOnTopHint
        else:
            flags &= ~Qt.WindowType.WindowStaysOnTopHint

        main_window.setWindowFlags(flags)
        main_window.show()  # Required after changing window flags

        self.logger.debug("Always on top {'enabled' if enabled else 'disabled'}")

    def center_window(self, main_window: QMainWindow,
    ) -> None:
        """Center the window on the screen.

        Args:
            main_window: The main window to center
        """
        try:
            # Get screen geometry
            screen = main_window.screen()
            if screen:
                screen_geometry = screen.availableGeometry()
                window_geometry = main_window.frameGeometry()

                # Calculate center position
                center_point = screen_geometry.center()
                window_geometry.moveCenter(center_point)

                # Move window to center
                main_window.move(window_geometry.topLeft())

                self.logger.debug("Window centered on screen")
        except Exception as e:
            self.logger.exception(f"Failed to center window: {e}",
    )