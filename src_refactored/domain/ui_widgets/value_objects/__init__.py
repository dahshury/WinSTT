"""UI Widgets domain value objects."""

from .widget_dimensions import WidgetDimensions
from .widget_events import EventType
from .widget_styling import WidgetStyling

__all__ = [
    "EventType",
    "WidgetDimensions",
    "WidgetStyling",
]