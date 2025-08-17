"""Main Window Instance Entity.

This module defines the domain entity for main window instances.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from src.domain.common.domain_utils import DomainIdentityGenerator


@dataclass
class WindowGeometry:
    """Value object for window geometry."""
    x: int
    y: int
    width: int
    height: int


@dataclass
class MainWindowInstance:
    """Domain entity representing a main window instance."""
    
    window_id: str
    title: str
    geometry: WindowGeometry
    is_visible: bool = False
    is_maximized: bool = False
    is_minimized: bool = False
    created_at: datetime = field(default_factory=lambda: datetime.fromtimestamp(DomainIdentityGenerator.generate_timestamp()))
    properties: dict[str, Any] = field(default_factory=dict)
    
    def show(self) -> None:
        """Mark window as visible."""
        self.is_visible = True
        self.is_minimized = False
    
    def hide(self) -> None:
        """Mark window as hidden."""
        self.is_visible = False
    
    def maximize(self) -> None:
        """Mark window as maximized."""
        self.is_maximized = True
        self.is_minimized = False
    
    def minimize(self) -> None:
        """Mark window as minimized."""
        self.is_minimized = True
        self.is_maximized = False
    
    def restore(self) -> None:
        """Restore window to normal state."""
        self.is_maximized = False
        self.is_minimized = False
    
    def set_geometry(self, x: int, y: int, width: int, height: int) -> None:
        """Set window geometry.
        
        Args:
            x: X position
            y: Y position
            width: Window width
            height: Window height
        """
        self.geometry = WindowGeometry(x, y, width, height)
    
    def set_title(self, title: str) -> None:
        """Set window title.
        
        Args:
            title: New window title
        """
        self.title = title
    
    def set_property(self, key: str, value: Any) -> None:
        """Set window property.
        
        Args:
            key: Property key
            value: Property value
        """
        self.properties[key] = value
    
    def get_property(self, key: str, default: Any = None) -> Any:
        """Get window property.
        
        Args:
            key: Property key
            default: Default value if key not found
            
        Returns:
            Property value or default
        """
        return self.properties.get(key, default)
    
    def is_in_normal_state(self) -> bool:
        """Check if window is in normal state.
        
        Returns:
            True if window is not maximized or minimized
        """
        return not self.is_maximized and not self.is_minimized
