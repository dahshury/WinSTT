"""Tray Coordination Controller.

This controller coordinates between the UI and the domain system tray entity,
using proper DDD architecture without implementing system tray functionality directly.
"""

from collections.abc import Callable

from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.domain.system_integration.entities.system_tray_integration import (
    SystemTrayIntegration,
    TrayActionType,
    TrayConfiguration,
)
from src_refactored.domain.system_integration.ports.system_tray_port import ISystemTrayPort


class TrayCoordinationController:
    """Controller for coordinating system tray functionality using DDD architecture."""
    
    def __init__(
        self, 
        tray_port: ISystemTrayPort,
        resource_service,
        logger: LoggingPort | None = None,
    ):
        self._tray_port = tray_port
        self._resource_service = resource_service
        self._logger = logger
        self._tray_integration: SystemTrayIntegration | None = None
        self._tray_id: str | None = None
    
    def setup_system_tray(
        self,
        show_window_callback: Callable[[], None],
        settings_callback: Callable[[], None], 
        exit_callback: Callable[[], None],
    ) -> bool:
        """Set up system tray using proper DDD architecture."""
        try:
            # Create tray configuration
            resolved_icon = self._resource_service.get_resource_path("resources/Windows 1 Theta.png")
            icon_path = resolved_icon
            tray_config = TrayConfiguration(
                icon_path=icon_path,
                tooltip="WinSTT - Voice Transcription",
                show_notifications=True,
                auto_hide_on_close=True,
                double_click_action=TrayActionType.SHOW,
            )
            
            # Create domain entity
            self._tray_integration = SystemTrayIntegration(
                tray_id="main_tray",
                configuration=tray_config,
            )
            
            # Create tray icon through adapter
            create_result = self._tray_port.create_tray_icon(icon_path or "", tray_config.tooltip)
            if not create_result.is_success:
                if self._logger:
                    self._logger.log_error(f"Failed to create tray icon: {create_result.error}")
                return False
            
            self._tray_id = create_result.value
            
            # Update domain entity actions with callbacks
            self._tray_integration.update_action("show", callback=show_window_callback)
            self._tray_integration.update_action("settings", callback=settings_callback)
            self._tray_integration.update_action("exit", callback=exit_callback)
            
            # Create tray menu items
            menu_items = [
                {
                    "text": "Settings",
                    "callback": settings_callback,
                },
            ]
            
            # Ensure the adapter creates the base menu and then add custom items
            menu_result = self._tray_port.create_tray_menu(self._tray_id or "", menu_items)
            if not menu_result.is_success and self._logger:
                self._logger.log_warning(f"Failed to create tray menu: {menu_result.error}")
            
            # Register callbacks for tray events
            self._tray_port.register_tray_callback(
                self._tray_id or "", 
                "show_window", 
                lambda event: show_window_callback(),
            )
            
            self._tray_port.register_tray_callback(
                self._tray_id or "",
                "settings",
                lambda event: settings_callback(),
            )
            
            self._tray_port.register_tray_callback(
                self._tray_id or "",
                "close_app",
                lambda event: exit_callback(),
            )
            
            # Show the tray icon using domain entity
            self._tray_integration.show_tray()
            show_result = self._tray_port.show_tray_icon(self._tray_id or "")
            
            if not show_result.is_success:
                if self._logger:
                    self._logger.log_error(f"Failed to show tray icon: {show_result.error}")
                return False
            
            if self._logger:
                self._logger.log_info("System tray setup completed using DDD architecture")
            
            return True
            
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error setting up system tray: {e}")
            return False
    
    def show_tray_notification(self, title: str, message: str) -> None:
        """Show a tray notification using domain entity."""
        if self._tray_integration and self._tray_id:
            try:
                # Use domain entity for business logic
                self._tray_integration.show_notification(title, message)
                
                # Delegate to infrastructure through port
                from src_refactored.domain.system_integration.ports.system_tray_port import (
                    TrayMessageType,
                )
                self._tray_port.show_tray_message(
                    self._tray_id,
                    title,
                    message,
                    TrayMessageType.INFO,
                )
                
            except Exception as e:
                if self._logger:
                    self._logger.log_error(f"Error showing tray notification: {e}")
    
    def execute_tray_action(self, action_id: str) -> None:
        """Execute a tray action using domain entity."""
        if self._tray_integration:
            try:
                self._tray_integration.execute_action(action_id)
            except Exception as e:
                if self._logger:
                    self._logger.log_error(f"Error executing tray action '{action_id}': {e}")
    
    def is_tray_supported(self) -> bool:
        """Check if system tray is supported."""
        if self._tray_integration:
            return self._tray_integration.is_supported
        return False
    
    def is_tray_visible(self) -> bool:
        """Check if tray is currently visible."""
        if self._tray_integration:
            return self._tray_integration.is_visible
        return False
    
    def get_tray_status(self) -> dict | None:
        """Get tray status summary for debugging."""
        if self._tray_integration:
            return self._tray_integration.get_status_summary()
        return None
    
    def cleanup(self) -> None:
        """Clean up tray resources."""
        try:
            if self._tray_integration:
                self._tray_integration.hide_tray()
            
            # Clean up through adapter
            if hasattr(self._tray_port, "cleanup"):
                self._tray_port.cleanup()
            
            if self._logger:
                self._logger.log_info("Tray coordination controller cleaned up")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error during tray cleanup: {e}")

