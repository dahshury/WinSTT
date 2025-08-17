"""UI layout entity.

This module contains the UILayout entity that manages UI layout coordination
and widget positioning business rules.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from src.domain.common.entity import Entity
from src.domain.common.result import Result
from src.domain.main_window.value_objects.z_order_level import ZOrderLevel


class LayoutType(Enum):
    """Layout type enumeration."""
    ABSOLUTE = "absolute"
    GRID = "grid"
    VERTICAL = "vertical"
    HORIZONTAL = "horizontal"
    OVERLAY = "overlay"


class WidgetAlignment(Enum):
    """Widget alignment enumeration."""
    LEFT = "left"
    RIGHT = "right"
    CENTER = "center"
    TOP = "top"
    BOTTOM = "bottom"
    MIDDLE = "middle"


class WidgetVisibility(Enum):
    """Widget visibility enumeration."""
    VISIBLE = "visible"
    HIDDEN = "hidden"
    COLLAPSED = "collapsed"


@dataclass
class WidgetGeometry:
    """Widget geometry data."""
    x: int
    y: int
    width: int
    height: int

    def __post_init__(self) -> None:
        """Validate geometry."""
        if self.width <= 0 or self.height <= 0:
            msg = "Width and height must be positive"
            raise ValueError(msg)

    @property
    def area(self) -> int:
        """Calculate widget area."""
        return self.width * self.height

    @property
    def center_x(self) -> int:
        """Get center X coordinate."""
        return self.x + self.width // 2

    @property
    def center_y(self,
    ) -> int:
        """Get center Y coordinate."""
        return self.y + self.height // 2

    def contains_point(self, x: int, y: int,
    ) -> bool:
        """Check if point is within widget bounds."""
        return (self.x <= x <= self.x + self.width and
                self.y <= y <= self.y + self.height)

    def overlaps_with(self, other: WidgetGeometry,
    ) -> bool:
        """Check if this geometry overlaps with another."""
        return not (self.x + self.width <= other.x or
                   other.x + other.width <= self.x or
                   self.y + self.height <= other.y or
                   other.y + other.height <= self.y)


@dataclass
class WidgetProperties:
    """Widget properties data."""
    name: str
    geometry: WidgetGeometry
    z_order: ZOrderLevel
    visibility: WidgetVisibility = WidgetVisibility.VISIBLE
    alignment: WidgetAlignment | None = None
    parent: str | None = None
    children: list[str] = field(default_factory=list)

    def __post_init__(self,
    ) -> None:
        """Initialize children list."""
        if self.children is None:
            self.children = []

    def add_child(self, child_name: str,
    ) -> None:
        """Add child widget."""
        if child_name not in self.children:
            self.children.append(child_name)

    def remove_child(self, child_name: str,
    ) -> None:
        """Remove child widget."""
        if child_name in self.children:
            self.children.remove(child_name)


class UILayout(Entity):
    """UI layout entity.
    
    Manages UI layout coordination and widget positioning business rules.
    """

    def __init__(
        self,
        layout_id: str,
        layout_type: LayoutType = LayoutType.ABSOLUTE,
        container_width: int = 400,
        container_height: int = 220,
    ):
        super().__init__(layout_id)
        self._layout_type = layout_type
        self._container_width = container_width
        self._container_height = container_height
        self._widgets: dict[str, WidgetProperties] = {}
        self._z_order_stack: list[str] = []
        self._is_initialized = False
        self.validate()

    @classmethod
    def create_default(cls) -> Result[UILayout]:
        """Create default UI layout for WinSTT."""
        try:
            layout = cls(
                layout_id="main_window_layout",
                layout_type=LayoutType.ABSOLUTE,
                container_width=400,
                container_height=220,
            )

            # Add default widgets with their geometries
            default_widgets = [
                ("central_widget", WidgetGeometry(0, 0, 400, 220), ZOrderLevel.from_value(0)),
                ("header_background", WidgetGeometry(0, -5, 401, 51), ZOrderLevel.from_value(1)),
                ("bottom_status_bar", WidgetGeometry(0, 190, 411, 31), ZOrderLevel.from_value(2)),
                ("logo_label", WidgetGeometry(160, 10, 21, 21), ZOrderLevel.from_value(10)),
                ("title_label", WidgetGeometry(150, 10, 131, 31), ZOrderLevel.from_value(11)),
                ("settings_button", WidgetGeometry(360, 10, 24, 24), ZOrderLevel.from_value(12)),
                ("instruction_label", WidgetGeometry(17, 50, 370, 30), ZOrderLevel.from_value(8)),
                ("message_label", WidgetGeometry(17, 85, 370, 30), ZOrderLevel.from_value(6)),
                ("progress_bar", WidgetGeometry(60, 120, 290, 14), ZOrderLevel.from_value(7)),
                ("voice_visualizer", WidgetGeometry(0, -5, 400, 51), ZOrderLevel.from_value(9)),
                ("hw_accel_label", WidgetGeometry(262, 189, 161, 31), ZOrderLevel.from_value(3)),
                ("hw_accel_switch", WidgetGeometry(360, 190, 31, 31), ZOrderLevel.from_value(4)),
            ]

            for widget_name, geometry, z_order in default_widgets:
                widget_result = layout.add_widget(widget_name, geometry, z_order)
                if not widget_result.is_success:
                    return Result.failure(f"Failed to add widget {widget_name}: {widget_result.error}")

            return Result.success(layout)
        except Exception as e:
            return Result.failure(f"Failed to create default layout: {e!s}")

    def initialize(self) -> Result[None]:
        """Initialize the UI layout."""
        if self._is_initialized:
            return Result.failure("Layout is already initialized")

        # Validate all widgets have valid geometries
        for widget_name, widget in self._widgets.items():
            if not self._is_geometry_valid(widget.geometry):
                return Result.failure(f"Invalid geometry for widget {widget_name}")

        # Sort z-order stack
        self._update_z_order_stack()

        self._is_initialized = True
        self.mark_as_updated()
        return Result.success(None)

    def add_widget(
        self,
        name: str,
        geometry: WidgetGeometry,
        z_order: ZOrderLevel,
        visibility: WidgetVisibility = WidgetVisibility.VISIBLE,
        alignment: WidgetAlignment | None = None,
        parent: str | None = None,
    ) -> Result[None]:
        """Add widget to layout."""
        if not name or not name.strip():
            return Result.failure("Widget name cannot be empty")

        if name in self._widgets:
            return Result.failure(f"Widget {name} already exists")

        if not self._is_geometry_valid(geometry):
            return Result.failure("Widget geometry is outside container bounds")

        # Validate parent exists if specified
        if parent and parent not in self._widgets:
            return Result.failure(f"Parent widget {parent} does not exist")

        widget = WidgetProperties(
            name=name,
            geometry=geometry,
            z_order=z_order,
            visibility=visibility,
            alignment=alignment,
            parent=parent,
        )

        self._widgets[name] = widget

        # Add to parent's children if parent specified
        if parent:
            self._widgets[parent].add_child(name)

        # Update z-order stack
        self._update_z_order_stack()

        self.mark_as_updated()
        return Result.success(None)

    def remove_widget(self, name: str,
    ) -> Result[None]:
        """Remove widget from layout."""
        if name not in self._widgets:
            return Result.failure(f"Widget {name} does not exist")

        widget = self._widgets[name]

        # Remove from parent's children
        if widget.parent and widget.parent in self._widgets:
            self._widgets[widget.parent].remove_child(name)

        # Remove all children
        for child_name in widget.children.copy():
            child_result = self.remove_widget(child_name)
            if not child_result.is_success:
                return Result.failure(f"Failed to remove child widget {child_name}: {child_result.error}")

        # Remove from widgets and z-order stack
        del self._widgets[name]
        if name in self._z_order_stack:
            self._z_order_stack.remove(name)

        self.mark_as_updated()
        return Result.success(None)

    def update_widget_geometry(self, name: str, geometry: WidgetGeometry,
    ) -> Result[None]:
        """Update widget geometry."""
        if name not in self._widgets:
            return Result.failure(f"Widget {name} does not exist")

        if not self._is_geometry_valid(geometry):
            return Result.failure("Widget geometry is outside container bounds")

        self._widgets[name].geometry = geometry
        self.mark_as_updated()
        return Result.success(None)

    def update_widget_z_order(self, name: str, z_order: ZOrderLevel,
    ) -> Result[None]:
        """Update widget z-order."""
        if name not in self._widgets:
            return Result.failure(f"Widget {name} does not exist")

        self._widgets[name].z_order = z_order
        self._update_z_order_stack()
        self.mark_as_updated()
        return Result.success(None)

    def set_widget_visibility(self, name: str, visibility: WidgetVisibility,
    ) -> Result[None]:
        """Set widget visibility."""
        if name not in self._widgets:
            return Result.failure(f"Widget {name} does not exist")

        self._widgets[name].visibility = visibility
        self.mark_as_updated()
        return Result.success(None)

    def raise_widget(self, name: str,
    ) -> Result[None]:
        """Raise widget to top of z-order."""
        if name not in self._widgets:
            return Result.failure(f"Widget {name} does not exist")

        if name in self._z_order_stack:
            self._z_order_stack.remove(name)
        self._z_order_stack.append(name)

        # Update z-order value
        max_z = max((w.z_order.value for w in self._widgets.values()), default=0)
        new_z_order = ZOrderLevel.from_value(max_z + 1)
        self._widgets[name].z_order = new_z_order

        self.mark_as_updated()
        return Result.success(None)

    def get_widget_at_position(self, x: int, y: int,
    ) -> str | None:
        """Get topmost widget at position."""
        # Check widgets in reverse z-order (top to bottom)
        for widget_name in reversed(self._z_order_stack):
            widget = self._widgets[widget_name]
            if (widget.visibility == WidgetVisibility.VISIBLE and
                widget.geometry.contains_point(x, y)):
                return widget_name
        return None

    def get_overlapping_widgets(self, geometry: WidgetGeometry,
    ) -> list[str]:
        """Get widgets that overlap with given geometry."""
        overlapping = []
        for name, widget in self._widgets.items():
            if widget.geometry.overlaps_with(geometry):
                overlapping.append(name)
        return overlapping

    def _is_geometry_valid(self, geometry: WidgetGeometry,
    ) -> bool:
        """Check if geometry is within container bounds."""
        # Allow some widgets to extend beyond container (like header background)
        return (geometry.x >= -50 and geometry.y >= -50 and
                geometry.x + geometry.width <= self._container_width + 50 and
                geometry.y + geometry.height <= self._container_height + 50)

    def _update_z_order_stack(self) -> None:
        """Update z-order stack based on widget z-order values."""
        self._z_order_stack = sorted(
            self._widgets.keys(),
            key=lambda name: self._widgets[name].z_order.value,
        )

    # Properties
    @property
    def layout_type(self) -> LayoutType:
        """Get layout type."""
        return self._layout_type

    @property
    def container_size(self) -> tuple[int, int]:
        """Get container size."""
        return (self._container_width, self._container_height)

    @property
    def widget_count(self) -> int:
        """Get number of widgets."""
        return len(self._widgets)

    @property
    def widget_names(self) -> list[str]:
        """Get list of widget names."""
        return list(self._widgets.keys())

    @property
    def z_order_stack(self) -> list[str]:
        """Get z-order stack (bottom to top)."""
        return self._z_order_stack.copy()

    @property
    def is_initialized(self) -> bool:
        """Check if layout is initialized."""
        return self._is_initialized

    def get_widget(self, name: str,
    ) -> WidgetProperties | None:
        """Get widget properties by name."""
        return self._widgets.get(name)

    def __invariants__(self) -> None:
        """Validate UI layout invariants."""
        if self._container_width <= 0 or self._container_height <= 0:
            msg = "Container dimensions must be positive"
            raise ValueError(msg)
        if not isinstance(self._layout_type, LayoutType):
            msg = "Invalid layout type"
            raise ValueError(msg)
        if not isinstance(self._widgets, dict):
            msg = "Widgets must be a dictionary"
            raise ValueError(msg)
        if not isinstance(self._z_order_stack, list):
            msg = "Z-order stack must be a list"
            raise ValueError(msg)