"""Widget service interface for presentation layer."""

from __future__ import annotations

from abc import ABC, abstractmethod
from enum import Enum
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from src_refactored.domain.common.result import Result


class ToggleState(Enum):
    """Toggle widget state enumeration."""
    OFF = 0
    ON = 1


class ToggleMode(Enum):
    """Toggle widget interaction mode."""
    CLICK_TO_TOGGLE = "click_to_toggle"
    DRAG_TO_TOGGLE = "drag_to_toggle"
    BOTH = "both"


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


class IToggleWidgetService(ABC):
    """Interface for toggle widget application services."""

    @abstractmethod
    def create_toggle_widget(self, widget_id: str, width: int = 23, height: int = 11) -> Result[None]:
        """Create a new toggle widget."""

    @abstractmethod
    def toggle_widget(self, widget_id: str) -> Result[bool]:
        """Toggle the widget state."""

    @abstractmethod
    def set_widget_state(self, widget_id: str, state: ToggleState) -> Result[bool]:
        """Set the widget to a specific state."""

    @abstractmethod
    def enable_widget(self, widget_id: str) -> Result[None]:
        """Enable widget interaction."""

    @abstractmethod
    def disable_widget(self, widget_id: str) -> Result[None]:
        """Disable widget interaction."""

    @abstractmethod
    def reset_widget(self, widget_id: str) -> Result[None]:
        """Reset widget to default state."""

    @abstractmethod
    def get_widget_state(self, widget_id: str) -> Result[ToggleState]:
        """Get current toggle state."""

    @abstractmethod
    def is_widget_enabled(self, widget_id: str) -> Result[bool]:
        """Check if widget is enabled."""


class IWidgetStateService(ABC):
    """Interface for widget state management services."""

    @abstractmethod
    def set_visual_state(self, widget_id: str, state: VisualState) -> Result[bool]:
        """Set visual state for widget."""

    @abstractmethod
    def set_interaction_state(self, widget_id: str, state: InteractionState) -> Result[bool]:
        """Set interaction state for widget."""

    @abstractmethod
    def enable_widget(self, widget_id: str) -> Result[None]:
        """Enable the widget."""

    @abstractmethod
    def disable_widget(self, widget_id: str) -> Result[None]:
        """Disable the widget."""

    @abstractmethod
    def apply_error_state(self, widget_id: str) -> Result[None]:
        """Apply error visual state."""

    @abstractmethod
    def clear_error_state(self, widget_id: str) -> Result[None]:
        """Clear error state."""

    @abstractmethod
    def reset_to_normal(self, widget_id: str) -> Result[None]:
        """Reset widget to normal state."""

    @abstractmethod
    def set_custom_property(self, widget_id: str, key: str, value: Any) -> Result[None]:
        """Set custom property for widget."""

    @abstractmethod
    def get_custom_property(self, widget_id: str, key: str) -> Result[Any]:
        """Get custom property value."""

    @abstractmethod
    def get_visual_state(self, widget_id: str) -> Result[VisualState]:
        """Get current visual state."""

    @abstractmethod
    def get_interaction_state(self, widget_id: str) -> Result[InteractionState]:
        """Get current interaction state."""
