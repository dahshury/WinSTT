"""Handle Widget Event Command.

This module implements the command for handling widget events,
separated from query operations following CQRS pattern.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from src_refactored.domain.common.abstractions import ICommand
from src_refactored.domain.ui_widget_operations import (
    EventPriority,
    EventType,
    WidgetType,
)


@dataclass
class WidgetEvent:
    """Represents a widget event."""
    event_type: EventType
    event_data: dict[str, Any]
    timestamp: datetime
    priority: EventPriority = EventPriority.NORMAL
    source_widget_id: str | None = None


@dataclass
class EventHandlingConfiguration:
    """Configuration for event handling."""
    validate_event_data: bool = True
    enable_state_tracking: bool = True
    enable_response_coordination: bool = True
    timeout_seconds: float = 30.0
    retry_attempts: int = 3
    enable_progress_tracking: bool = False


@dataclass
class HandleWidgetEventCommand(ICommand):
    """Command for handling widget events.
    
    This command encapsulates the intent to handle a widget event
    without mixing concerns with state queries or direct UI manipulation.
    """
    event: WidgetEvent
    widget_type: WidgetType
    configuration: EventHandlingConfiguration
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[bool, str], None] | None = None
    error_callback: Callable[[str, Exception], None] | None = None

    def __post_init__(self):
        """Validate command data."""
        if not self.event:
            msg = "Event is required"
            raise ValueError(msg)
        if not self.widget_type:
            msg = "Widget type is required"
            raise ValueError(msg)
        if not self.configuration:
            msg = "Configuration is required"
            raise ValueError(msg)