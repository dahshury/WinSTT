"""Toggle widget presenter for UI widgets presentation layer.

This presenter follows MVP pattern and delegates business logic to application services.
Replaces the previous ToggleWidget aggregate that violated hexagonal architecture.
"""

from __future__ import annotations

from dataclasses import dataclass

from src_refactored.application.interfaces.widget_service import (
    IToggleWidgetService,
    ToggleMode,
    ToggleState,
)
from src_refactored.domain.common.result import Result


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


class ToggleWidgetPresenter:
    """Toggle widget presenter coordinating with application services.
    
    This presenter handles UI concerns and delegates business logic to application services,
    following hexagonal architecture principles.
    """

    def __init__(self, widget_id: str, toggle_service: IToggleWidgetService, configuration: ToggleConfiguration):
        """Initialize the toggle widget presenter.
        
        Args:
            widget_id: Unique identifier for the widget
            toggle_service: Application service for toggle widget operations
            configuration: Widget configuration (presentation-specific)
        """
        self._widget_id = widget_id
        self._toggle_service = toggle_service
        self._configuration = configuration

    @classmethod
    def create(
        cls,
        widget_id: str,
        toggle_service: IToggleWidgetService,
        configuration: ToggleConfiguration | None = None,
    ) -> Result[ToggleWidgetPresenter]:
        """Create a new toggle widget presenter."""
        try:
            config = configuration or ToggleConfiguration()
            presenter = cls(widget_id, toggle_service, config)
            
            # Initialize the widget in the application service
            init_result = toggle_service.create_toggle_widget(
                widget_id, config.width, config.height,
            )
            if not init_result.is_success:
                return Result.failure(f"Failed to initialize toggle widget: {init_result.error}")
                
            return Result.success(presenter)
        except Exception as e:
            return Result.failure(f"Failed to create toggle widget presenter: {e!s}")

    def toggle(self) -> Result[bool]:
        """Toggle the widget state through application service."""
        return self._toggle_service.toggle_widget(self._widget_id)

    def set_state(self, state: ToggleState) -> Result[bool]:
        """Set the widget to a specific state through application service."""
        return self._toggle_service.set_widget_state(self._widget_id, state)

    def enable(self) -> Result[None]:
        """Enable widget interaction through application service."""
        result = self._toggle_service.enable_widget(self._widget_id)
        if result.is_success:
            self._configuration.enabled = True
        return result

    def disable(self) -> Result[None]:
        """Disable widget interaction through application service."""
        result = self._toggle_service.disable_widget(self._widget_id)
        if result.is_success:
            self._configuration.enabled = False
        return result

    def reset_to_default(self) -> Result[None]:
        """Reset widget to default state through application service."""
        return self._toggle_service.reset_widget(self._widget_id)

    def can_interact(self) -> Result[bool]:
        """Check if the widget can be interacted with through application service."""
        return self._toggle_service.is_widget_enabled(self._widget_id)

    # Read-only properties that delegate to application service
    def get_state(self) -> Result[ToggleState]:
        """Get current toggle state from application service."""
        return self._toggle_service.get_widget_state(self._widget_id)

    def is_on(self) -> Result[bool]:
        """Check if toggle is in ON state from application service."""
        state_result = self.get_state()
        if not state_result.is_success:
            return Result.failure(state_result.error or "Failed to get toggle state")
        return Result.success(state_result.value == ToggleState.ON)

    def is_off(self) -> Result[bool]:
        """Check if toggle is in OFF state from application service."""
        state_result = self.get_state()
        if not state_result.is_success:
            return Result.failure(state_result.error or "Failed to get toggle state")
        return Result.success(state_result.value == ToggleState.OFF)

    def is_enabled(self) -> Result[bool]:
        """Check if widget is enabled from application service."""
        return self._toggle_service.is_widget_enabled(self._widget_id)

    # Presentation-specific properties (not delegated to application service)
    @property
    def widget_id(self) -> str:
        """Get widget identifier."""
        return self._widget_id

    @property
    def configuration(self) -> ToggleConfiguration:
        """Get widget configuration (presentation concern)."""
        return self._configuration


# Backward compatibility alias - will be removed after full migration
ToggleWidget = ToggleWidgetPresenter