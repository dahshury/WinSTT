"""UI state management port for abstracting UI state dependencies."""

from abc import ABC, abstractmethod
from typing import Any

from src_refactored.domain.common.result import Result


class UIStateManagementPort(ABC):
    """Port for managing UI state operations.
    
    This port abstracts UI state management operations from the presentation layer,
    allowing the application layer to manage UI state without direct dependencies
    on UI framework classes.
    """

    @abstractmethod
    def update_ui_text(self, element_id: str, text: str) -> Result[None]:
        """Update text content of a UI element.
        
        Args:
            element_id: Unique identifier of the UI element
            text: New text content
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def get_ui_text(self, element_id: str) -> Result[str]:
        """Get text content of a UI element.
        
        Args:
            element_id: Unique identifier of the UI element
            
        Returns:
            Result containing text content if successful, error otherwise
        """

    @abstractmethod
    def set_ui_enabled(self, element_id: str, enabled: bool) -> Result[None]:
        """Set the enabled state of a UI element.
        
        Args:
            element_id: Unique identifier of the UI element
            enabled: Whether the element should be enabled
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def is_ui_enabled(self, element_id: str) -> Result[bool]:
        """Check if a UI element is enabled.
        
        Args:
            element_id: Unique identifier of the UI element
            
        Returns:
            Result containing enabled state if successful, error otherwise
        """

    @abstractmethod
    def set_ui_visible(self, element_id: str, visible: bool) -> Result[None]:
        """Set the visibility of a UI element.
        
        Args:
            element_id: Unique identifier of the UI element
            visible: Whether the element should be visible
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def is_ui_visible(self, element_id: str) -> Result[bool]:
        """Check if a UI element is visible.
        
        Args:
            element_id: Unique identifier of the UI element
            
        Returns:
            Result containing visibility state if successful, error otherwise
        """

    @abstractmethod
    def update_ui_style(self, element_id: str, style_properties: dict[str, Any]) -> Result[None]:
        """Update style properties of a UI element.
        
        Args:
            element_id: Unique identifier of the UI element
            style_properties: Dictionary of style properties to update
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def get_ui_style(self, element_id: str, property_names: list[str]) -> Result[dict[str, Any]]:
        """Get style properties of a UI element.
        
        Args:
            element_id: Unique identifier of the UI element
            property_names: List of property names to retrieve
            
        Returns:
            Result containing style properties if successful, error otherwise
        """

    @abstractmethod
    def trigger_ui_update(self, element_id: str, update_type: str, data: dict[str, Any] | None = None) -> Result[None]:
        """Trigger a UI update for a specific element.
        
        Args:
            element_id: Unique identifier of the UI element
            update_type: Type of update to trigger
            data: Optional data for the update
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def batch_ui_updates(self, updates: list[dict[str, Any]]) -> Result[None]:
        """Perform multiple UI updates in a batch.
        
        Args:
            updates: List of update operations to perform
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def register_ui_event_handler(self, element_id: str, event_type: str, handler_id: str) -> Result[None]:
        """Register an event handler for a UI element.
        
        Args:
            element_id: Unique identifier of the UI element
            event_type: Type of event to handle
            handler_id: Unique identifier for the handler
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def unregister_ui_event_handler(self, element_id: str, event_type: str, handler_id: str) -> Result[None]:
        """Unregister an event handler for a UI element.
        
        Args:
            element_id: Unique identifier of the UI element
            event_type: Type of event to stop handling
            handler_id: Unique identifier for the handler
            
        Returns:
            Result indicating success or failure
        """
