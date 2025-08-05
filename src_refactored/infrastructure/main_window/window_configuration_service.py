"""Window Configuration Service for main window setup.

This module provides infrastructure services for configuring main window
properties including size, icon, palette, and size policy.
"""

import os

from PyQt6 import QtGui
from PyQt6.QtCore import QObject, Qt, pyqtSignal
from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import QMainWindow, QSizePolicy

from logger import setup_logger
from src.core.utils import resource_path


class WindowConfigurationError(Exception):
    """Exception raised for window configuration errors."""


class WindowConfigurationService(QObject):
    """Service for configuring main window properties."""

    # Signals
    configuration_applied = pyqtSignal(str)  # configuration_type
    configuration_failed = pyqtSignal(str)   # error_message

    def __init__(self):
        """Initialize the window configuration service."""
        super().__init__()
        self.logger = setup_logger()

        # Default configuration
        self.default_size = (400, 220)
        self.default_icon_path = "resources/Windows 1 Theta.png"
        self.is_configured = False

    def configure_window(self, main_window: QMainWindow,
                        size: tuple[int, int] | None = None,
                        icon_path: str | None = None) -> bool:
        """Configure main window with size, icon, and palette.
        
        Args:
            main_window: The main window to configure
            size: Optional window size tuple (width, height)
            icon_path: Optional custom icon path
            
        Returns:
            True if configuration successful, False otherwise
        """
        try:
            # Set object name
            main_window.setObjectName("MainWindow")
            main_window.setEnabled(True)

            # Configure size
            window_size = size or self.default_size
            if not self._configure_size(main_window, window_size):
                return False

            # Configure icon
            icon_path_to_use = icon_path or self.default_icon_path
            if not self._configure_icon(main_window, icon_path_to_use):
                return False

            # Configure size policy
            if not self._configure_size_policy(main_window):
                return False

            # Configure palette
            if not self._configure_palette(main_window):
                return False

            self.is_configured = True
            self.configuration_applied.emit("complete")
            self.logger.info("Main window configuration applied successfully")
            return True

        except Exception as e:
            error_msg = f"Failed to configure main window: {e}"
            self.logger.exception(error_msg)
            self.configuration_failed.emit(error_msg,
    )
            return False

    def _configure_size(self, main_window: QMainWindow, size: tuple[int, int]) -> bool:
        """Configure window size.
        
        Args:
            main_window: The main window to configure
            size: Window size tuple (width, height)
            
        Returns:
            True if size configuration successful, False otherwise
        """
        try:
            width, height = size
            if width <= 0 or height <= 0:
                self.logger.warning("Invalid window size: {size}")
                return False

            main_window.setFixedSize(width, height)
            self.logger.debug("Window size set to {width}x{height}")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to configure window size: {e}")
            return False

    def _configure_icon(self, main_window: QMainWindow, icon_path: str,
    ) -> bool:
        """Configure window icon.
        
        Args:
            main_window: The main window to configure
            icon_path: Path to icon file
            
        Returns:
            True if icon configuration successful, False otherwise
        """
        try:
            # Get icon path with robust path resolution
            resolved_icon_path = resource_path(icon_path)

            if not os.path.exists(resolved_icon_path):
                self.logger.warning("Icon file not found: {resolved_icon_path}")
                # Try to use default system icon as fallback
                main_window.setWindowIcon(main_window.style().standardIcon(
                    main_window.style().StandardPixmap.SP_ComputerIcon,
                ))
                return True

            # Set the window icon with the resolved path
            icon = QIcon(resolved_icon_path)
            if icon.isNull():
                self.logger.warning("Failed to load icon from: {resolved_icon_path}")
                return False

            main_window.setWindowIcon(icon)
            self.logger.debug("Window icon set from: {resolved_icon_path}")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to configure window icon: {e}")
            return False

    def _configure_size_policy(self, main_window: QMainWindow,
    ) -> bool:
        """Configure window size policy.
        
        Args:
            main_window: The main window to configure
            
        Returns:
            True if size policy configuration successful, False otherwise
        """
        try:
            size_policy = QSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
            size_policy.setHorizontalStretch(0)
            size_policy.setVerticalStretch(0)
            size_policy.setHeightForWidth(main_window.sizePolicy().hasHeightForWidth())
            main_window.setSizePolicy(size_policy)

            self.logger.debug("Window size policy configured")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to configure size policy: {e}")
            return False

    def _configure_palette(self, main_window: QMainWindow,
    ) -> bool:
        """Configure window palette with dark theme colors.
        
        Args:
            main_window: The main window to configure
            
        Returns:
            True if palette configuration successful, False otherwise
        """
        try:
            palette = QtGui.QPalette(,
    )

            # Active state colors
            self._set_palette_brush(palette, QtGui.QPalette.ColorGroup.Active,
                                  QtGui.QPalette.ColorRole.Base, (46, 52, 64))
            self._set_palette_brush(palette, QtGui.QPalette.ColorGroup.Active,
                                  QtGui.QPalette.ColorRole.Window, (20, 27, 31))

            # Inactive state colors
            self._set_palette_brush(palette, QtGui.QPalette.ColorGroup.Inactive,
                                  QtGui.QPalette.ColorRole.Base, (46, 52, 64))
            self._set_palette_brush(palette, QtGui.QPalette.ColorGroup.Inactive,
                                  QtGui.QPalette.ColorRole.Window, (20, 27, 31))

            # Disabled state colors
            self._set_palette_brush(palette, QtGui.QPalette.ColorGroup.Disabled,
                                  QtGui.QPalette.ColorRole.Base, (20, 27, 31))
            self._set_palette_brush(palette, QtGui.QPalette.ColorGroup.Disabled,
                                  QtGui.QPalette.ColorRole.Window, (20, 27, 31))

            main_window.setPalette(palette)
            self.logger.debug("Window palette configured with dark theme")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to configure palette: {e}")
            return False

    def _set_palette_brush(self, palette: QtGui.QPalette,
                          color_group: QtGui.QPalette.ColorGroup,
                          color_role: QtGui.QPalette.ColorRole,
                          rgb: tuple[int, int, int]) -> None:
        """Set palette brush with RGB color.
        
        Args:
            palette: The palette to modify
            color_group: Color group (Active, Inactive, Disabled)
            color_role: Color role (Base, Window, etc.)
            rgb: RGB color tuple
        """
        brush = QtGui.QBrush(QtGui.QColor(*rgb))
        brush.setStyle(Qt.BrushStyle.SolidPattern)
        palette.setBrush(color_group, color_role, brush)

    def update_window_size(self, main_window: QMainWindow,
                          width: int, height: int,
    ) -> bool:
        """Update window size.
        
        Args:
            main_window: The main window to update
            width: New window width
            height: New window height
            
        Returns:
            True if size update successful, False otherwise
        """
        return self._configure_size(main_window, (width, height))

    def update_window_icon(self, main_window: QMainWindow, icon_path: str,
    ) -> bool:
        """Update window icon.
        
        Args:
            main_window: The main window to update
            icon_path: Path to new icon file
            
        Returns:
            True if icon update successful, False otherwise
        """
        return self._configure_icon(main_window, icon_path)

    def get_default_size(self) -> tuple[int, int]:
        """Get default window size.
        
        Returns:
            Default window size tuple (width, height)
        """
        return self.default_size

    def set_default_size(self, width: int, height: int,
    ) -> None:
        """Set default window size.
        
        Args:
            width: Default window width
            height: Default window height
        """
        if width > 0 and height > 0:
            self.default_size = (width, height)
            self.logger.debug("Default window size updated to {width}x{height}")

    def get_default_icon_path(self) -> str:
        """Get default icon path.
        
        Returns:
            Default icon path
        """
        return self.default_icon_path

    def set_default_icon_path(self, icon_path: str,
    ) -> None:
        """Set default icon path.
        
        Args:
            icon_path: Default icon path
        """
        self.default_icon_path = icon_path
        self.logger.debug("Default icon path updated to: {icon_path}")

    def is_window_configured(self) -> bool:
        """Check if window has been configured.
        
        Returns:
            True if window is configured, False otherwise
        """
        return self.is_configured

    def reset_configuration(self) -> None:
        """Reset configuration state."""
        self.is_configured = False
        self.logger.debug("Window configuration state reset")


class WindowConfigurationManager:
    """High-level manager for window configuration operations."""

    def __init__(self):
        self._service: WindowConfigurationService | None = None

    def create_configuration_service(self) -> WindowConfigurationService:
        """Create and return window configuration service.
        
        Returns:
            WindowConfigurationService instance
        """
        self._service = WindowConfigurationService()
        return self._service

    def get_service(self) -> WindowConfigurationService | None:
        """Get current window configuration service.
        
        Returns:
            Current WindowConfigurationService or None if not created
        """
        return self._service

    def configure_main_window(self, main_window: QMainWindow,
                             size: tuple[int, int] | None = None,
                             icon_path: str | None = None) -> bool:
        """Configure main window using service.
        
        Args:
            main_window: The main window to configure
            size: Optional window size tuple (width, height)
            icon_path: Optional custom icon path
            
        Returns:
            True if configuration successful, False otherwise
            
        Raises:
            WindowConfigurationError: If service not created
        """
        if not self._service:
            msg = "Configuration service not created"
            raise WindowConfigurationError(msg,
    )

        return self._service.configure_window(main_window, size, icon_path)

    def cleanup(self) -> None:
        """Clean up window configuration manager."""
        if self._service:
            self._service.reset_configuration()
            self._service = None