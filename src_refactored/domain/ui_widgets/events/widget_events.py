"""UI Widget Domain Events.

This module defines domain events related to UI widget operations.
"""

from dataclasses import dataclass
from typing import Any

from ...common.events import DomainEvent
from ..value_objects.widget_operations import WidgetType


@dataclass
class WidgetCreationRequestedEvent(DomainEvent):
    """Event raised when widget creation is requested."""
    
    widget_type: WidgetType
    widget_id: str
    configuration: dict[str, Any]
    parent_widget_id: str | None = None
    
    def __post_init__(self):
        super().__post_init__()


@dataclass
class WidgetCreatedEvent(DomainEvent):
    """Event raised when widget is created."""
    
    widget_type: WidgetType
    widget_id: str
    properties: dict[str, Any]
    
    def __post_init__(self):
        super().__post_init__()


@dataclass
class WidgetDestroyRequestedEvent(DomainEvent):
    """Event raised when widget destruction is requested."""
    
    widget_id: str
    cleanup_resources: bool = True
    
    def __post_init__(self):
        super().__post_init__()


@dataclass
class WidgetDestroyedEvent(DomainEvent):
    """Event raised when widget is destroyed."""
    
    widget_id: str
    
    def __post_init__(self):
        super().__post_init__()


@dataclass
class WidgetConfigurationChangedEvent(DomainEvent):
    """Event raised when widget configuration changes."""
    
    widget_id: str
    changed_properties: dict[str, Any]
    previous_values: dict[str, Any] | None = None
    
    def __post_init__(self):
        super().__post_init__()


@dataclass
class WidgetStateChangedEvent(DomainEvent):
    """Event raised when widget state changes."""
    
    widget_id: str
    new_state: str
    previous_state: str | None = None
    user_initiated: bool = False
    
    def __post_init__(self):
        super().__post_init__()


@dataclass
class WidgetValueChangedEvent(DomainEvent):
    """Event raised when widget value changes."""
    
    widget_id: str
    new_value: Any
    previous_value: Any | None = None
    user_initiated: bool = False
    
    def __post_init__(self):
        super().__post_init__()


@dataclass
class WidgetEventTriggeredEvent(DomainEvent):
    """Event raised when widget triggers a business event."""
    
    widget_id: str
    event_type: str
    event_data: dict[str, Any] | None = None
    
    def __post_init__(self):
        super().__post_init__()


@dataclass
class ToggleWidgetToggledEvent(DomainEvent):
    """Event raised when toggle widget is toggled."""
    
    widget_id: str
    new_state: bool
    previous_state: bool
    user_initiated: bool = False
    
    def __post_init__(self):
        super().__post_init__()


@dataclass
class WidgetValidationFailedEvent(DomainEvent):
    """Event raised when widget validation fails."""
    
    widget_id: str
    validation_errors: dict[str, str]
    attempted_value: Any
    
    def __post_init__(self):
        super().__post_init__()


@dataclass
class WidgetFocusChangedEvent(DomainEvent):
    """Event raised when widget focus changes."""
    
    widget_id: str
    has_focus: bool
    
    def __post_init__(self):
        super().__post_init__()


@dataclass
class WidgetVisibilityChangedEvent(DomainEvent):
    """Event raised when widget visibility changes."""
    
    widget_id: str
    is_visible: bool
    reason: str | None = None
    
    def __post_init__(self):
        super().__post_init__()
