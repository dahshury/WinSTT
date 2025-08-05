"""Widget Layering Service for UI element z-order management.

This module provides infrastructure services for managing the layering,
z-order, and stacking of UI widgets in the main window.
"""

from dataclasses import dataclass

from PyQt6.QtCore import QObject, pyqtSignal
from PyQt6.QtWidgets import QWidget

from logger import setup_logger
from src_refactored.domain.window_management.value_objects.widget_layering import (
    LayerPriority,
    WidgetLayerConfiguration,
)


@dataclass
class WidgetLayer:
    """Infrastructure widget layer with PyQt widget reference."""
    widget: QWidget
    layer_name: str
    priority: LayerPriority
    z_order: int = 0
    is_visible: bool = True
    parent_layer: str | None = None
    description: str | None = None

    def to_domain_configuration(self,
    ) -> WidgetLayerConfiguration:
        """Convert to domain layer configuration."""
        return WidgetLayerConfiguration(
            widget_id=self.layer_name,
            priority=self.priority,
            z_order=self.z_order,
            is_always_on_top=self.priority == LayerPriority.TOP_MOST,
            parent_layer=self.parent_layer,
            metadata={"description": self.description} if self.description else None,
        )


class WidgetLayeringError(Exception):
    """Exception raised for widget layering errors."""


class WidgetLayeringService(QObject):
    """Service for managing widget layering and z-order."""

    # Signals
    layer_added = pyqtSignal(str, QWidget)  # layer_name, widget
    layer_removed = pyqtSignal(str)  # layer_name
    layer_updated = pyqtSignal(str, int)  # layer_name, new_z_order
    layers_reordered = pyqtSignal(list)  # ordered_layer_names
    widget_raised = pyqtSignal(str)  # layer_name
    widget_lowered = pyqtSignal(str)  # layer_name

    def __init__(self):
        """Initialize the widget layering service."""
        super().__init__()
        self.logger = setup_logger()

        # Layer storage
        self._layers: dict[str, WidgetLayer] = {}
        self._layer_order: list[str] = []  # Ordered list of layer names

        # Z-order tracking
        self._next_z_order = 0
        self._z_order_step = 10  # Step between z-orders for insertion

        # Layer groups for batch operations
        self._layer_groups: dict[str, list[str]] = {}

        # Initialize predefined layer priorities
        self._initialize_layer_priorities()

    def _initialize_layer_priorities(self) -> None:
        """Initialize predefined layer priorities for common UI elements."""
        try:
            # Define standard layer mappings for main window elements
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

            self.logger.debug("Layer priorities initialized")

        except Exception as e:
            self.logger.exception(f"Failed to initialize layer priorities: {e}")

    def add_layer(self, layer_name: str, widget: QWidget,
                 priority: int | None = None,
                 description: str | None = None,
                 parent_layer: str | None = None) -> bool:
        """Add a widget layer.
        
        Args:
            layer_name: Unique name for the layer
            widget: Widget to add to the layer
            priority: Layer priority (uses standard priority if None)
            description: Optional description for the layer
            parent_layer: Optional parent layer name
            
        Returns:
            True if layer added successfully, False otherwise
        """
        try:
            if layer_name in self._layers:
                self.logger.warning("Layer '{layer_name}' already exists, updating")
                return self.update_layer(layer_name, widget, priority, description)

            # Determine priority
            if priority is None:
                priority = self._standard_layers.get(layer_name, LayerPriority.UI_ELEMENTS)

            # Calculate z-order based on priority and existing layers
            z_order = self._calculate_z_order(priority)

            # Create layer
            layer = WidgetLayer(
                widget=widget,
                layer_name=layer_name,
                priority=priority,
                z_order=z_order,
                is_visible=widget.isVisible()
                parent_layer=parent_layer,
                description=description,
            )

            # Add to storage
            self._layers[layer_name] = layer

            # Insert into ordered list based on z-order
            self._insert_layer_in_order(layer_name)

            # Apply z-order to widget
            self._apply_z_order(layer_name)

            self.layer_added.emit(layer_name, widget)
            self.logger.debug("Added layer '{layer_name}' with priority {priority} and
    z-order {z_order}")

            return True

        except Exception as e:
            error_msg = f"Failed to add layer '{layer_name}': {e}"
            self.logger.exception(error_msg,
    )
            return False

    def remove_layer(self, layer_name: str,
    ) -> bool:
        """Remove a widget layer.

        Args:
            layer_name: Name of the layer to remove

        Returns:
            True if layer removed successfully, False if not found
        """
        try:
            if layer_name not in self._layers:
                self.logger.warning("Layer '{layer_name}' not found")
                return False

            # Remove from storage
            del self._layers[layer_name]

            # Remove from ordered list
            if layer_name in self._layer_order:
                self._layer_order.remove(layer_name)

            # Remove from groups
            for group_layers in self._layer_groups.values():
                if layer_name in group_layers:
                    group_layers.remove(layer_name)

            self.layer_removed.emit(layer_name)
            self.logger.debug("Removed layer '{layer_name}'")

            return True

        except Exception as e:
            self.logger.exception(f"Failed to remove layer '{layer_name}': {e}")
            return False

    def update_layer(self, layer_name: str, widget: QWidget | None = None,
                    priority: int | None = None,
                    description: str | None = None) -> bool:
        """Update an existing layer.

        Args:
            layer_name: Name of the layer to update
            widget: New widget (optional)
            priority: New priority (optional)
            description: New description (optional)

        Returns:
            True if layer updated successfully, False otherwise
        """
        try:
            if layer_name not in self._layers:
                self.logger.error("Layer '{layer_name}' not found")
                return False

            layer = self._layers[layer_name]

            # Update widget if provided
            if widget is not None:
                layer.widget = widget
                layer.is_visible = widget.isVisible()

            # Update priority if provided
            if priority is not None:
                layer.priority = priority
                # Recalculate z-order
                layer.z_order = self._calculate_z_order(priority)

                # Re-insert in order
                if layer_name in self._layer_order:
                    self._layer_order.remove(layer_name)
                self._insert_layer_in_order(layer_name)

            # Update description if provided
            if description is not None:
                layer.description = description

            # Apply updated z-order
            self._apply_z_order(layer_name)

            self.layer_updated.emit(layer_name, layer.z_order)
            self.logger.debug("Updated layer '{layer_name}'")

            return True

        except Exception as e:
            self.logger.exception(f"Failed to update layer '{layer_name}': {e}")
            return False

    def raise_widget(self, layer_name: str,
    ) -> bool:
        """Raise a widget to the top of its priority group.

        Args:
            layer_name: Name of the layer to raise

        Returns:
            True if widget raised successfully, False otherwise
        """
        try:
            if layer_name not in self._layers:
                self.logger.error("Layer '{layer_name}' not found")
                return False

            layer = self._layers[layer_name]

            # Find the highest z-order in the same priority group
            max_z_order = self._get_max_z_order_in_priority(layer.priority)

            # Set z-order higher than the maximum
            layer.z_order = max_z_order + self._z_order_step

            # Re-order layers
            self._reorder_layers()

            # Apply z-order
            self._apply_z_order(layer_name)

            self.widget_raised.emit(layer_name)
            self.logger.debug("Raised widget '{layer_name}' to z-order {layer.z_order}")

            return True

        except Exception as e:
            self.logger.exception(f"Failed to raise widget '{layer_name}': {e}")
            return False

    def lower_widget(self, layer_name: str,
    ) -> bool:
        """Lower a widget to the bottom of its priority group.

        Args:
            layer_name: Name of the layer to lower

        Returns:
            True if widget lowered successfully, False otherwise
        """
        try:
            if layer_name not in self._layers:
                self.logger.error("Layer '{layer_name}' not found")
                return False

            layer = self._layers[layer_name]

            # Find the lowest z-order in the same priority group
            min_z_order = self._get_min_z_order_in_priority(layer.priority)

            # Set z-order lower than the minimum
            layer.z_order = min_z_order - self._z_order_step

            # Re-order layers
            self._reorder_layers()

            # Apply z-order
            self._apply_z_order(layer_name)

            self.widget_lowered.emit(layer_name)
            self.logger.debug("Lowered widget '{layer_name}' to z-order {layer.z_order}")

            return True

        except Exception as e:
            self.logger.exception(f"Failed to lower widget '{layer_name}': {e}")
            return False

    def raise_above(self, layer_name: str, target_layer: str,
    ) -> bool:
        """Raise a widget above another widget.

        Args:
            layer_name: Name of the layer to raise
            target_layer: Name of the target layer to raise above

        Returns:
            True if operation successful, False otherwise
        """
        try:
            if layer_name not in self._layers or target_layer not in self._layers:
                self.logger.error("One or both layers not found")
                return False

            layer = self._layers[layer_name]
            target = self._layers[target_layer]

            # Set z-order slightly above target
            layer.z_order = target.z_order + 1

            # Re-order layers
            self._reorder_layers()

            # Apply z-order
            self._apply_z_order(layer_name)

            self.logger.debug("Raised '{layer_name}' above '{target_layer}'")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to raise '{layer_name}' above '{target_layer}': {e}")
            return False

    def lower_below(self, layer_name: str, target_layer: str,
    ) -> bool:
        """Lower a widget below another widget.

        Args:
            layer_name: Name of the layer to lower
            target_layer: Name of the target layer to lower below

        Returns:
            True if operation successful, False otherwise
        """
        try:
            if layer_name not in self._layers or target_layer not in self._layers:
                self.logger.error("One or both layers not found")
                return False

            layer = self._layers[layer_name]
            target = self._layers[target_layer]

            # Set z-order slightly below target
            layer.z_order = target.z_order - 1

            # Re-order layers
            self._reorder_layers()

            # Apply z-order
            self._apply_z_order(layer_name)

            self.logger.debug("Lowered '{layer_name}' below '{target_layer}'")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to lower '{layer_name}' below '{target_layer}': {e}")
            return False

    def create_layer_group(self, group_name: str, layer_names: list[str]) -> bool:
        """Create a group of layers for batch operations.

        Args:
            group_name: Name for the layer group
            layer_names: List of layer names to include in the group

        Returns:
            True if group created successfully, False otherwise
        """
        try:
            # Validate that all layers exist
            for layer_name in layer_names:
                if layer_name not in self._layers:
                    self.logger.error("Layer '{layer_name}' not found for group '{group_name}'")
                    return False

            self._layer_groups[group_name] = layer_names.copy()
            self.logger.debug("Created layer group '{group_name}' with {len(layer_names)} layers")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to create layer group '{group_name}': {e}")
            return False

    def raise_group(self, group_name: str,
    ) -> bool:
        """Raise all widgets in a group.

        Args:
            group_name: Name of the layer group

        Returns:
            True if group raised successfully, False otherwise
        """
        try:
            if group_name not in self._layer_groups:
                self.logger.error("Layer group '{group_name}' not found")
                return False

            layer_names = self._layer_groups[group_name]

            for layer_name in layer_names:
                if layer_name in self._layers:
                    self.raise_widget(layer_name)

            self.logger.debug("Raised layer group '{group_name}'")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to raise layer group '{group_name}': {e}")
            return False

    def apply_standard_layering(self) -> bool:
        """Apply standard layering order for main window elements.

        Returns:
            True if standard layering applied successfully, False otherwise
        """
        try:
            # Define the standard raising order for main window
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

            # Apply raising order
            for layer_name in standard_order:
                if layer_name in self._layers:
                    self.raise_widget(layer_name)

            self.layers_reordered.emit(self._layer_order.copy())
            self.logger.debug("Applied standard layering order")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to apply standard layering: {e}")
            return False

    def get_layer_info(self, layer_name: str,
    ) -> WidgetLayer | None:
        """Get information about a layer.

        Args:
            layer_name: Name of the layer

        Returns:
            WidgetLayer object or None if not found
        """
        return self._layers.get(layer_name)

    def get_layer_order(self) -> list[str]:
        """Get current layer order.

        Returns:
            List of layer names in z-order (bottom to top)
        """
        return self._layer_order.copy()

    def get_layers_by_priority(self, priority: int,
    ) -> list[str]:
        """Get all layers with a specific priority.

        Args:
            priority: Priority level

        Returns:
            List of layer names with the specified priority
        """
        return [name for name, layer in self._layers.items() if layer.priority == priority]

    def _calculate_z_order(self, priority: int,
    ) -> int:
        """Calculate z-order based on priority and existing layers.

        Args:
            priority: Layer priority

        Returns:
            Calculated z-order value
        """
        # Find existing layers with same or lower priority
        max_z_order = 0
        for layer in self._layers.values():
            if layer.priority <= priority and layer.z_order > max_z_order:
                max_z_order = layer.z_order

        return max_z_order + self._z_order_step

    def _get_max_z_order_in_priority(self, priority: int,
    ) -> int:
        """Get maximum z-order within a priority group.

        Args:
            priority: Priority level

        Returns:
            Maximum z-order in the priority group
        """
        max_z_order = 0
        for layer in self._layers.values():
            if layer.priority == priority and layer.z_order > max_z_order:
                max_z_order = layer.z_order

        return max_z_order

    def _get_min_z_order_in_priority(self, priority: int,
    ) -> int:
        """Get minimum z-order within a priority group.

        Args:
            priority: Priority level

        Returns:
            Minimum z-order in the priority group
        """
        min_z_order = float("inf")
        for layer in self._layers.values():
            if layer.priority == priority and layer.z_order < min_z_order:
                min_z_order = layer.z_order

        return min_z_order if min_z_order != float("inf",
    ) else 0

    def _insert_layer_in_order(self, layer_name: str,
    ) -> None:
        """Insert layer in the ordered list based on z-order.

        Args:
            layer_name: Name of the layer to insert
        """
        if layer_name not in self._layers:
            return

        layer = self._layers[layer_name]

        # Find insertion point
        insertion_index = 0
        for i, existing_layer_name in enumerate(self._layer_order):
            existing_layer = self._layers[existing_layer_name]
            if existing_layer.z_order > layer.z_order:
                insertion_index = i
                break
            insertion_index = i + 1

        self._layer_order.insert(insertion_index, layer_name)

    def _reorder_layers(self) -> None:
        """Reorder the layer list based on current z-orders."""
        self._layer_order.sort(key=lambda name: self._layers[name].z_order)

    def _apply_z_order(self, layer_name: str,
    ) -> None:
        """Apply z-order to the widget.

        Args:
            layer_name: Name of the layer
        """
        try:
            if layer_name not in self._layers:
                return

            layer = self._layers[layer_name]
            widget = layer.widget

            # Raise the widget (PyQt6 method)
            if hasattr(widget, "raise_"):
                widget.raise_()

            # For more precise control, we could use stackUnder/stackAbove
            # but raise_() is sufficient for most cases

        except Exception as e:
            self.logger.exception(f"Failed to apply z-order for '{layer_name}': {e}")

    def get_all_layers(self) -> dict[str, WidgetLayer]:
        """Get all layers.

        Returns:
            Dictionary of layer names to WidgetLayer objects
        """
        return self._layers.copy()

    def get_all_groups(self) -> dict[str, list[str]]:
        """Get all layer groups.

        Returns:
            Dictionary of group names to layer name lists
        """
        return self._layer_groups.copy()

    def remove_group(self, group_name: str,
    ) -> bool:
        """Remove a layer group.

        Args:
            group_name: Name of the group to remove

        Returns:
            True if group removed successfully, False if not found
        """
        if group_name not in self._layer_groups:
            return False

        del self._layer_groups[group_name]
        self.logger.debug("Removed layer group '{group_name}'")
        return True

    def cleanup(self) -> None:
        """Clean up widget layering resources."""
        try:
            self._layers.clear()
            self._layer_order.clear()
            self._layer_groups.clear()
            self._next_z_order = 0

            self.logger.debug("Widget layering service cleaned up")

        except Exception as e:
            self.logger.exception(f"Failed to cleanup widget layering service: {e}")


class WidgetLayeringManager:
    """High-level manager for widget layering operations."""

    def __init__(self):
        self._service: WidgetLayeringService | None = None

    def create_layering_service(self) -> WidgetLayeringService:
        """Create and return widget layering service.

        Returns:
            WidgetLayeringService instance
        """
        self._service = WidgetLayeringService()
        return self._service

    def get_service(self) -> WidgetLayeringService | None:
        """Get current widget layering service.

        Returns:
            Current WidgetLayeringService or None if not created
        """
        return self._service

    def setup_main_window_layers(self, widgets: dict[str, QWidget]) -> bool:
        """Setup layering for main window widgets.

        Args:
            widgets: Dictionary mapping layer names to widgets

        Returns:
            True if setup successful, False otherwise

        Raises:
            WidgetLayeringError: If service not created
        """
        if not self._service:
            msg = "Widget layering service not created"
            raise WidgetLayeringError(msg,
    )

        try:
            # Add all widgets as layers
            for layer_name, widget in widgets.items():
                self._service.add_layer(layer_name, widget)

            # Apply standard layering
            self._service.apply_standard_layering()

            return True

        except Exception as e:
            msg = f"Failed to setup main window layers: {e}"
            raise WidgetLayeringError(msg)

    def create_standard_groups(self,
    ) -> bool:
        """Create standard layer groups for common operations.

        Returns:
            True if groups created successfully, False otherwise

        Raises:
            WidgetLayeringError: If service not created
        """
        if not self._service:
            msg = "Widget layering service not created"
            raise WidgetLayeringError(msg,
    )

        try:
            # UI elements group
            ui_elements = ["app_logo", "app_title", "message_text", "instruction_label"]
            self._service.create_layer_group("ui_elements", ui_elements)

            # Controls group
            controls = ["settings_button", "switch_icon", "hardware_label"]
            self._service.create_layer_group("controls", controls)

            # Background group
            background = ["background_image", "central_widget"]
            self._service.create_layer_group("background", background)

            return True

        except Exception as e:
            msg = f"Failed to create standard groups: {e}"
            raise WidgetLayeringError(msg)

    def show_visualization_mode(self,
    ) -> bool:
        """Switch to visualization mode layering.

        Returns:
            True if mode switched successfully, False otherwise

        Raises:
            WidgetLayeringError: If service not created
        """
        if not self._service:
            msg = "Widget layering service not created"
            raise WidgetLayeringError(msg)

        try:
            # Raise voice visualizer to top
            self._service.raise_widget("voice_visualizer",
    )

            # Lower UI elements
            ui_elements = ["app_logo", "app_title", "settings_button"]
            for element in ui_elements:
                if element in self._service.get_all_layers():
                    self._service.lower_widget(element)

            return True

        except Exception as e:
            msg = f"Failed to switch to visualization mode: {e}"
            raise WidgetLayeringError(msg)

    def show_normal_mode(self,
    ) -> bool:
        """Switch to normal mode layering.

        Returns:
            True if mode switched successfully, False otherwise

        Raises:
            WidgetLayeringError: If service not created
        """
        if not self._service:
            msg = "Widget layering service not created"
            raise WidgetLayeringError(msg)

        try:
            # Apply standard layering
            return self._service.apply_standard_layering()

        except Exception as e:
            msg = f"Failed to switch to normal mode: {e}"
            raise WidgetLayeringError(msg)

    def cleanup(self) -> None:
        """Clean up widget layering manager."""
        if self._service:
            self._service.cleanup(,
    )
            self._service = None