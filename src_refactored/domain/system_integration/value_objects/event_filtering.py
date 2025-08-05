"""Domain value objects for event filtering operations.

This module defines domain concepts related to event filtering,
including filter scopes, event types, and filter configurations.
"""

from dataclasses import dataclass
from enum import Enum


class FilterScope(Enum):
    """Scope of event filter application."""
    WIDGET_ONLY = "widget_only"
    WINDOW_ONLY = "window_only"
    APPLICATION_WIDE = "application_wide"


class EventType(Enum):
    """Types of events to filter."""
    KEY_PRESS = "key_press"
    KEY_RELEASE = "key_release"
    MOUSE_PRESS = "mouse_press"
    MOUSE_RELEASE = "mouse_release"
    MOUSE_MOVE = "mouse_move"
    FOCUS_IN = "focus_in"
    FOCUS_OUT = "focus_out"
    CLOSE = "close"
    RESIZE = "resize"
    ALL = "all"


@dataclass
class EventFilterConfig:
    """Configuration for event filter."""
    filter_id: str
    scope: FilterScope
    event_types: list[EventType]
    enabled: bool = True
    priority: int = 0