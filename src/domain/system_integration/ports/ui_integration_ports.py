"""UI Integration Ports for system integration operations."""

from abc import ABC, abstractmethod
from enum import Enum
from typing import Any

from src.domain.common.result import Result


class DragDropAction(Enum):
    """Drag and drop action types."""
    COPY = "copy"
    MOVE = "move"
    LINK = "link"
    NONE = "none"


class WidgetConfigurationType(Enum):
    """Widget configuration types."""
    LAYOUT = "layout"
    STYLING = "styling"
    BEHAVIOR = "behavior"
    EVENT_HANDLING = "event_handling"
    ACCESSIBILITY = "accessibility"


class IDragDropPort(ABC):
    """Port interface for drag and drop operations."""
    
    @abstractmethod
    def enable_drag_drop(self, widget_id: str, accepted_types: list[str]) -> Result[None]:
        """Enable drag and drop on a widget.
        
        Args:
            widget_id: Widget identifier
            accepted_types: List of accepted MIME types
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def disable_drag_drop(self, widget_id: str) -> Result[None]:
        """Disable drag and drop on a widget.
        
        Args:
            widget_id: Widget identifier
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def handle_drop_event(self, widget_id: str, drop_data: dict[str, Any]) -> Result[DragDropAction]:
        """Handle drop event on a widget.
        
        Args:
            widget_id: Widget identifier
            drop_data: Drop event data
            
        Returns:
            Result containing the action taken
        """
        ...
    
    @abstractmethod
    def validate_drop_data(self, drop_data: dict[str, Any], accepted_types: list[str]) -> Result[bool]:
        """Validate drop data against accepted types.
        
        Args:
            drop_data: Drop event data
            accepted_types: List of accepted MIME types
            
        Returns:
            Result containing validation status
        """
        ...
    
    @abstractmethod
    def get_drag_feedback(self, widget_id: str, drag_data: dict[str, Any]) -> Result[dict[str, Any]]:
        """Get visual feedback for drag operation.
        
        Args:
            widget_id: Widget identifier
            drag_data: Drag event data
            
        Returns:
            Result containing feedback configuration
        """
        ...


class IWidgetConfigurationPort(ABC):
    """Port interface for widget configuration operations."""
    
    @abstractmethod
    def configure_widget(self, widget_id: str, config_type: WidgetConfigurationType, config: dict[str, Any]) -> Result[None]:
        """Configure a widget.
        
        Args:
            widget_id: Widget identifier
            config_type: Type of configuration
            config: Configuration data
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def get_widget_configuration(self, widget_id: str, config_type: WidgetConfigurationType) -> Result[dict[str, Any]]:
        """Get widget configuration.
        
        Args:
            widget_id: Widget identifier
            config_type: Type of configuration to retrieve
            
        Returns:
            Result containing configuration data
        """
        ...
    
    @abstractmethod
    def validate_widget_configuration(self, config_type: WidgetConfigurationType, config: dict[str, Any]) -> Result[list[str]]:
        """Validate widget configuration.
        
        Args:
            config_type: Type of configuration
            config: Configuration to validate
            
        Returns:
            Result containing list of validation errors (empty if valid)
        """
        ...
    
    @abstractmethod
    def apply_widget_theme(self, widget_id: str, theme_name: str) -> Result[None]:
        """Apply theme to widget.
        
        Args:
            widget_id: Widget identifier
            theme_name: Name of theme to apply
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def reset_widget_configuration(self, widget_id: str, config_type: WidgetConfigurationType) -> Result[None]:
        """Reset widget configuration to defaults.
        
        Args:
            widget_id: Widget identifier
            config_type: Type of configuration to reset
            
        Returns:
            Result indicating success or failure
        """
        ...
