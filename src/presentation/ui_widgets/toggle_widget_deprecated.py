"""DEPRECATED: Toggle widget aggregate root - VIOLATES HEXAGONAL ARCHITECTURE.

This file contains domain logic in the presentation layer and should not be used.
Use ToggleWidgetPresenter instead, which properly delegates to application services.

This file is kept temporarily for reference during refactoring.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src.domain.common import AggregateRoot


class ToggleState(Enum):
    """Toggle widget state enumeration."""
    OFF = 0
    ON = 1


class ToggleMode(Enum):
    """Toggle widget interaction mode."""
    CLICK_TO_TOGGLE = "click_to_toggle"
    DRAG_TO_TOGGLE = "drag_to_toggle"
    BOTH = "both"


@dataclass
class ToggleConfiguration:
    """Configuration for toggle widget behavior."""
    width: int = 23
    height: int = 11
    mode: ToggleMode = ToggleMode.CLICK_TO_TOGGLE
    enabled: bool = True

    def __post_init__(self):
        """Validate configuration after initialization."""
        if self.width <= 0 or self.height <= 0:
            msg = "Widget dimensions must be positive"
            raise ValueError(msg)
        if self.width < 10 or self.height < 5:
            msg = "Widget too small for usability"
            raise ValueError(msg)


class ToggleWidgetDeprecated(AggregateRoot):
    """DEPRECATED: Toggle widget aggregate root - violates hexagonal architecture."""

    def __init__(self, widget_id: str, configuration: ToggleConfiguration):
        super().__init__(widget_id)
        self._state = ToggleState.OFF
        self._configuration = configuration
        self._previous_state: ToggleState | None = None
        self._state_changed: bool = False
        self.validate()

    # ... rest of the implementation is preserved for reference ...
