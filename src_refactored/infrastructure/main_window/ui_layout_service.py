"""UI Layout Service for main window widget layout and positioning.

This module provides infrastructure services for creating and positioning
UI widgets in the main window including labels, buttons, progress bars,
and graphics views.
"""

from dataclasses import dataclass

import pyqtgraph as pg
from PyQt6.QtCore import QObject, QRect, QSize, Qt, pyqtSignal
from PyQt6.QtGui import QBrush, QColor, QFont, QIcon, QPalette, QPixmap
from PyQt6.QtWidgets import (
    QGraphicsOpacityEffect,
    QGraphicsView,
    QLabel,
    QProgressBar,
    QPushButton,
    QSizePolicy,
    QWidget,
)

from logger import setup_logger
from src.core.utils import resource_path


@dataclass
class WidgetGeometry:
    """Widget geometry configuration."""
    x: int
    y: int
    width: int
    height: int

    def to_qrect(self) -> QRect:
        """Convert to QRect."""
        return QRect(self.x, self.y, self.width, self.height)


@dataclass
class FontConfig:
    """Font configuration."""
    family: str
    point_size: int | None = None
    bold: bool = False
    weight: int = 50
    italic: bool = False


class UILayoutError(Exception):
    """Exception raised for UI layout errors."""


class UILayoutService(QObject):
    """Service for creating and positioning UI widgets in main window."""

    # Signals
    layout_created = pyqtSignal(str)  # widget_name
    layout_updated = pyqtSignal(str)  # widget_name
    layout_failed = pyqtSignal(str)   # error_message

    def __init__(self):
        """Initialize the UI layout service."""
        super().__init__()
        self.logger = setup_logger(,
    )
        self.created_widgets: dict[str, QWidget] = {}
        self.opacity_effects: dict[str, QGraphicsOpacityEffect] = {}

        # Default geometries
        self.default_geometries = {
            "central_widget": WidgetGeometry(0, 0, 400, 220)
            "title_label": WidgetGeometry(150, 10, 131, 31)
            "logo_label": WidgetGeometry(160, 10, 21, 21)
            "settings_button": WidgetGeometry(360, 10, 24, 24)
            "instruction_label": WidgetGeometry(17, 50, 370, 30)
            "message_label": WidgetGeometry(17, 85, 370, 30)
            "progress_bar": WidgetGeometry(60, 120, 290, 14)
            "voice_visualizer": WidgetGeometry(0, -5, 400, 51)
            "bottom_graphics_view": WidgetGeometry(0, 190, 411, 31)
            "hw_accel_label": WidgetGeometry(262, 189, 161, 31)
            "accel_switch_label": WidgetGeometry(360, 190, 31, 31)
            "header_image_label": WidgetGeometry(0, -5, 401, 51),
        }

    def create_central_widget(self, parent: QWidget,
    ) -> QWidget:
        """Create and configure central widget.
        
        Args:
            parent: Parent widget
            
        Returns:
            Configured central widget
        """
        try:
            central_widget = QWidget(parent=parent)
            central_widget.setEnabled(True)
            central_widget.setObjectName("centralwidget",
    )

            # Configure size policy
            size_policy = QSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
            size_policy.setHorizontalStretch(0)
            size_policy.setVerticalStretch(0)
            size_policy.setHeightForWidth(central_widget.sizePolicy().hasHeightForWidth())
            central_widget.setSizePolicy(size_policy)

            self.created_widgets["central_widget"] = central_widget
            self.layout_created.emit("central_widget")
            self.logger.debug("Central widget created")
            return central_widget

        except Exception as e:
            error_msg = f"Failed to create central widget: {e}"
            self.logger.exception(error_msg)
            self.layout_failed.emit(error_msg)
            raise UILayoutError(error_msg,
    )

    def create_title_label(self, parent: QWidget, text: str = "STT") -> QLabel:
        """Create and configure title label.
        
        Args:
            parent: Parent widget
            text: Title text
            
        Returns:
            Configured title label
        """
        try:
            label = QLabel(parent=parent)
            geometry = self.default_geometries["title_label"]
            label.setGeometry(geometry.to_qrect())

            # Configure font
            font = QFont()
            font.setFamily("Codec Pro ExtraBold")
            font.setPointSize(24)
            font.setBold(True)
            font.setWeight(75)
            label.setFont(font)

            # Configure properties
            label.setMouseTracking(True)
            label.setTextFormat(Qt.TextFormat.PlainText)
            label.setAlignment(Qt.AlignmentFlag.AlignCenter,
    )
            label.setStyleSheet("""QLabel {
                                    color: rgb(144, 164, 174);
                                }""")
            label.setText(text)
            label.setObjectName("WinSTT")

            # Create opacity effect
            opacity_effect = QGraphicsOpacityEffect(label)
            label.setGraphicsEffect(opacity_effect)
            self.opacity_effects["title_opacity_effect"] = opacity_effect

            self.created_widgets["title_label"] = label
            self.layout_created.emit("title_label")
            self.logger.debug("Title label created")
            return label

        except Exception as e:
            error_msg = f"Failed to create title label: {e}"
            self.logger.exception(error_msg)
            self.layout_failed.emit(error_msg)
            raise UILayoutError(error_msg,
    )

    def create_logo_label(
    self,
    parent: QWidget,
    icon_path: str = "resources/Windows 1 Theta.png") -> QLabel:
        """Create and configure logo label.
        
        Args:
            parent: Parent widget
            icon_path: Path to logo icon
            
        Returns:
            Configured logo label
        """
        try:
            label = QLabel(parent=parent)
            geometry = self.default_geometries["logo_label"]
            label.setGeometry(geometry.to_qrect())

            # Set pixmap
            resolved_path = resource_path(icon_path)
            label.setPixmap(QPixmap(resolved_path))
            label.setScaledContents(True)
            label.setAlignment(Qt.AlignmentFlag.AlignCenter)
            label.setText("")
            label.setObjectName("label_2")

            # Create opacity effect
            opacity_effect = QGraphicsOpacityEffect(label)
            label.setGraphicsEffect(opacity_effect)
            self.opacity_effects["logo_opacity_effect"] = opacity_effect

            self.created_widgets["logo_label"] = label
            self.layout_created.emit("logo_label")
            self.logger.debug("Logo label created")
            return label

        except Exception as e:
            error_msg = f"Failed to create logo label: {e}"
            self.logger.exception(error_msg)
            self.layout_failed.emit(error_msg)
            raise UILayoutError(error_msg,
    )

    def create_settings_button(
    self,
    parent: QWidget,
    icon_path: str = "resources/gear.png") -> QPushButton:
        """Create and configure settings button.
        
        Args:
            parent: Parent widget
            icon_path: Path to settings icon
            
        Returns:
            Configured settings button
        """
        try:
            button = QPushButton(parent=parent)
            geometry = self.default_geometries["settings_button"]
            button.setGeometry(geometry.to_qrect(),
    )
            button.setFixedSize(24, 24)

            # Configure icon
            resolved_path = resource_path(icon_path)
            button.setIcon(QIcon(resolved_path))
            button.setIconSize(QSize(16, 16))

            # Configure properties
            button.setToolTip("Settings")
            button.setObjectName("settingsButton")
            button.setStyleSheet("""
                QPushButton {
                    background-color: transparent;
                    border-style: outset;
                    border-radius: 3px;
                    border-width: 1px;
                    border-color: rgb(78, 106, 129)
                }
                QPushButton:hover {
                    background-color: rgba(78, 106, 129, 0.5);
                }
            """)

            # Create opacity effect
            opacity_effect = QGraphicsOpacityEffect(button)
            button.setGraphicsEffect(opacity_effect)
            self.opacity_effects["settings_opacity_effect"] = opacity_effect

            self.created_widgets["settings_button"] = button
            self.layout_created.emit("settings_button")
            self.logger.debug("Settings button created")
            return button

        except Exception as e:
            error_msg = f"Failed to create settings button: {e}"
            self.logger.exception(error_msg)
            self.layout_failed.emit(error_msg)
            raise UILayoutError(error_msg,
    )

    def create_instruction_label(self, parent: QWidget, text: str = "") -> QLabel:
        """Create and configure instruction label.
        
        Args:
            parent: Parent widget
            text: Instruction text
            
        Returns:
            Configured instruction label
        """
        try:
            label = QLabel(parent=parent)
            geometry = self.default_geometries["instruction_label"]
            label.setGeometry(geometry.to_qrect())

            # Configure font
            font = QFont()
            font.setFamily("Roboto")
            font.setPointSize(9)
            label.setFont(font)

            # Configure properties
            label.setAlignment(Qt.AlignmentFlag.AlignCenter,
    )
            label.setStyleSheet("""
                color:rgba(169, 169, 169, 1);
                font-style: italic;
            """)
            label.setText(text)
            label.setObjectName("instruction_label")

            # Create opacity effect (start invisible)
            opacity_effect = QGraphicsOpacityEffect(label)
            label.setGraphicsEffect(opacity_effect)
            opacity_effect.setOpacity(0.0)
            self.opacity_effects["instruction_opacity_effect"] = opacity_effect

            self.created_widgets["instruction_label"] = label
            self.layout_created.emit("instruction_label")
            self.logger.debug("Instruction label created")
            return label

        except Exception as e:
            error_msg = f"Failed to create instruction label: {e}"
            self.logger.exception(error_msg)
            self.layout_failed.emit(error_msg)
            raise UILayoutError(error_msg,
    )

    def create_message_label(self, parent: QWidget, text: str = "") -> QLabel:
        """Create and configure message label.
        
        Args:
            parent: Parent widget
            text: Message text
            
        Returns:
            Configured message label
        """
        try:
            label = QLabel(parent=parent)
            geometry = self.default_geometries["message_label"]
            label.setGeometry(geometry.to_qrect())

            # Configure font
            font = QFont()
            font.setFamily("Input")
            font.setPointSize(10)
            label.setFont(font)

            # Configure properties
            label.setAlignment(Qt.AlignmentFlag.AlignCenter,
    )
            label.setStyleSheet("color: rgb(144, 164, 174);")
            label.setText(text)
            label.setObjectName("label_3")

            self.created_widgets["message_label"] = label
            self.layout_created.emit("message_label")
            self.logger.debug("Message label created")
            return label

        except Exception as e:
            error_msg = f"Failed to create message label: {e}"
            self.logger.exception(error_msg)
            self.layout_failed.emit(error_msg)
            raise UILayoutError(error_msg,
    )

    def create_progress_bar(self, parent: QWidget,
    ) -> QProgressBar:
        """Create and configure progress bar.
        
        Args:
            parent: Parent widget
            
        Returns:
            Configured progress bar
        """
        try:
            progress_bar = QProgressBar(parent=parent)
            geometry = self.default_geometries["progress_bar"]
            progress_bar.setGeometry(geometry.to_qrect())

            # Configure font
            font = QFont()
            font.setFamily("Input")
            progress_bar.setFont(font)

            # Configure properties
            progress_bar.setAlignment(Qt.AlignmentFlag.AlignCenter,
    )
            progress_bar.setStyleSheet("""
                QProgressBar {
                    background-color: rgb(8, 11, 14);
                    color: rgb(144, 164, 174);
                    border-radius: 5px
                }
            """)
            progress_bar.setProperty("value", 0)
            progress_bar.setVisible(False)
            progress_bar.setObjectName("progressBar")

            self.created_widgets["progress_bar"] = progress_bar
            self.layout_created.emit("progress_bar")
            self.logger.debug("Progress bar created")
            return progress_bar

        except Exception as e:
            error_msg = f"Failed to create progress bar: {e}"
            self.logger.exception(error_msg)
            self.layout_failed.emit(error_msg)
            raise UILayoutError(error_msg,
    )

    def create_voice_visualizer(self, parent: QWidget,
    ) -> pg.PlotWidget:
        """Create and configure voice visualizer.
        
        Args:
            parent: Parent widget
            
        Returns:
            Configured voice visualizer
        """
        try:
            visualizer = pg.PlotWidget(parent=parent)
            geometry = self.default_geometries["voice_visualizer"]
            visualizer.setGeometry(geometry.to_qrect(),
    )

            # Configure properties
            visualizer.setBackground((0, 0, 0, 0))  # Transparent background
            visualizer.showAxis("left", False)
            visualizer.showAxis("bottom", False)
            visualizer.setVisible(False)  # Hidden by default
            visualizer.setObjectName("voice_visualizer")
            visualizer.setStyleSheet("border: none;")

            # Create waveform plot with red color
            waveform_plot = visualizer.plot([], [], pen=pg.mkPen(color=(189, 46, 45), width=2.5))

            # Create opacity effect
            opacity_effect = QGraphicsOpacityEffect(visualizer)
            visualizer.setGraphicsEffect(opacity_effect)
            opacity_effect.setOpacity(0.0)
            self.opacity_effects["visualizer_opacity_effect"] = opacity_effect

            # Store both visualizer and plot
            self.created_widgets["voice_visualizer"] = visualizer
            self.created_widgets["waveform_plot"] = waveform_plot
            self.layout_created.emit("voice_visualizer")
            self.logger.debug("Voice visualizer created")
            return visualizer

        except Exception as e:
            error_msg = f"Failed to create voice visualizer: {e}"
            self.logger.exception(error_msg)
            self.layout_failed.emit(error_msg)
            raise UILayoutError(error_msg,
    )

    def create_bottom_graphics_view(self, parent: QWidget,
    ) -> QGraphicsView:
        """Create and configure bottom graphics view.
        
        Args:
            parent: Parent widget
            
        Returns:
            Configured graphics view
        """
        try:
            graphics_view = QGraphicsView(parent=parent)
            geometry = self.default_geometries["bottom_graphics_view"]
            graphics_view.setGeometry(geometry.to_qrect())

            # Configure palette
            palette = QPalette(,
    )

            # Active state
            brush = QBrush(QColor(8, 11, 14))
            brush.setStyle(Qt.BrushStyle.SolidPattern)
            palette.setBrush(QPalette.ColorGroup.Active, QPalette.ColorRole.Base, brush)

            # Inactive state
            brush = QBrush(QColor(8, 11, 14))
            brush.setStyle(Qt.BrushStyle.SolidPattern)
            palette.setBrush(QPalette.ColorGroup.Inactive, QPalette.ColorRole.Base, brush)

            # Disabled state
            brush = QBrush(QColor(20, 27, 31))
            brush.setStyle(Qt.BrushStyle.SolidPattern)
            palette.setBrush(QPalette.ColorGroup.Disabled, QPalette.ColorRole.Base, brush)

            graphics_view.setPalette(palette)
            graphics_view.setObjectName("graphicsView_2")

            self.created_widgets["bottom_graphics_view"] = graphics_view
            self.layout_created.emit("bottom_graphics_view")
            self.logger.debug("Bottom graphics view created")
            return graphics_view

        except Exception as e:
            error_msg = f"Failed to create bottom graphics view: {e}"
            self.logger.exception(error_msg)
            self.layout_failed.emit(error_msg)
            raise UILayoutError(error_msg,
    )

    def create_hw_accel_label(self, parent: QWidget, text: str = "H/W Acceleration:") -> QLabel:
        """Create and configure hardware acceleration label.
        
        Args:
            parent: Parent widget
            text: Label text
            
        Returns:
            Configured label
        """
        try:
            label = QLabel(parent=parent)
            geometry = self.default_geometries["hw_accel_label"]
            label.setGeometry(geometry.to_qrect())

            # Configure font
            font = QFont()
            font.setFamily("Roboto")
            label.setFont(font,
    )

            # Configure properties
            label.setStyleSheet("""QLabel {
                                    color: rgb(144, 164, 174);
                                }""")
            label.setText(text)
            label.setObjectName("label")

            self.created_widgets["hw_accel_label"] = label
            self.layout_created.emit("hw_accel_label")
            self.logger.debug("Hardware acceleration label created")
            return label

        except Exception as e:
            error_msg = f"Failed to create hardware acceleration label: {e}"
            self.logger.exception(error_msg)
            self.layout_failed.emit(error_msg)
            raise UILayoutError(error_msg,
    )

    def create_accel_switch_label(self, parent: QWidget, is_enabled: bool = False) -> QLabel:
        """Create and configure acceleration switch label.
        
        Args:
            parent: Parent widget
            is_enabled: Whether acceleration is enabled
            
        Returns:
            Configured switch label
        """
        try:
            label = QLabel(parent=parent)
            geometry = self.default_geometries["accel_switch_label"]
            label.setGeometry(geometry.to_qrect())

            # Set switch icon based on state
            switch_on_path = resource_path("resources/switch-on.png")
            switch_off_path = resource_path("resources/switch-off.png")
            icon_path = switch_on_path if is_enabled else switch_off_path

            label.setPixmap(QPixmap(icon_path))
            label.setScaledContents(True)
            label.setText("")
            label.setObjectName("label_4")

            self.created_widgets["accel_switch_label"] = label
            self.layout_created.emit("accel_switch_label")
            self.logger.debug("Acceleration switch label created")
            return label

        except Exception as e:
            error_msg = f"Failed to create acceleration switch label: {e}"
            self.logger.exception(error_msg)
            self.layout_failed.emit(error_msg)
            raise UILayoutError(error_msg,
    )

    def create_header_image_label(
    self,
    parent: QWidget,
    image_path: str = "resources/Untitled-1.png") -> QLabel:
        """Create and configure header image label.
        
        Args:
            parent: Parent widget
            image_path: Path to header image
            
        Returns:
            Configured header image label
        """
        try:
            label = QLabel(parent=parent)
            geometry = self.default_geometries["header_image_label"]
            label.setGeometry(geometry.to_qrect())

            # Set header image
            resolved_path = resource_path(image_path)
            label.setPixmap(QPixmap(resolved_path))
            label.setScaledContents(True)
            label.setText("")
            label.setObjectName("label_5")

            self.created_widgets["header_image_label"] = label
            self.layout_created.emit("header_image_label")
            self.logger.debug("Header image label created")
            return label

        except Exception as e:
            error_msg = f"Failed to create header image label: {e}"
            self.logger.exception(error_msg)
            self.layout_failed.emit(error_msg)
            raise UILayoutError(error_msg)

    def arrange_widget_layers(self) -> None:
        """Arrange widget layers in proper z-order."""
        try:
            # Raise widgets in proper order (bottom to top,
    )
            layer_order = [
                "bottom_graphics_view",
                "hw_accel_label",
                "message_label",
                "progress_bar",
                "accel_switch_label",
                "voice_visualizer",
                "instruction_label",
                "logo_label",
                "title_label",
                "settings_button",
            ]

            for widget_name in layer_order:
                if widget_name in self.created_widgets:
                    widget = self.created_widgets[widget_name]
                    if hasattr(widget, "raise_"):
                        widget.raise_()

            self.logger.debug("Widget layers arranged")

        except Exception as e:
            error_msg = f"Failed to arrange widget layers: {e}"
            self.logger.exception(error_msg)
            self.layout_failed.emit(error_msg,
    )

    def update_widget_geometry(self, widget_name: str, geometry: WidgetGeometry,
    ) -> bool:
        """Update widget geometry.

        Args:
            widget_name: Name of widget to update
            geometry: New geometry

        Returns:
            True if update successful, False otherwise
        """
        try:
            if widget_name not in self.created_widgets:
                self.logger.warning("Widget '{widget_name}' not found")
                return False

            widget = self.created_widgets[widget_name]
            widget.setGeometry(geometry.to_qrect())

            self.layout_updated.emit(widget_name)
            self.logger.debug("Widget '{widget_name}' geometry updated")
            return True

        except Exception as e:
            error_msg = f"Failed to update widget geometry: {e}"
            self.logger.exception(error_msg)
            self.layout_failed.emit(error_msg,
    )
            return False

    def get_widget(self, widget_name: str,
    ) -> QWidget | None:
        """Get created widget by name.

        Args:
            widget_name: Name of widget

        Returns:
            Widget instance or None if not found
        """
        return self.created_widgets.get(widget_name)

    def get_opacity_effect(self, effect_name: str,
    ) -> QGraphicsOpacityEffect | None:
        """Get opacity effect by name.

        Args:
            effect_name: Name of opacity effect

        Returns:
            Opacity effect or None if not found
        """
        return self.opacity_effects.get(effect_name)

    def get_created_widgets(self) -> dict[str, QWidget]:
        """Get all created widgets.

        Returns:
            Dictionary of widget names to widget instances
        """
        return self.created_widgets.copy()

    def clear_widgets(self) -> None:
        """Clear all created widgets and effects."""
        self.created_widgets.clear()
        self.opacity_effects.clear()
        self.logger.debug("All widgets and effects cleared")


class UILayoutManager:
    """High-level manager for UI layout operations."""

    def __init__(self):
        self._service: UILayoutService | None = None

    def create_layout_service(self) -> UILayoutService:
        """Create and return UI layout service.

        Returns:
            UILayoutService instance
        """
        self._service = UILayoutService()
        return self._service

    def get_service(self) -> UILayoutService | None:
        """Get current UI layout service.

        Returns:
            Current UILayoutService or None if not created
        """
        return self._service

    def setup_complete_layout(self, parent: QWidget,
                             title_text: str = "STT",
                             instruction_text: str = "",
                             hw_accel_enabled: bool = False,
    ) -> dict[str, QWidget]:
        """Setup complete UI layout with all widgets.

        Args:
            parent: Parent widget
            title_text: Title text
            instruction_text: Instruction text
            hw_accel_enabled: Hardware acceleration state

        Returns:
            Dictionary of created widgets

        Raises:
            UILayoutError: If service not created
        """
        if not self._service:
            msg = "Layout service not created"
            raise UILayoutError(msg)

        # Create all widgets
        widgets = {}
        widgets["central_widget"] = self._service.create_central_widget(parent)
widgets["header_image_label"] = (
    self._service.create_header_image_label(widgets["central_widget"],)
    )
widgets["title_label"] = (
    self._service.create_title_label(widgets["central_widget"], title_text))
        widgets["logo_label"] = self._service.create_logo_label(widgets["central_widget"])
        widgets["settings_button"] = self._service.create_settings_button(widgets["central_widget"])
widgets["instruction_label"] = (
    self._service.create_instruction_label(widgets["central_widget"],)
        instruction_text)
        widgets["message_label"] = self._service.create_message_label(widgets["central_widget"])
        widgets["progress_bar"] = self._service.create_progress_bar(widgets["central_widget"])
widgets["voice_visualizer"] = (
    self._service.create_voice_visualizer(widgets["central_widget"]))
widgets["bottom_graphics_view"] = (
    self._service.create_bottom_graphics_view(widgets["central_widget"]))
        widgets["hw_accel_label"] = self._service.create_hw_accel_label(widgets["central_widget"])
widgets["accel_switch_label"] = (
    self._service.create_accel_switch_label(widgets["central_widget"],)
        hw_accel_enabled)

        # Arrange layers
        self._service.arrange_widget_layers()

        return widgets

    def cleanup(self) -> None:
        """Clean up UI layout manager."""
        if self._service:
            self._service.clear_widgets()
            self._service = None