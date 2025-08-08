"""Widget state presenter for UI widgets presentation layer.

This presenter follows MVP pattern and delegates business logic to application services.
Replaces the previous WidgetState entity that violated hexagonal architecture.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from src_refactored.application.interfaces.widget_service import (
    InteractionState,
    IWidgetStateService,
    VisualState,
)
from src_refactored.domain.common.result import Result


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


class WidgetStatePresenter:
    """Widget state presenter coordinating with application services.
    
    This presenter handles UI widget state concerns and delegates state management
    logic to application services, following hexagonal architecture principles.
    """

    def __init__(self, widget_id: str, widget_state_service: IWidgetStateService, initial_visual_state: VisualState = VisualState.NORMAL):
        """Initialize the widget state presenter.
        
        Args:
            widget_id: Unique identifier for the widget
            widget_state_service: Application service for widget state operations
            initial_visual_state: Initial visual state for the widget
        """
        self._widget_id = widget_id
        self._widget_state_service = widget_state_service
        
        # Presentation-specific state (for immediate UI feedback)
        self._local_style_properties: dict[VisualState, StyleProperties] = {}
        self._local_custom_properties: dict[str, Any] = {}
        
        # Initialize widget in application service
        self._widget_state_service.set_visual_state(widget_id, initial_visual_state)
        self._widget_state_service.set_interaction_state(widget_id, InteractionState.IDLE)

    def set_visual_state(self, state: VisualState) -> Result[bool]:
        """Set visual state through application service."""
        return self._widget_state_service.set_visual_state(self._widget_id, state)

    def set_interaction_state(self, state: InteractionState) -> Result[bool]:
        """Set interaction state through application service."""
        return self._widget_state_service.set_interaction_state(self._widget_id, state)

    def enable(self) -> Result[None]:
        """Enable the widget through application service."""
        return self._widget_state_service.enable_widget(self._widget_id)

    def disable(self) -> Result[None]:
        """Disable the widget through application service."""
        return self._widget_state_service.disable_widget(self._widget_id)

    def apply_error_state(self) -> Result[None]:
        """Apply error visual state through application service."""
        return self._widget_state_service.apply_error_state(self._widget_id)

    def clear_error_state(self) -> Result[None]:
        """Clear error state through application service."""
        return self._widget_state_service.clear_error_state(self._widget_id)

    def reset_to_normal(self) -> Result[None]:
        """Reset widget to normal state through application service."""
        return self._widget_state_service.reset_to_normal(self._widget_id)

    def set_custom_property(self, key: str, value: Any) -> Result[None]:
        """Set custom property through application service."""
        service_result = self._widget_state_service.set_custom_property(self._widget_id, key, value)
        if service_result.is_success:
            # Update local cache for immediate access
            self._local_custom_properties[key] = value
        return service_result

    def get_custom_property(self, key: str, default: Any = None) -> Result[Any]:
        """Get custom property through application service."""
        service_result = self._widget_state_service.get_custom_property(self._widget_id, key)
        if not service_result.is_success:
            # Fallback to local cache
            value = self._local_custom_properties.get(key, default)
            return Result.success(value)
        return service_result

    # Read-only properties that delegate to application service
    def get_visual_state(self) -> Result[VisualState]:
        """Get current visual state from application service."""
        return self._widget_state_service.get_visual_state(self._widget_id)

    def get_interaction_state(self) -> Result[InteractionState]:
        """Get current interaction state from application service."""
        return self._widget_state_service.get_interaction_state(self._widget_id)

    def is_enabled(self) -> Result[bool]:
        """Check if widget is enabled from application service."""
        # Widget is enabled if not disabled - check visual state
        visual_state_result = self.get_visual_state()
        if not visual_state_result.is_success:
            return Result.failure(visual_state_result.error or "Failed to get visual state")
        
        is_enabled = visual_state_result.value != VisualState.DISABLED
        return Result.success(is_enabled)

    def is_disabled(self) -> Result[bool]:
        """Check if widget is disabled from application service."""
        enabled_result = self.is_enabled()
        if not enabled_result.is_success:
            return enabled_result
        
        return Result.success(not enabled_result.value)

    def is_in_error_state(self) -> Result[bool]:
        """Check if widget is in error state from application service."""
        visual_state_result = self.get_visual_state()
        if not visual_state_result.is_success:
            return Result.failure(visual_state_result.error or "Failed to get visual state")
        
        is_error = visual_state_result.value == VisualState.ERROR
        return Result.success(is_error)

    def is_processing(self) -> Result[bool]:
        """Check if widget is in processing state from application service."""
        interaction_state_result = self.get_interaction_state()
        if not interaction_state_result.is_success:
            return Result.failure(interaction_state_result.error or "Failed to get interaction state")
        
        is_processing = interaction_state_result.value == InteractionState.PROCESSING
        return Result.success(is_processing)

    # Presentation-specific styling methods (not delegated to application service)
    def set_style_for_state(self, state: VisualState, style: StyleProperties) -> None:
        """Set style properties for a specific visual state (presentation concern)."""
        self._local_style_properties[state] = style

    def get_current_style(self) -> Result[StyleProperties | None]:
        """Get style properties for current visual state (presentation concern)."""
        visual_state_result = self.get_visual_state()
        if not visual_state_result.is_success:
            return Result.failure(visual_state_result.error or "Failed to get visual state")
        
        current_state = visual_state_result.value
        if current_state is None:
            return Result.failure("Visual state is None")
        style = self._local_style_properties.get(current_state)
        return Result.success(style)

    def has_visual_state_changed(self) -> Result[bool]:
        """Check if visual state has changed (would need to track changes locally or in service)."""
        # This would require change tracking in the application service
        # For now, return a basic implementation
        return Result.success(False)

    def has_interaction_state_changed(self) -> Result[bool]:
        """Check if interaction state has changed (would need to track changes locally or in service)."""
        # This would require change tracking in the application service
        # For now, return a basic implementation
        return Result.success(False)

    # Presentation-specific properties
    @property
    def widget_id(self) -> str:
        """Get widget identifier."""
        return self._widget_id

    @property
    def local_style_properties(self) -> dict[VisualState, StyleProperties]:
        """Get local style properties for immediate UI styling."""
        return self._local_style_properties.copy()

    @property
    def local_custom_properties(self) -> dict[str, Any]:
        """Get local custom properties for immediate access."""
        return self._local_custom_properties.copy()


# Backward compatibility alias - will be removed after full migration
WidgetState = WidgetStatePresenter