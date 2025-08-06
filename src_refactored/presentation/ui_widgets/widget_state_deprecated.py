"""DEPRECATED: Widget state entity - VIOLATES HEXAGONAL ARCHITECTURE.

This file contains domain logic in the presentation layer and should not be used.
Use WidgetStatePresenter instead, which properly delegates to application services.

This file is kept temporarily for reference during refactoring.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from src_refactored.domain.common import Entity


class VisualState(Enum):
    """Visual state enumeration for widgets."""
    NORMAL = "normal"
    HOVER = "hover"
    PRESSED = "pressed"
    DISABLED = "disabled"
    FOCUSED = "focused"
    ERROR = "error"


class InteractionState(Enum):
    """Interaction state enumeration for widgets."""
    IDLE = "idle"
    ACTIVE = "active"
    PROCESSING = "processing"
    LOCKED = "locked"


@dataclass
class StyleProperties:
    """Style properties for widget visual state."""
    background_color: str | None = None
    border_color: str | None = None
    border_style: str | None = None
    border_width: str | None = None
    opacity: float = 1.0
    font_color: str | None = None


class WidgetStateDeprecated(Entity[str]):
    """DEPRECATED: Widget state entity - violates hexagonal architecture."""

    def __init__(self, widget_id: str, initial_visual_state: VisualState = VisualState.NORMAL):
        super().__init__(widget_id)
        self._visual_state = initial_visual_state
        self._interaction_state = InteractionState.IDLE
        self._previous_visual_state: VisualState | None = None
        self._previous_interaction_state: InteractionState | None = None
        self._style_properties: dict[VisualState, StyleProperties] = {}
        self._is_enabled = True
        self._custom_properties: dict[str, Any] = {}
        self.validate()

    # ... rest of the implementation is preserved for reference ...
