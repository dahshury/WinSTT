"""Widget events value objects for UI widgets domain."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from src_refactored.domain.common.value_object import ValueObject


class WidgetEventType(Enum):
    """Types of widget events."""
    CLICK = "click"
    DOUBLE_CLICK = "double_click"
    RIGHT_CLICK = "right_click"
    HOVER_ENTER = "hover_enter"
    HOVER_LEAVE = "hover_leave"
    FOCUS_IN = "focus_in"
    FOCUS_OUT = "focus_out"
    KEY_PRESS = "key_press"
    KEY_RELEASE = "key_release"
    TEXT_CHANGED = "text_changed"
    VALUE_CHANGED = "value_changed"
    SELECTION_CHANGED = "selection_changed"
    RESIZE = "resize"
    MOVE = "move"
    DRAG_START = "drag_start"
    DRAG_END = "drag_end"
    DROP = "drop"
    CUSTOM = "custom"


@dataclass(frozen=True)
class WidgetEvent(ValueObject):
    """Represents a widget event."""
    
    event_type: WidgetEventType
    widget_id: str
    timestamp: float
    data: dict[str, Any] | None = None
    propagate: bool = True
    handled: bool = False
    
    def __post_init__(self) -> None:
        """Validate widget event."""
        if not isinstance(self.event_type, WidgetEventType):
            msg = "event_type must be a WidgetEventType"
            raise ValueError(msg)
        
        if not self.widget_id or not isinstance(self.widget_id, str):
            msg = "widget_id must be a non-empty string"
            raise ValueError(msg)
        
        if self.timestamp <= 0:
            msg = "timestamp must be positive"
            raise ValueError(msg)
        
        if self.data is not None and not isinstance(self.data, dict):
            msg = "data must be a dictionary or None"
            raise ValueError(msg)
    
    def with_data(self, **kwargs: Any) -> WidgetEvent:
        """Create a new event with additional data."""
        current_data = self.data or {}
        new_data = {**current_data, **kwargs}
        
        return WidgetEvent(
            event_type=self.event_type,
            widget_id=self.widget_id,
            timestamp=self.timestamp,
            data=new_data,
            propagate=self.propagate,
            handled=self.handled,
        )
    
    def mark_handled(self) -> WidgetEvent:
        """Create a new event marked as handled."""
        return WidgetEvent(
            event_type=self.event_type,
            widget_id=self.widget_id,
            timestamp=self.timestamp,
            data=self.data,
            propagate=self.propagate,
            handled=True,
        )
    
    def stop_propagation(self) -> WidgetEvent:
        """Create a new event with propagation stopped."""
        return WidgetEvent(
            event_type=self.event_type,
            widget_id=self.widget_id,
            timestamp=self.timestamp,
            data=self.data,
            propagate=False,
            handled=self.handled,
        )
    
    @classmethod
    def click(cls, widget_id: str, timestamp: float, **data: Any) -> WidgetEvent:
        """Create a click event."""
        return cls(
            event_type=WidgetEventType.CLICK,
            widget_id=widget_id,
            timestamp=timestamp,
            data=data if data else None,
        )
    
    @classmethod
    def text_changed(cls, widget_id: str, timestamp: float, text: str) -> WidgetEvent:
        """Create a text changed event."""
        return cls(
            event_type=WidgetEventType.TEXT_CHANGED,
            widget_id=widget_id,
            timestamp=timestamp,
            data={"text": text},
        )
    
    @classmethod
    def value_changed(cls, widget_id: str, timestamp: float, value: Any) -> WidgetEvent:
        """Create a value changed event."""
        return cls(
            event_type=WidgetEventType.VALUE_CHANGED,
            widget_id=widget_id,
            timestamp=timestamp,
            data={"value": value},
        )


@dataclass(frozen=True)
class WidgetEventData(ValueObject):
    """Data payload for widget events."""
    
    key: str
    value: Any
    event_source: str = ""
    
    def __post_init__(self) -> None:
        """Validate event data."""
        if not self.key or not isinstance(self.key, str):
            msg = "key must be a non-empty string"
            raise ValueError(msg)
    
    @classmethod
    def mouse_position(cls, x: int, y: int, source: str = "mouse") -> WidgetEventData:
        """Create mouse position data."""
        return cls(key="mouse_position", value={"x": x, "y": y}, event_source=source)
    
    @classmethod
    def key_combination(cls, keys: list[str], source: str = "keyboard") -> WidgetEventData:
        """Create key combination data."""
        return cls(key="key_combination", value=keys, event_source=source)
    
    @classmethod
    def text_content(cls, text: str, source: str = "input") -> WidgetEventData:
        """Create text content data."""
        return cls(key="text_content", value=text, event_source=source)
    
    @classmethod
    def numeric_value(cls, value: float, source: str = "numeric_input") -> WidgetEventData:
        """Create numeric value data."""
        return cls(key="numeric_value", value=value, event_source=source)
