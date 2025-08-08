"""Widget service implementation for presentation layer."""

from __future__ import annotations

from typing import Any

from src_refactored.application.interfaces.widget_service import (
    InteractionState,
    IToggleWidgetService,
    IWidgetStateService,
    ToggleState,
    VisualState,
)
from src_refactored.domain.common.result import Result
from src_refactored.presentation.qt.toggle_switch_widget import ToggleSwitch


class ToggleWidgetServiceImpl(IToggleWidgetService):
    """Implementation of toggle widget application service."""

    def __init__(self):
        """Initialize the toggle widget service."""
        self._widgets: dict[str, ToggleSwitch] = {}
        self._widget_states: dict[str, ToggleState] = {}
        self._widget_enabled: dict[str, bool] = {}

    def create_toggle_widget(self, widget_id: str, width: int = 23, height: int = 11) -> Result[None]:
        """Create a new toggle widget."""
        try:
            if widget_id in self._widgets:
                return Result.failure(f"Widget {widget_id} already exists")

            # Create the toggle widget
            widget = ToggleSwitch()
            widget.setFixedSize(width, height)
            
            self._widgets[widget_id] = widget
            self._widget_states[widget_id] = ToggleState.OFF
            self._widget_enabled[widget_id] = True
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to create toggle widget: {e}")

    def toggle_widget(self, widget_id: str) -> Result[bool]:
        """Toggle the widget state."""
        try:
            if widget_id not in self._widgets:
                return Result.failure(f"Widget {widget_id} not found")

            if not self._widget_enabled.get(widget_id, True):
                return Result.failure(f"Widget {widget_id} is disabled")

            # Toggle the state
            current_state = self._widget_states[widget_id]
            new_state = ToggleState.ON if current_state == ToggleState.OFF else ToggleState.OFF
            
            self._widget_states[widget_id] = new_state
            
            # Update the Qt widget
            widget = self._widgets[widget_id]
            widget.setValue(new_state.value)
            
            return Result.success(new_state == ToggleState.ON)
        except Exception as e:
            return Result.failure(f"Failed to toggle widget: {e}")

    def set_widget_state(self, widget_id: str, state: ToggleState) -> Result[bool]:
        """Set the widget to a specific state."""
        try:
            if widget_id not in self._widgets:
                return Result.failure(f"Widget {widget_id} not found")

            self._widget_states[widget_id] = state
            
            # Update the Qt widget
            widget = self._widgets[widget_id]
            widget.setValue(state.value)
            
            return Result.success(state == ToggleState.ON)
        except Exception as e:
            return Result.failure(f"Failed to set widget state: {e}")

    def enable_widget(self, widget_id: str) -> Result[None]:
        """Enable widget interaction."""
        try:
            if widget_id not in self._widgets:
                return Result.failure(f"Widget {widget_id} not found")

            self._widget_enabled[widget_id] = True
            
            # Update the Qt widget
            widget = self._widgets[widget_id]
            widget.setEnabled(True)
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to enable widget: {e}")

    def disable_widget(self, widget_id: str) -> Result[None]:
        """Disable widget interaction."""
        try:
            if widget_id not in self._widgets:
                return Result.failure(f"Widget {widget_id} not found")

            self._widget_enabled[widget_id] = False
            
            # Update the Qt widget
            widget = self._widgets[widget_id]
            widget.setEnabled(False)
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to disable widget: {e}")

    def reset_widget(self, widget_id: str) -> Result[None]:
        """Reset widget to default state."""
        try:
            if widget_id not in self._widgets:
                return Result.failure(f"Widget {widget_id} not found")

            # Reset to OFF state
            self._widget_states[widget_id] = ToggleState.OFF
            self._widget_enabled[widget_id] = True
            
            # Update the Qt widget
            widget = self._widgets[widget_id]
            widget.setValue(0)
            widget.setEnabled(True)
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to reset widget: {e}")

    def get_widget_state(self, widget_id: str) -> Result[ToggleState]:
        """Get current toggle state."""
        try:
            if widget_id not in self._widgets:
                return Result.failure(f"Widget {widget_id} not found")

            state = self._widget_states[widget_id]
            return Result.success(state)
        except Exception as e:
            return Result.failure(f"Failed to get widget state: {e}")

    def is_widget_enabled(self, widget_id: str) -> Result[bool]:
        """Check if widget is enabled."""
        try:
            if widget_id not in self._widgets:
                return Result.failure(f"Widget {widget_id} not found")

            enabled = self._widget_enabled[widget_id]
            return Result.success(enabled)
        except Exception as e:
            return Result.failure(f"Failed to check widget enabled state: {e}")


class WidgetStateServiceImpl(IWidgetStateService):
    """Implementation of widget state management service."""

    def __init__(self):
        """Initialize the widget state service."""
        self._visual_states: dict[str, VisualState] = {}
        self._interaction_states: dict[str, InteractionState] = {}
        self._custom_properties: dict[str, dict[str, Any]] = {}
        self._widget_enabled: dict[str, bool] = {}

    def set_visual_state(self, widget_id: str, state: VisualState) -> Result[bool]:
        """Set visual state for widget."""
        try:
            self._visual_states[widget_id] = state
            
            # In a real implementation, this would update the widget's appearance
            # For now, we just track the state
            
            return Result.success(True)
        except Exception as e:
            return Result.failure(f"Failed to set visual state: {e}")

    def set_interaction_state(self, widget_id: str, state: InteractionState) -> Result[bool]:
        """Set interaction state for widget."""
        try:
            self._interaction_states[widget_id] = state
            
            # Update enabled state based on interaction state
            enabled = state not in (InteractionState.LOCKED, InteractionState.PROCESSING)
            self._widget_enabled[widget_id] = enabled
            
            return Result.success(True)
        except Exception as e:
            return Result.failure(f"Failed to set interaction state: {e}")

    def enable_widget(self, widget_id: str) -> Result[None]:
        """Enable the widget."""
        try:
            self._widget_enabled[widget_id] = True
            self._interaction_states[widget_id] = InteractionState.IDLE
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to enable widget: {e}")

    def disable_widget(self, widget_id: str) -> Result[None]:
        """Disable the widget."""
        try:
            self._widget_enabled[widget_id] = False
            self._interaction_states[widget_id] = InteractionState.LOCKED
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to disable widget: {e}")

    def apply_error_state(self, widget_id: str) -> Result[None]:
        """Apply error visual state."""
        try:
            self._visual_states[widget_id] = VisualState.ERROR
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to apply error state: {e}")

    def clear_error_state(self, widget_id: str) -> Result[None]:
        """Clear error state."""
        try:
            current_state = self._visual_states.get(widget_id, VisualState.NORMAL)
            if current_state == VisualState.ERROR:
                self._visual_states[widget_id] = VisualState.NORMAL
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to clear error state: {e}")

    def reset_to_normal(self, widget_id: str) -> Result[None]:
        """Reset widget to normal state."""
        try:
            self._visual_states[widget_id] = VisualState.NORMAL
            self._interaction_states[widget_id] = InteractionState.IDLE
            self._widget_enabled[widget_id] = True
            
            # Clear custom properties
            if widget_id in self._custom_properties:
                self._custom_properties[widget_id].clear()
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to reset to normal: {e}")

    def set_custom_property(self, widget_id: str, key: str, value: Any) -> Result[None]:
        """Set custom property for widget."""
        try:
            if widget_id not in self._custom_properties:
                self._custom_properties[widget_id] = {}
            
            self._custom_properties[widget_id][key] = value
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to set custom property: {e}")

    def get_custom_property(self, widget_id: str, key: str) -> Result[Any]:
        """Get custom property value."""
        try:
            if widget_id not in self._custom_properties:
                return Result.failure(f"Widget {widget_id} has no custom properties")
            
            if key not in self._custom_properties[widget_id]:
                return Result.failure(f"Property {key} not found for widget {widget_id}")
            
            value = self._custom_properties[widget_id][key]
            return Result.success(value)
        except Exception as e:
            return Result.failure(f"Failed to get custom property: {e}")

    def get_visual_state(self, widget_id: str) -> Result[VisualState]:
        """Get current visual state."""
        try:
            state = self._visual_states.get(widget_id, VisualState.NORMAL)
            return Result.success(state)
        except Exception as e:
            return Result.failure(f"Failed to get visual state: {e}")

    def get_interaction_state(self, widget_id: str) -> Result[InteractionState]:
        """Get current interaction state."""
        try:
            state = self._interaction_states.get(widget_id, InteractionState.IDLE)
            return Result.success(state)
        except Exception as e:
            return Result.failure(f"Failed to get interaction state: {e}")
