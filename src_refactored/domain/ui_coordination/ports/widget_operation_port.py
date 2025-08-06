"""Widget operation port for abstracting UI widget dependencies."""

from abc import ABC, abstractmethod
from typing import Any

from src_refactored.domain.common.result import Result


class WidgetOperationPort(ABC):
    """Port for managing widget operations.
    
    This port abstracts widget-specific operations from the presentation layer,
    allowing the application layer to manage widgets without direct dependencies
    on UI framework classes.
    """

    @abstractmethod
    def create_widget(self, widget_type: str, configuration: dict[str, Any]) -> Result[str]:
        """Create a new widget with the specified configuration.
        
        Args:
            widget_type: Type of widget to create
            configuration: Widget configuration parameters
            
        Returns:
            Result containing widget ID if successful, error otherwise
        """

    @abstractmethod
    def update_widget_state(self, widget_id: str, state: dict[str, Any]) -> Result[None]:
        """Update the state of an existing widget.
        
        Args:
            widget_id: Unique identifier of the widget
            state: New state parameters
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def handle_widget_event(self, widget_id: str, event_type: str, event_data: dict[str, Any]) -> Result[None]:
        """Handle an event from a widget.
        
        Args:
            widget_id: Unique identifier of the widget
            event_type: Type of event that occurred
            event_data: Event-specific data
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def get_widget_state(self, widget_id: str) -> Result[dict[str, Any]]:
        """Get the current state of a widget.
        
        Args:
            widget_id: Unique identifier of the widget
            
        Returns:
            Result containing widget state if successful, error otherwise
        """

    @abstractmethod
    def destroy_widget(self, widget_id: str) -> Result[None]:
        """Destroy a widget and clean up its resources.
        
        Args:
            widget_id: Unique identifier of the widget
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def set_widget_property(self, widget_id: str, property_name: str, value: Any) -> Result[None]:
        """Set a property on a widget.
        
        Args:
            widget_id: Unique identifier of the widget
            property_name: Name of the property to set
            value: Value to set
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def get_widget_property(self, widget_id: str, property_name: str) -> Result[Any]:
        """Get a property from a widget.
        
        Args:
            widget_id: Unique identifier of the widget
            property_name: Name of the property to get
            
        Returns:
            Result containing property value if successful, error otherwise
        """
