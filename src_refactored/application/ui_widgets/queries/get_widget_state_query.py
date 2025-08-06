"""Get Widget State Query.

This module implements the query for retrieving widget state information,
separated from command operations following CQRS pattern.
"""

from dataclasses import dataclass
from typing import Any

from src_refactored.domain.common.abstractions import IQuery
from src_refactored.domain.ui_widget_operations import WidgetType


@dataclass
class GetWidgetStateQuery(IQuery[dict[str, Any]]):
    """Query for retrieving widget state information.
    
    This query retrieves current widget state, event history,
    and response coordination status without modifying any data.
    """
    widget_id: str
    widget_type: WidgetType
    include_event_history: bool = False
    include_response_state: bool = False
    include_validation_state: bool = False
    max_history_entries: int = 100

    def __post_init__(self):
        """Validate query parameters."""
        if not self.widget_id:
            msg = "Widget ID is required"
            raise ValueError(msg)
        if not self.widget_type:
            msg = "Widget type is required"
            raise ValueError(msg)
        if self.max_history_entries < 1:
            msg = "Max history entries must be positive"
            raise ValueError(msg)


@dataclass
class WidgetStateResult:
    """Result of widget state query."""
    widget_id: str
    widget_type: WidgetType
    current_state: dict[str, Any]
    event_history: list[dict[str, Any]] | None = None
    response_state: dict[str, Any] | None = None
    validation_state: dict[str, Any] | None = None
    timestamp: float = 0.0

    def __post_init__(self):
        """Set timestamp if not provided."""
        if self.timestamp == 0.0:
            import time
            object.__setattr__(self, "timestamp", time.time())