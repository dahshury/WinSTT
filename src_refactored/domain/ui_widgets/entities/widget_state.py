"""Widget state entity for UI widgets domain."""

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

    def __post_init__(self):
        """Validate style properties."""
        if self.opacity < 0.0 or self.opacity > 1.0:
            msg = "Opacity must be between 0.0 and 1.0"
            raise ValueError(msg)

    def to_stylesheet(self) -> str:
        """Convert style properties to CSS stylesheet string."""
        styles = []

        if self.background_color:
            styles.append(f"background-color: {self.background_color};")
        if self.border_color:
            styles.append(f"border-color: {self.border_color};")
        if self.border_style:
            styles.append(f"border-style: {self.border_style};")
        if self.border_width:
            styles.append(f"border-width: {self.border_width};")
        if self.font_color:
            styles.append(f"color: {self.font_color};")

        return " ".join(styles)


class WidgetState(Entity[str],
    ):
    """Widget state entity managing visual and interaction states."""

    def __init__(self, widget_id: str, initial_visual_state: VisualState = VisualState.NORMAL):
        super().__init__(widget_id,
    )
        self._visual_state = initial_visual_state
        self._interaction_state = InteractionState.IDLE
        self._previous_visual_state: VisualState | None = None
        self._previous_interaction_state: InteractionState | None = None
        self._style_properties: dict[VisualState, StyleProperties] = {}
        self._is_enabled = True
        self._custom_properties: dict[str, Any] = {}
        self.validate()

    def set_visual_state(self, state: VisualState,
    ) -> bool:
        """Set visual state and return success status."""
        if not self._is_enabled and state not in [VisualState.DISABLED]:
            return False

        if self._visual_state != state:
            self._previous_visual_state = self._visual_state
            self._visual_state = state
            self.mark_as_updated()

        return True

    def set_interaction_state(self, state: InteractionState,
    ) -> bool:
        """Set interaction state and return success status."""
        if not self._is_enabled and state not in [InteractionState.LOCKED]:
            return False

        if self._interaction_state != state:
            self._previous_interaction_state = self._interaction_state
            self._interaction_state = state
            self.mark_as_updated()

        return True

    def enable(self) -> None:
        """Enable the widget and update visual state."""
        if not self._is_enabled:
            self._is_enabled = True
            if self._visual_state == VisualState.DISABLED:
                self.set_visual_state(VisualState.NORMAL)
            if self._interaction_state == InteractionState.LOCKED:
                self.set_interaction_state(InteractionState.IDLE)

    def disable(self) -> None:
        """Disable the widget and update visual state."""
        if self._is_enabled:
            self._is_enabled = False
            self.set_visual_state(VisualState.DISABLED)
            self.set_interaction_state(InteractionState.LOCKED)

    def set_style_for_state(self, state: VisualState, style: StyleProperties,
    ) -> None:
        """Set style properties for a specific visual state."""
        self._style_properties[state] = style
        self.mark_as_updated()

    def get_current_style(self) -> StyleProperties | None:
        """Get style properties for current visual state."""
        return self._style_properties.get(self._visual_state)

    def set_custom_property(self, key: str, value: Any,
    ) -> None:
        """Set custom property for widget state."""
        self._custom_properties[key] = value
        self.mark_as_updated()

    def get_custom_property(self, key: str, default: Any = None,
    ) -> Any:
        """Get custom property value."""
        return self._custom_properties.get(key, default)

    def reset_to_normal(self) -> None:
        """Reset widget to normal state."""
        self.set_visual_state(VisualState.NORMAL)
        self.set_interaction_state(InteractionState.IDLE)

    def apply_error_state(self) -> None:
        """Apply error visual state."""
        self.set_visual_state(VisualState.ERROR)

    def clear_error_state(self) -> None:
        """Clear error state and return to normal."""
        if self._visual_state == VisualState.ERROR:
            self.set_visual_state(VisualState.NORMAL)

    def has_visual_state_changed(self) -> bool:
        """Check if visual state has changed."""
return self._previous_visual_state is not None and self._previous_visual_state ! = (
    self._visual_state)

    def has_interaction_state_changed(self) -> bool:
        """Check if interaction state has changed."""
return self._previous_interaction_state is not None and self._previous_interaction_state ! = (
    self._interaction_state)

    # Properties
    @property
    def visual_state(self) -> VisualState:
        """Get current visual state."""
        return self._visual_state

    @property
    def interaction_state(self) -> InteractionState:
        """Get current interaction state."""
        return self._interaction_state

    @property
    def is_enabled(self) -> bool:
        """Check if widget is enabled."""
        return self._is_enabled

    @property
    def is_disabled(self) -> bool:
        """Check if widget is disabled."""
        return not self._is_enabled

    @property
    def is_in_error_state(self) -> bool:
        """Check if widget is in error state."""
        return self._visual_state == VisualState.ERROR

    @property
    def is_processing(self) -> bool:
        """Check if widget is in processing state."""
        return self._interaction_state == InteractionState.PROCESSING

    @property
    def previous_visual_state(self) -> VisualState | None:
        """Get previous visual state."""
        return self._previous_visual_state

    @property
    def previous_interaction_state(self) -> InteractionState | None:
        """Get previous interaction state."""
        return self._previous_interaction_state

    def __invariants__(self) -> None:
        """Validate widget state invariants."""
        if not self._is_enabled and self._visual_state not in [VisualState.DISABLED]:
            msg = "Disabled widget must have disabled visual state"
            raise ValueError(msg)
        if not self._is_enabled and self._interaction_state not in [InteractionState.LOCKED]:
            msg = "Disabled widget must have locked interaction state"
            raise ValueError(msg)