"""UI Abstractions for Domain Layer.

This module provides generic UI abstractions that are framework-independent.
"""

from abc import ABC, abstractmethod
from typing import Any


class IUIWidget(ABC):
    """Abstract base class for UI widgets."""

    @abstractmethod
    def get_widget_id(self) -> str:
        """Get unique widget identifier.
        
        Returns:
            Widget identifier
        """
        ...

    @abstractmethod
    def set_property(self, name: str, value: Any) -> bool:
        """Set widget property.
        
        Args:
            name: Property name
            value: Property value
            
        Returns:
            True if property was set successfully
        """
        ...

    @abstractmethod
    def get_property(self, name: str) -> Any:
        """Get widget property.
        
        Args:
            name: Property name
            
        Returns:
            Property value or None if not found
        """
        ...

    @abstractmethod
    def is_valid(self) -> bool:
        """Check if widget is valid.
        
        Returns:
            True if widget is valid
        """
        ...


class IUIWindow(IUIWidget):
    """Abstract base class for UI windows."""

    @abstractmethod
    def set_title(self, title: str) -> None:
        """Set window title.
        
        Args:
            title: Window title
        """
        ...

    @abstractmethod
    def get_title(self) -> str:
        """Get window title.
        
        Returns:
            Current window title
        """
        ...

    @abstractmethod
    def set_size(self, width: int, height: int) -> None:
        """Set window size.
        
        Args:
            width: Window width
            height: Window height
        """
        ...

    @abstractmethod
    def get_size(self) -> tuple[int, int]:
        """Get window size.
        
        Returns:
            Tuple of (width, height)
        """
        ...

    @abstractmethod
    def show(self) -> None:
        """Show the window."""
        ...

    @abstractmethod
    def hide(self) -> None:
        """Hide the window."""
        ...

    @abstractmethod
    def close(self) -> None:
        """Close the window."""
        ...

    @abstractmethod
    def is_visible(self) -> bool:
        """Check if window is visible.
        
        Returns:
            True if window is visible
        """
        ...


class IUIContainer(IUIWidget):
    """Abstract base class for UI containers."""

    @abstractmethod
    def add_child(self, child: IUIWidget) -> bool:
        """Add child widget.
        
        Args:
            child: Child widget to add
            
        Returns:
            True if child was added successfully
        """
        ...

    @abstractmethod
    def remove_child(self, child: IUIWidget) -> bool:
        """Remove child widget.
        
        Args:
            child: Child widget to remove
            
        Returns:
            True if child was removed successfully
        """
        ...

    @abstractmethod
    def get_children(self) -> list[IUIWidget]:
        """Get all child widgets.
        
        Returns:
            List of child widgets
        """
        ...


class UIWidgetFactory(ABC):
    """Abstract factory for creating UI widgets."""

    @abstractmethod
    def create_window(self, **kwargs: Any) -> IUIWindow:
        """Create a new window.
        
        Returns:
            New window instance
        """
        ...

    @abstractmethod
    def create_container(self, **kwargs: Any) -> IUIContainer:
        """Create a new container.
        
        Returns:
            New container instance
        """
        ...

    @abstractmethod
    def create_widget(self, widget_type: str, **kwargs: Any) -> IUIWidget:
        """Create a generic widget.
        
        Args:
            widget_type: Type of widget to create
            **kwargs: Widget configuration
            
        Returns:
            New widget instance
        """
        ...
