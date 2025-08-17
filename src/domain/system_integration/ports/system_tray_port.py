"""System Tray Port for system tray operations."""

from abc import ABC, abstractmethod
from collections.abc import Callable
from enum import Enum
from typing import Any

from src.domain.common.result import Result


class TrayIconState(Enum):
    """System tray icon states."""
    HIDDEN = "hidden"
    VISIBLE = "visible"
    BLINKING = "blinking"
    ATTENTION = "attention"


class TrayMessageType(Enum):
    """System tray message types."""
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class ISystemTrayPort(ABC):
    """Port interface for system tray operations."""
    
    @abstractmethod
    def create_tray_icon(self, icon_path: str, tooltip: str) -> Result[str]:
        """Create system tray icon.
        
        Args:
            icon_path: Path to icon file
            tooltip: Tooltip text
            
        Returns:
            Result containing tray icon ID
        """
        ...
    
    @abstractmethod
    def show_tray_icon(self, icon_id: str) -> Result[None]:
        """Show system tray icon.
        
        Args:
            icon_id: Tray icon identifier
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def hide_tray_icon(self, icon_id: str) -> Result[None]:
        """Hide system tray icon.
        
        Args:
            icon_id: Tray icon identifier
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def update_tray_icon(self, icon_id: str, icon_path: str) -> Result[None]:
        """Update tray icon image.
        
        Args:
            icon_id: Tray icon identifier
            icon_path: New icon path
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def set_tray_tooltip(self, icon_id: str, tooltip: str) -> Result[None]:
        """Set tray icon tooltip.
        
        Args:
            icon_id: Tray icon identifier
            tooltip: Tooltip text
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def show_tray_message(self, icon_id: str, title: str, message: str, message_type: TrayMessageType, duration_ms: int = 3000) -> Result[None]:
        """Show tray notification message.
        
        Args:
            icon_id: Tray icon identifier
            title: Message title
            message: Message text
            message_type: Type of message
            duration_ms: Duration to show message
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def create_tray_menu(self, icon_id: str, menu_items: list[dict[str, Any]]) -> Result[None]:
        """Create context menu for tray icon.
        
        Args:
            icon_id: Tray icon identifier
            menu_items: List of menu item configurations
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def register_tray_callback(self, icon_id: str, event_type: str, callback: Callable[[dict[str, Any]], None]) -> Result[None]:
        """Register callback for tray events.
        
        Args:
            icon_id: Tray icon identifier
            event_type: Type of event (click, double_click, menu_select)
            callback: Callback function
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def set_tray_state(self, icon_id: str, state: TrayIconState) -> Result[None]:
        """Set tray icon state.
        
        Args:
            icon_id: Tray icon identifier
            state: Icon state
            
        Returns:
            Result indicating success or failure
        """
        ...