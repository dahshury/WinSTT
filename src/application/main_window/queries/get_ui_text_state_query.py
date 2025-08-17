"""Get UI Text State Query.

This module implements the query for retrieving UI text state information,
separated from command operations following CQRS pattern.
"""

from dataclasses import dataclass
from typing import Any

from src.application.main_window.update_ui_text_use_case import (
    WidgetTextTarget,
)
from src.domain.common.abstractions import IQuery


@dataclass
class GetUITextStateQuery(IQuery[dict[str, Any]]):
    """Query for retrieving UI text state information.
    
    This query retrieves current text content, formatting state,
    and translation status without modifying any data.
    """
    operation_id: str
    target_widgets: list[WidgetTextTarget]
    include_formatting: bool = True
    include_translation_cache: bool = False
    include_validation_state: bool = False

    def __post_init__(self):
        """Validate query parameters."""
        if not self.operation_id:
            msg = "Operation ID is required"
            raise ValueError(msg)
        if not self.target_widgets:
            msg = "Target widgets are required"
            raise ValueError(msg)


@dataclass
class UITextStateResult:
    """Result of UI text state query."""
    operation_id: str
    widget_states: dict[str, dict[str, Any]]
    formatting_cache: dict[str, Any] | None = None
    translation_cache: dict[str, Any] | None = None
    validation_results: dict[str, Any] | None = None
    timestamp: float = 0.0

    def __post_init__(self):
        """Set timestamp if not provided."""
        if self.timestamp == 0.0:
            import time
            object.__setattr__(self, "timestamp", time.time())