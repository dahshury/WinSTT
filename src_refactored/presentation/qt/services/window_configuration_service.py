"""Window Configuration Service for main window setup (Presentation)."""

import logging
import os

from PyQt6 import QtGui
from PyQt6.QtCore import QObject, Qt, pyqtSignal
from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import QMainWindow, QSizePolicy

from src_refactored.infrastructure.common.resource_service import resource_path


class WindowConfigurationError(Exception):
    """Exception raised for window configuration errors."""


class WindowConfigurationService(QObject):
    """Service for configuring main window properties."""

    configuration_applied = pyqtSignal(str)
    configuration_failed = pyqtSignal(str)

    def __init__(self):
        super().__init__()
        self.logger = logging.getLogger(__name__)
        self.default_size = (400, 220)
        self.default_icon_path = "resources/Windows 1 Theta.png"
        self.is_configured = False

    def configure_window(self, main_window: QMainWindow,
                        size: tuple[int, int] | None = None,
                        icon_path: str | None = None) -> bool:
        try:
            main_window.setObjectName("MainWindow")
            main_window.setEnabled(True)
            window_size = size or self.default_size
            if not self._configure_size(main_window, window_size):
                return False
            icon_path_to_use = icon_path or self.default_icon_path
            if not self._configure_icon(main_window, icon_path_to_use):
                return False
            if not self._configure_size_policy(main_window):
                return False
            if not self._configure_palette(main_window):
                return False
            self.is_configured = True
            self.configuration_applied.emit("complete")
            self.logger.info("Main window configuration applied successfully")
            return True
        except Exception as e:
            error_msg = f"Failed to configure main window: {e}"
            self.logger.exception(error_msg)
            self.configuration_failed.emit(error_msg)
            return False

    def _configure_size(self, main_window: QMainWindow, size: tuple[int, int]) -> bool:
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
        try:
            resolved_icon_path = resource_path(icon_path)
            if not os.path.exists(resolved_icon_path):
                self.logger.warning("Icon file not found: {resolved_icon_path}")
                main_window.setWindowIcon(main_window.style().standardIcon(
                    main_window.style().StandardPixmap.SP_ComputerIcon,
                ))
                return True
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
        try:
            palette = QtGui.QPalette()
            self._set_palette_brush(palette, QtGui.QPalette.ColorGroup.Active,
                                  QtGui.QPalette.ColorRole.Base, (46, 52, 64))
            self._set_palette_brush(palette, QtGui.QPalette.ColorGroup.Active,
                                  QtGui.QPalette.ColorRole.Window, (20, 27, 31))
            self._set_palette_brush(palette, QtGui.QPalette.ColorGroup.Inactive,
                                  QtGui.QPalette.ColorRole.Base, (46, 52, 64))
            self._set_palette_brush(palette, QtGui.QPalette.ColorGroup.Inactive,
                                  QtGui.QPalette.ColorRole.Window, (20, 27, 31))
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
        brush = QtGui.QBrush(QtGui.QColor(*rgb))
        brush.setStyle(Qt.BrushStyle.SolidPattern)
        palette.setBrush(color_group, color_role, brush)

    def update_window_size(self, main_window: QMainWindow,
                          width: int, height: int,
    ) -> bool:
        return self._configure_size(main_window, (width, height))

    def update_window_icon(self, main_window: QMainWindow, icon_path: str,
    ) -> bool:
        return self._configure_icon(main_window, icon_path)

    def get_default_size(self) -> tuple[int, int]:
        return self.default_size

    def set_default_size(self, width: int, height: int,
    ) -> None:
        if width > 0 and height > 0:
            self.default_size = (width, height)
            self.logger.debug("Default window size updated to {width}x{height}")

    def get_default_icon_path(self) -> str:
        return self.default_icon_path

    def set_default_icon_path(self, icon_path: str,
    ) -> None:
        self.default_icon_path = icon_path
        self.logger.debug("Default icon path updated to: {icon_path}")

    def is_window_configured(self) -> bool:
        return self.is_configured

    def reset_configuration(self) -> None:
        self.is_configured = False
        self.logger.debug("Window configuration state reset")

