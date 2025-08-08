"""Qt System Tray Adapter.

This adapter implements ISystemTrayPort to manage system tray functionality
using Qt/PyQt6, following the hexagonal architecture pattern.
"""

from collections.abc import Callable
from typing import Any

from PyQt6.QtWidgets import QSystemTrayIcon

from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.domain.common.result import Result
from src_refactored.domain.system_integration.ports.system_tray_port import (
    ISystemTrayPort,
    TrayIconState,
    TrayMessageType,
)
from src_refactored.infrastructure.system.tray_icon_service import TrayIconService


class QtSystemTrayAdapter(ISystemTrayPort):
    """Adapter for system tray operations using Qt implementation."""
    
    def __init__(self, resource_service, logger: LoggingPort | None = None):
        self._resource_service = resource_service
        self._logger = logger
        self._tray_services: dict[str, TrayIconService] = {}
        self._callbacks: dict[str, dict[str, Callable]] = {}
    
    def create_tray_icon(self, icon_path: str, tooltip: str) -> Result[str]:
        """Create system tray icon using TrayIconService."""
        try:
            # Generate unique tray ID
            tray_id = f"tray_{len(self._tray_services)}"
            
            # Resolve icon path through resource service
            resolved_icon_path = self._resource_service.get_resource_path(icon_path)
            
            # Create tray service
            tray_service = TrayIconService(app_name=tooltip, icon_path=resolved_icon_path)
            
            # Create and show tray icon
            if not tray_service.create_tray_icon():
                return Result.failure("Failed to create system tray icon")
            
            # Store service and initialize callbacks
            self._tray_services[tray_id] = tray_service
            self._callbacks[tray_id] = {}
            
            if self._logger:
                self._logger.log_info(f"System tray icon created with ID: {tray_id}")
            
            return Result.success(tray_id)
            
        except Exception as e:
            error_msg = f"Error creating tray icon: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def show_tray_icon(self, icon_id: str) -> Result[None]:
        """Show system tray icon."""
        try:
            tray_service = self._tray_services.get(icon_id)
            if not tray_service:
                return Result.failure(f"Tray icon with ID '{icon_id}' not found")
            
            if not tray_service.show_tray_icon():
                return Result.failure("Failed to show tray icon")
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error showing tray icon: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def hide_tray_icon(self, icon_id: str) -> Result[None]:
        """Hide system tray icon."""
        try:
            tray_service = self._tray_services.get(icon_id)
            if not tray_service:
                return Result.failure(f"Tray icon with ID '{icon_id}' not found")
            
            tray_service.hide_tray_icon()
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error hiding tray icon: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def update_tray_icon(self, icon_id: str, icon_path: str) -> Result[None]:
        """Update tray icon image."""
        try:
            tray_service = self._tray_services.get(icon_id)
            if not tray_service:
                return Result.failure(f"Tray icon with ID '{icon_id}' not found")
            
            # Resolve icon path through resource service
            resolved_icon_path = self._resource_service.get_resource_path(icon_path)
            
            if not tray_service.update_icon(resolved_icon_path):
                return Result.failure("Failed to update tray icon")
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error updating tray icon: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def set_tray_tooltip(self, icon_id: str, tooltip: str) -> Result[None]:
        """Set tray icon tooltip."""
        try:
            tray_service = self._tray_services.get(icon_id)
            if not tray_service:
                return Result.failure(f"Tray icon with ID '{icon_id}' not found")
            
            tray_service.update_tooltip(tooltip)
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error setting tray tooltip: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def show_tray_message(
        self, 
        icon_id: str, 
        title: str, 
        message: str, 
        message_type: TrayMessageType, 
        duration_ms: int = 3000,
    ) -> Result[None]:
        """Show tray notification message."""
        try:
            tray_service = self._tray_services.get(icon_id)
            if not tray_service:
                return Result.failure(f"Tray icon with ID '{icon_id}' not found")
            
            # Convert message type to Qt enum
            qt_icon_type = self._convert_message_type(message_type)
            
            tray_service.show_message(title, message, qt_icon_type, duration_ms)
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error showing tray message: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def create_tray_menu(self, icon_id: str, menu_items: list[dict[str, Any]]) -> Result[None]:
        """Create context menu for tray icon."""
        try:
            tray_service = self._tray_services.get(icon_id)
            if not tray_service:
                return Result.failure(f"Tray icon with ID '{icon_id}' not found")
            
            # Add custom menu items (avoid duplicating default entries)
            default_labels = {"Show", "Settings", "Exit"}
            for item in menu_items:
                text = item.get("text", "")
                callback = item.get("callback")
                shortcut = item.get("shortcut")
                
                if text and callback and text not in default_labels:
                    tray_service.add_menu_action(text, callback, shortcut)
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error creating tray menu: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def register_tray_callback(
        self, 
        icon_id: str, 
        event_type: str, 
        callback: Callable[[dict[str, Any]], None],
    ) -> Result[None]:
        """Register callback for tray events."""
        try:
            tray_service = self._tray_services.get(icon_id)
            if not tray_service:
                return Result.failure(f"Tray icon with ID '{icon_id}' not found")
            
            # Store callback for this tray and event type
            if icon_id not in self._callbacks:
                self._callbacks[icon_id] = {}
            self._callbacks[icon_id][event_type] = callback
            
            # Connect to appropriate signal based on event type
            if event_type == "show_window":
                tray_service.show_window_requested.connect(
                    lambda: callback({"event": "show_window"}),
                )
            elif event_type == "settings":
                tray_service.settings_requested.connect(
                    lambda: callback({"event": "settings"}),
                )
            elif event_type == "close_app":
                tray_service.close_app_requested.connect(
                    lambda: callback({"event": "close_app"}),
                )
            elif event_type == "tray_activated":
                # Reason is emitted as int; pass through directly
                tray_service.tray_activated.connect(
                    lambda reason: callback({"event": "tray_activated", "reason": reason}),
                )
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error registering tray callback: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def set_tray_state(self, icon_id: str, state: TrayIconState) -> Result[None]:
        """Set tray icon state."""
        try:
            tray_service = self._tray_services.get(icon_id)
            if not tray_service:
                return Result.failure(f"Tray icon with ID '{icon_id}' not found")
            
            # Handle different states
            if state == TrayIconState.VISIBLE:
                if not tray_service.show_tray_icon():
                    return Result.failure("Failed to show tray icon")
            elif state == TrayIconState.HIDDEN:
                tray_service.hide_tray_icon()
            elif state == TrayIconState.BLINKING:
                # Qt doesn't have built-in blinking, could implement custom logic
                pass
            elif state == TrayIconState.ATTENTION:
                # Could use tray message to get attention
                tray_service.show_message(
                    "WinSTT", 
                    "Attention required", 
                    QSystemTrayIcon.MessageIcon.Warning,
                    1000,
                )
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error setting tray state: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def _convert_message_type(self, message_type: TrayMessageType) -> QSystemTrayIcon.MessageIcon:
        """Convert domain message type to Qt enum."""
        mapping = {
            TrayMessageType.INFO: QSystemTrayIcon.MessageIcon.Information,
            TrayMessageType.WARNING: QSystemTrayIcon.MessageIcon.Warning,
            TrayMessageType.ERROR: QSystemTrayIcon.MessageIcon.Critical,
            TrayMessageType.CRITICAL: QSystemTrayIcon.MessageIcon.Critical,
        }
        return mapping.get(message_type, QSystemTrayIcon.MessageIcon.Information)
    
    def cleanup(self) -> None:
        """Clean up all tray icons and resources."""
        try:
            for tray_service in self._tray_services.values():
                tray_service.cleanup()
            
            self._tray_services.clear()
            self._callbacks.clear()
            
            if self._logger:
                self._logger.log_info("System tray adapter cleaned up")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error during tray cleanup: {e}")
    
    def get_tray_service(self, icon_id: str) -> TrayIconService | None:
        """Get the underlying tray service for advanced operations."""
        return self._tray_services.get(icon_id)

