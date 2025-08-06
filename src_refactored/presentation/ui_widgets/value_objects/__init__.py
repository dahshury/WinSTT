"""UI Widgets Value Objects

This module contains value objects specific to UI widget functionality,
moved from the domain layer to maintain proper separation of concerns
in hexagonal architecture.

These value objects handle UI-specific concerns like:
- Widget dimensions and sizing
- Widget styling and appearance
- Widget events and interactions
- Widget operations and behaviors
"""

from .ui_widget_operations import (
    WidgetOperation,
    WidgetOperationResult,
    WidgetOperationType,
)
from .widget_dimensions import (
    WidgetDimensions,
    WidgetPosition,
    WidgetSize,
)
from .widget_events import (
    WidgetEvent,
    WidgetEventData,
    WidgetEventType,
)
from .widget_styling import (
    WidgetColor,
    WidgetStyle,
    WidgetTheme,
)

__all__ = [
    "WidgetColor",
    # Widget Dimensions
    "WidgetDimensions",
    # Widget Events
    "WidgetEvent",
    "WidgetEventData",
    "WidgetEventType",
    # Widget Operations
    "WidgetOperation",
    "WidgetOperationResult",
    "WidgetOperationType",
    "WidgetPosition",
    "WidgetSize",
    # Widget Styling
    "WidgetStyle",
    "WidgetTheme",
]