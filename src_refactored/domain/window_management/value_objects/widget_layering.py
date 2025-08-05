"""Widget Layering Value Objects

This module contains enums and value objects related to widget layering operations,
including layer priorities, operations, and stacking management.
"""

from dataclasses import dataclass
from enum import Enum, IntEnum
from typing import Any

from src_refactored.domain.common.value_object import ValueObject


class LayerPriority(IntEnum):
    """Layer priority levels for widget stacking."""
    BACKGROUND = 0
    CONTENT = 100
    UI_ELEMENTS = 200
    CONTROLS = 300
    OVERLAYS = 400
    POPUPS = 500
    TOOLTIPS = 600
    TOP_MOST = 1000


class LayerOperation(Enum):
    """Layer operation types."""
    RAISE_TO_TOP = "raise_to_top"
    LOWER_TO_BOTTOM = "lower_to_bottom"
    RAISE_ABOVE = "raise_above"
    LOWER_BELOW = "lower_below"
    SET_LAYER = "set_layer"
    RESET_LAYERS = "reset_layers"


@dataclass(frozen=True)
class WidgetLayerConfiguration(ValueObject):
    """Widget layer configuration."""
    widget_id: str
    priority: LayerPriority
    z_order: int
    is_always_on_top: bool = False
    parent_layer: str | None = None
    metadata: dict[str, Any] | None = None

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            self.widget_id,
            self.priority,
            self.z_order,
            self.is_always_on_top,
            self.parent_layer,
            tuple(sorted(self.metadata.items())) if self.metadata else (),
        )

    def __invariants__(self) -> None:
        """Validate widget layer configuration invariants."""
        if not self.widget_id:
            msg = "Widget ID cannot be empty"
            raise ValueError(msg)
        if self.z_order < 0:
            msg = "Z-order must be non-negative"
            raise ValueError(msg)
        if self.priority not in LayerPriority:
            msg = "Invalid layer priority"
            raise ValueError(msg)

    def is_background_layer(self) -> bool:
        """Check if this is a background layer."""
        return self.priority == LayerPriority.BACKGROUND

    def is_top_most_layer(self) -> bool:
        """Check if this is a top-most layer."""
        return self.priority == LayerPriority.TOP_MOST or self.is_always_on_top

    def is_interactive_layer(self,
    ) -> bool:
        """Check if this layer contains interactive elements."""
        return self.priority in [
            LayerPriority.CONTROLS,
            LayerPriority.UI_ELEMENTS,
            LayerPriority.POPUPS,
        ]