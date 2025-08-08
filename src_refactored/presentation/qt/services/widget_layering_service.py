"""Widget Layering Service for UI element z-order management (Presentation)."""

import logging
from dataclasses import dataclass

from PyQt6.QtCore import QObject, pyqtSignal
from PyQt6.QtWidgets import QWidget

from src_refactored.domain.window_management.value_objects.widget_layering import (
    LayerPriority,
    WidgetLayerConfiguration,
)


@dataclass
class WidgetLayer:
    widget: QWidget
    layer_name: str
    priority: LayerPriority
    z_order: int = 0
    is_visible: bool = True
    parent_layer: str | None = None
    description: str | None = None

    def to_domain_configuration(self,
    ) -> WidgetLayerConfiguration:
        return WidgetLayerConfiguration(
            widget_id=self.layer_name,
            priority=self.priority,
            z_order=self.z_order,
            is_always_on_top=self.priority == LayerPriority.TOP_MOST,
            parent_layer=self.parent_layer,
            metadata={"description": self.description} if self.description else None,
        )


class WidgetLayeringError(Exception):
    pass


class WidgetLayeringService(QObject):
    layer_added = pyqtSignal(str, QWidget)
    layer_removed = pyqtSignal(str)
    layer_updated = pyqtSignal(str, int)
    layers_reordered = pyqtSignal(list)
    widget_raised = pyqtSignal(str)
    widget_lowered = pyqtSignal(str)

    def __init__(self):
        super().__init__()
        self.logger = logging.getLogger(__name__)
        self._layers: dict[str, WidgetLayer] = {}
        self._layer_order: list[str] = []
        self._next_z_order = 0
        self._z_order_step = 10
        self._layer_groups: dict[str, list[str]] = {}
        self._initialize_layer_priorities()

    def _initialize_layer_priorities(self) -> None:
        try:
            self._standard_layers = {
                "background_image": LayerPriority.BACKGROUND,
                "central_widget": LayerPriority.CONTENT,
                "voice_visualizer": LayerPriority.CONTENT + 10,
                "app_logo": LayerPriority.UI_ELEMENTS,
                "app_title": LayerPriority.UI_ELEMENTS + 10,
                "message_text": LayerPriority.UI_ELEMENTS + 20,
                "progress_bar": LayerPriority.UI_ELEMENTS + 30,
                "instruction_label": LayerPriority.UI_ELEMENTS + 40,
                "settings_button": LayerPriority.CONTROLS,
                "switch_icon": LayerPriority.CONTROLS + 10,
                "hardware_label": LayerPriority.CONTROLS + 20,
                "status_bar": LayerPriority.UI_ELEMENTS + 50,
                "tooltips": LayerPriority.TOOLTIPS,
                "popups": LayerPriority.POPUPS,
            }
        except Exception as e:
            self.logger.exception(f"Failed to initialize layer priorities: {e}")

    def add_layer(self, layer_name: str, widget: QWidget,
                  priority: LayerPriority | int | None = None,
                  description: str | None = None,
                  parent_layer: str | None = None) -> bool:
        try:
            if layer_name in self._layers:
                self.logger.warning("Layer '{layer_name}' already exists, updating")
                return self.update_layer(layer_name, widget, priority, description)
            if priority is None:
                priority_obj = self._standard_layers.get(layer_name, LayerPriority.UI_ELEMENTS)
            else:
                priority_obj = priority if isinstance(priority, LayerPriority) else LayerPriority(int(priority))
            z_order = self._calculate_z_order(int(priority_obj))
            layer = WidgetLayer(
                widget=widget,
                layer_name=layer_name,
                priority=priority_obj if isinstance(priority_obj, LayerPriority) else LayerPriority(int(priority_obj)),
                z_order=z_order,
                is_visible=widget.isVisible(),
                parent_layer=parent_layer,
                description=description,
            )
            self._layers[layer_name] = layer
            self._insert_layer_in_order(layer_name)
            self._apply_z_order(layer_name)
            self.layer_added.emit(layer_name, widget)
            return True
        except Exception as e:
            self.logger.exception(f"Failed to add layer '{layer_name}': {e}")
            return False

    def update_layer(self, layer_name: str, widget: QWidget | None = None,
                    priority: LayerPriority | int | None = None,
                    description: str | None = None) -> bool:
        try:
            if layer_name not in self._layers:
                return False
            layer = self._layers[layer_name]
            if widget is not None:
                layer.widget = widget
                layer.is_visible = widget.isVisible()
            if priority is not None:
                priority_obj = priority if isinstance(priority, LayerPriority) else LayerPriority(int(priority))
                layer.priority = priority_obj
                layer.z_order = self._calculate_z_order(int(priority_obj))
                if layer_name in self._layer_order:
                    self._layer_order.remove(layer_name)
                self._insert_layer_in_order(layer_name)
            if description is not None:
                layer.description = description
            self._apply_z_order(layer_name)
            self.layer_updated.emit(layer_name, layer.z_order)
            return True
        except Exception as e:
            self.logger.exception(f"Failed to update layer '{layer_name}': {e}")
            return False

    def raise_widget(self, layer_name: str,
    ) -> bool:
        try:
            if layer_name not in self._layers:
                return False
            layer = self._layers[layer_name]
            max_z_order = self._get_max_z_order_in_priority(layer.priority)
            layer.z_order = max_z_order + self._z_order_step
            self._reorder_layers()
            self._apply_z_order(layer_name)
            self.widget_raised.emit(layer_name)
            return True
        except Exception as e:
            self.logger.exception(f"Failed to raise widget '{layer_name}': {e}")
            return False

    def lower_widget(self, layer_name: str,
    ) -> bool:
        try:
            if layer_name not in self._layers:
                return False
            layer = self._layers[layer_name]
            min_z_order = self._get_min_z_order_in_priority(layer.priority)
            layer.z_order = min_z_order - self._z_order_step
            self._reorder_layers()
            self._apply_z_order(layer_name)
            self.widget_lowered.emit(layer_name)
            return True
        except Exception as e:
            self.logger.exception(f"Failed to lower widget '{layer_name}': {e}")
            return False

    def apply_standard_layering(self) -> bool:
        try:
            standard_order = [
                "background_image",
                "central_widget",
                "voice_visualizer",
                "app_logo",
                "app_title",
                "message_text",
                "progress_bar",
                "instruction_label",
                "settings_button",
                "switch_icon",
                "hardware_label",
                "status_bar",
            ]
            for layer_name in standard_order:
                if layer_name in self._layers:
                    self.raise_widget(layer_name)
            self.layers_reordered.emit(self._layer_order.copy())
            return True
        except Exception as e:
            self.logger.exception(f"Failed to apply standard layering: {e}")
            return False

    def _calculate_z_order(self, priority: int,
    ) -> int:
        max_z_order = 0
        for layer in self._layers.values():
            if layer.priority <= priority and layer.z_order > max_z_order:
                max_z_order = layer.z_order
        return max_z_order + self._z_order_step

    def _get_max_z_order_in_priority(self, priority: int,
    ) -> int:
        max_z_order = 0
        for layer in self._layers.values():
            if int(layer.priority) == int(priority) and layer.z_order > max_z_order:
                max_z_order = layer.z_order
        return max_z_order

    def _get_min_z_order_in_priority(self, priority: int,
    ) -> int:
        min_z_order = float("inf")
        for layer in self._layers.values():
            if int(layer.priority) == int(priority) and layer.z_order < min_z_order:
                min_z_order = layer.z_order
        return int(min_z_order) if min_z_order != float("inf") else 0

    def _insert_layer_in_order(self, layer_name: str,
    ) -> None:
        if layer_name not in self._layers:
            return
        layer = self._layers[layer_name]
        insertion_index = 0
        for i, existing_layer_name in enumerate(self._layer_order):
            existing_layer = self._layers[existing_layer_name]
            if existing_layer.z_order > layer.z_order:
                insertion_index = i
                break
            insertion_index = i + 1
        self._layer_order.insert(insertion_index, layer_name)

    def _reorder_layers(self) -> None:
        self._layer_order.sort(key=lambda name: self._layers[name].z_order)

    def _apply_z_order(self, layer_name: str,
    ) -> None:
        try:
            if layer_name not in self._layers:
                return
            layer = self._layers[layer_name]
            widget = layer.widget
            if hasattr(widget, "raise_"):
                widget.raise_()
        except Exception as e:
            self.logger.exception(f"Failed to apply z-order for '{layer_name}': {e}")

    def cleanup(self) -> None:
        self._layers.clear()
        self._layer_order.clear()
        self._layer_groups.clear()
        self._next_z_order = 0

