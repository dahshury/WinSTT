"""UI widget event domain value objects.

This module contains domain concepts related to widget event management
that are independent of infrastructure concerns.
"""

from enum import Enum


class EventType(Enum):
    """Enumeration of supported widget event types for domain operations."""
    MOUSE_PRESS = "mouse_press"
    MOUSE_RELEASE = "mouse_release"
    PAINT = "paint"
    KEY_PRESS = "key_press"
    KEY_RELEASE = "key_release"
    DRAG_ENTER = "drag_enter"
    DRAG_LEAVE = "drag_leave"
    CLOSE = "close"
    SHOW = "show"