"""Create Toggle Widget Presenter

This module implements the presenter for creating custom toggle switch widgets
with styling and validation. Moved from application layer to follow hexagonal architecture.
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from src_refactored.presentation.ui_widgets.value_objects import (
    CreatePhase,
    CreateResult,
    ToggleSize,
    ToggleStyle,
)


@dataclass
class ToggleWidgetConfiguration:
    """Configuration for toggle widget creation."""
    style: ToggleStyle
    size: ToggleSize
    custom_width: int | None = None
    custom_height: int | None = None
    initial_value: bool = False
    enabled: bool = True
    tooltip: str | None = None
    object_name: str | None = None
    custom_stylesheet: str | None = None
    parent_widget: Any | None = None


@dataclass
class CreateToggleWidgetRequest:
    """Request to create a toggle widget."""
    configuration: ToggleWidgetConfiguration
    widget_id: str
    parent_context: str | None = None
    validation_rules: list[str] | None = None


@dataclass
class CreateToggleWidgetResponse:
    """Response from creating a toggle widget."""
    widget: Any | None
    result: CreateResult
    widget_id: str
    configuration_applied: ToggleWidgetConfiguration | None = None
    validation_errors: list[str] | None = None
    creation_timestamp: datetime | None = None
    phases_completed: list[CreatePhase] | None = None


class WidgetFactoryProtocol(Protocol):
    """Protocol for widget factory."""
    
    def create_toggle_widget(self, config: ToggleWidgetConfiguration) -> Any:
        """Create a toggle widget."""
        ...


class CreateToggleWidgetPresenter:
    """Presenter for creating toggle widgets in the UI."""
    
    def __init__(self, widget_factory: WidgetFactoryProtocol):
        """Initialize the presenter.
        
        Args:
            widget_factory: Factory for creating UI widgets
        """
        self.widget_factory = widget_factory
    
    def present_toggle_widget(self, request: CreateToggleWidgetRequest) -> CreateToggleWidgetResponse:
        """Present a toggle widget creation.
        
        Args:
            request: Request containing widget configuration
            
        Returns:
            Response with created widget and status
        """
        try:
            # Validate configuration
            validation_errors = self._validate_configuration(request.configuration)
            if validation_errors:
                return CreateToggleWidgetResponse(
                    widget=None,
                    result=CreateResult.VALIDATION_FAILED,
                    widget_id=request.widget_id,
                    validation_errors=validation_errors,
                    creation_timestamp=datetime.now(UTC),
                )
            
            # Create the widget
            widget = self.widget_factory.create_toggle_widget(request.configuration)
            
            if widget is None:
                return CreateToggleWidgetResponse(
                    widget=None,
                    result=CreateResult.CREATION_FAILED,
                    widget_id=request.widget_id,
                    creation_timestamp=datetime.now(UTC),
                )
            
            return CreateToggleWidgetResponse(
                widget=widget,
                result=CreateResult.SUCCESS,
                widget_id=request.widget_id,
                configuration_applied=request.configuration,
                creation_timestamp=datetime.now(UTC),
                phases_completed=[CreatePhase.VALIDATION, CreatePhase.CREATION, CreatePhase.STYLING],
            )
            
        except Exception as e:
            return CreateToggleWidgetResponse(
                widget=None,
                result=CreateResult.CREATION_FAILED,
                widget_id=request.widget_id,
                validation_errors=[str(e)],
                creation_timestamp=datetime.now(UTC),
            )
    
    def _validate_configuration(self, config: ToggleWidgetConfiguration) -> list[str]:
        """Validate toggle widget configuration.
        
        Args:
            config: Configuration to validate
            
        Returns:
            List of validation errors (empty if valid)
        """
        errors = []
        
        # Validate custom dimensions
        if config.custom_width is not None and config.custom_width <= 0:
            errors.append("Custom width must be positive")
        
        if config.custom_height is not None and config.custom_height <= 0:
            errors.append("Custom height must be positive")
        
        # Validate style and size combination
        if config.style == ToggleStyle.MINIMAL and config.size == ToggleSize.LARGE:
            errors.append("Minimal style not recommended for large size")
        
        return errors