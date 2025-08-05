"""Geometry Management Service for window and widget geometry operations.

This module provides infrastructure services for managing window geometry,
central widget sizing, and layout positioning in the WinSTT application.
"""

from dataclasses import dataclass
from typing import Protocol

from PyQt6.QtCore import QObject, QRect, QSize, pyqtSignal
from PyQt6.QtWidgets import QApplication, QMainWindow, QWidget

from logger import setup_logger
from src.domain.common.result import Result
from src_refactored.domain.system_integration.value_objects.geometry_management import (
    GeometryConfiguration,
    GeometryMode,
    WindowGeometry,
)


@dataclass
class InfrastructureWindowGeometry:
    """Infrastructure window geometry with PyQt integration."""
    domain_geometry: WindowGeometry

    def to_qrect(self) -> QRect:
        """Convert to QRect."""
        return QRect(
            self.domain_geometry.x,
            self.domain_geometry.y,
            self.domain_geometry.width,
            self.domain_geometry.height,
        )

    @classmethod
    def from_qrect(cls, rect: QRect,
    ) -> "InfrastructureWindowGeometry":
        """Create from QRect."""
        domain_geometry = WindowGeometry(
            x=rect.x(),
            y=rect.y(),
            width=rect.width(),
            height=rect.height(),
        )
        return cls(domain_geometry)

    @classmethod
    def from_widget(cls, widget: QWidget,
    ) -> "InfrastructureWindowGeometry":
        """Create from widget geometry."""
        domain_geometry = WindowGeometry(
            x=widget.x(),
            y=widget.y(),
            width=widget.width(),
            height=widget.height(),
        )
        return cls(domain_geometry)


@dataclass
class InfrastructureGeometryConfiguration:
    """Infrastructure geometry configuration with PyQt integration."""
    domain_config: GeometryConfiguration
    min_size: QSize | None = None
    max_size: QSize | None = None


class GeometryManagementServiceProtocol(Protocol):
    """Protocol for geometry management operations."""

    def get_current_geometry(self, widget: QWidget,
    ) -> WindowGeometry:
        """Get current widget geometry."""
        ...

    def set_widget_geometry(self, widget: QWidget, geometry: WindowGeometry,
    ) -> bool:
        """Set widget geometry."""
        ...

    def calculate_optimal_geometry(self,
widget: QWidget, mode: GeometryMode, reference_geometry: WindowGeometry | None = None) -> WindowGeometry:
        """Calculate optimal geometry based on mode."""
        ...


class GeometryManagementService(QObject):
    """Service for managing window and widget geometry."""

    # Signals
    geometry_changed = pyqtSignal(str, WindowGeometry)  # widget_name, new_geometry
    geometry_update_failed = pyqtSignal(str, str)  # widget_name, error_message
    central_widget_resized = pyqtSignal(int, int)  # width, height

    def __init__(self):
        super().__init__()
        self.logger = setup_logger()
        self._configurations: dict[str, GeometryConfiguration] = {}
        self._previous_geometries: dict[str, WindowGeometry] = {}

    def configure_geometry(self, widget_name: str, config: GeometryConfiguration,
    ) -> Result[None]:
        """Configure geometry management for a widget."""
        try:
            self._configurations[widget_name] = config
            self.logger.debug("Configured geometry for {widget_name}: {config.mode.value}")
            return Result.success(None)
        except Exception as e:
            error_msg = f"Failed to configure geometry for {widget_name}: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)

    def get_current_geometry(self, widget: QWidget,
    ) -> Result[WindowGeometry]:
        """Get current widget geometry."""
        try:
            geometry = WindowGeometry.from_widget(widget)
            return Result.success(geometry)
        except Exception as e:
            error_msg = f"Failed to get geometry: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)

    def set_widget_geometry(self,
    widget: QWidget, geometry: WindowGeometry, widget_name: str = "widget") -> Result[None]:
        """Set widget geometry."""
        try:
            # Store previous geometry
            current_geometry = WindowGeometry.from_widget(widget)
            self._previous_geometries[widget_name] = current_geometry

            # Apply new geometry
            widget.setGeometry(geometry.to_qrect())

            self.geometry_changed.emit(widget_name, geometry)
            self.logger.debug(f"Set geometry for {widget_name}: {geometry.width}x{geometry.height} at ({geometry.x}, {geometry.y})")
            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to set geometry for {widget_name}: {e!s}"
            self.logger.exception(error_msg)
            self.geometry_update_failed.emit(widget_name, error_msg)
            return Result.failure(error_msg)

    def set_central_widget_geometry(self,
    main_window: QMainWindow, widget_name: str = "central_widget") -> Result[None]:
        """Set central widget geometry to cover the entire window."""
        try:
            central_widget = main_window.centralWidget()
            if not central_widget:
                return Result.failure("No central widget found")

            # Set geometry to cover entire window
            geometry = WindowGeometry(0, 0, main_window.width(), main_window.height())
            result = self.set_widget_geometry(central_widget, geometry, widget_name)

            if result.is_success:
                self.central_widget_resized.emit(geometry.width, geometry.height)

            return result

        except Exception as e:
            error_msg = f"Failed to set central widget geometry: {e!s}"
            self.logger.exception(error_msg)
            self.geometry_update_failed.emit(widget_name, error_msg)
            return Result.failure(error_msg)

    def calculate_optimal_geometry(self,
        widget: QWidget, mode: GeometryMode, reference_geometry: WindowGeometry | None = None) -> Result[WindowGeometry]:
        """Calculate optimal geometry based on mode."""
        try:
            current_geometry = WindowGeometry.from_widget(widget)

            if mode == GeometryMode.PRESERVE:
                return Result.success(current_geometry)

            if mode == GeometryMode.RESTORE_PREVIOUS:
                widget_name = widget.objectName() or "widget"
                if widget_name in self._previous_geometries:
                    return Result.success(self._previous_geometries[widget_name])
                return Result.success(current_geometry)

            if mode == GeometryMode.CENTER_ON_SCREEN:
                screen = QApplication.primaryScreen()
                if screen:
                    screen_geometry = screen.geometry()
                    x = (screen_geometry.width() - current_geometry.width) // 2
                    y = (screen_geometry.height() - current_geometry.height) // 2
                    return Result.success(WindowGeometry(x, y, current_geometry.width, current_geometry.height))

            elif mode == GeometryMode.FILL_PARENT:
                parent = widget.parent()
                if isinstance(parent, QWidget):
                    return Result.success(WindowGeometry(0, 0, parent.width(), parent.height()))

            elif mode == GeometryMode.CUSTOM_POSITION and reference_geometry:
                return Result.success(reference_geometry)

            # Default case
            return Result.success(current_geometry)

        except Exception as e:
            error_msg = f"Failed to calculate optimal geometry: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)

    def apply_geometry_configuration(self, widget: QWidget, widget_name: str,
    ) -> Result[None]:
        """Apply configured geometry settings to a widget."""
        try:
            if widget_name not in self._configurations:
                return Result.failure(f"No configuration found for {widget_name}")

            config = self._configurations[widget_name]

            # Calculate optimal geometry
            geometry_result = self.calculate_optimal_geometry(
                widget, config.mode, config.target_geometry,
            )

            if not geometry_result.is_success:
                return Result.failure(geometry_result.error())

            geometry = geometry_result.value()

            # Apply size constraints
            if config.min_size:
                geometry.width = max(geometry.width, config.min_size.width())
                geometry.height = max(geometry.height, config.min_size.height())

            if config.max_size:
                geometry.width = min(geometry.width, config.max_size.width())
                geometry.height = min(geometry.height, config.max_size.height())

            # Center on screen if requested
            if config.center_on_screen:
                screen = QApplication.primaryScreen()
                if screen:
                    screen_geometry = screen.geometry()
                    geometry.x = (screen_geometry.width() - geometry.width) // 2
                    geometry.y = (screen_geometry.height() - geometry.height) // 2

            # Apply geometry
            return self.set_widget_geometry(widget, geometry, widget_name)

        except Exception as e:
            error_msg = f"Failed to apply geometry configuration for {widget_name}: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)

    def handle_resize_event(self, main_window: QMainWindow,
    ) -> Result[None]:
        """Handle window resize event to maintain widget positions."""
        try:
            # Set central widget to cover the entire window
            result = self.set_central_widget_geometry(main_window)

            if result.is_success:
                self.logger.debug("Handled resize event: {main_window.width()}x{main_window.height()\
    }")

            return result

        except Exception as e:
            error_msg = f"Failed to handle resize event: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)

    def get_screen_geometry(self) -> Result[WindowGeometry]:
        """Get primary screen geometry."""
        try:
            screen = QApplication.primaryScreen()
            if screen:
                geometry = screen.geometry()
                return Result.success(WindowGeometry.from_qrect(geometry))
            return Result.failure("No primary screen found")
        except Exception as e:
            error_msg = f"Failed to get screen geometry: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)

    @classmethod
    def create_for_main_window(cls) -> "GeometryManagementService":
        """Factory method to create service configured for main window."""
        service = cls()

        # Configure default geometry settings
        central_widget_config = GeometryConfiguration(
            mode=GeometryMode.FILL_PARENT,
            preserve_aspect_ratio=False,
        )

        service.configure_geometry("central_widget", central_widget_config)

        return service