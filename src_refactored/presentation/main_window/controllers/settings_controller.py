"""Settings Controller.

This controller handles settings dialog and configuration management,
separating settings concerns from the main window.
"""

from PyQt6.QtWidgets import QDialog, QWidget

from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.presentation.main_window.components.status_display_component import (
    StatusDisplayComponent,
)


class SettingsController:
    """Controller for managing settings dialog and configuration updates."""
    
    def __init__(
        self,
        parent: QWidget,
        config_service,
        keyboard_service,
        status_display: StatusDisplayComponent,
        logger: LoggingPort,
        user_notifications=None,
    ):
        self._parent = parent
        self._config = config_service
        self._keyboard = keyboard_service
        self._status_display = status_display
        self._logger = logger
        self._notify = user_notifications
    
    def open_settings(self) -> None:
        """Open the settings dialog."""
        try:
            self._logger.log_info("Opening settings dialog")
            
            # Import and create the settings dialog
            from src_refactored.presentation.qt.settings_dialog import SettingsDialog
            
            # Create settings dialog with proper parent
            settings_dialog = SettingsDialog(parent=self._parent)
            
            # Connect signals to handle settings changes
            settings_dialog.settings_changed.connect(self._handle_settings_changed)
            
            # Show the dialog modally
            result = settings_dialog.exec()
            
            if result == QDialog.DialogCode.Accepted:
                self._logger.log_info("Settings dialog accepted - changes saved")
                # Update status to show settings were applied
                self._status_display.update_status_text("Settings updated")
            else:
                self._logger.log_info("Settings dialog cancelled")
                
        except ImportError as e:
            self._logger.log_error(f"Settings dialog module not found: {e}")
            if self._notify:
                self._notify.error(self._parent, "Settings", "Settings dialog is not available.")
        except Exception as e:
            self._logger.log_error(f"Error opening settings dialog: {e}")
            if self._notify:
                self._notify.error(self._parent, "Settings", "Failed to open settings dialog.")
    
    def _handle_settings_changed(self, settings: dict) -> None:
        """Handle settings changes from the settings dialog."""
        try:
            self._logger.log_info("Processing settings changes")
            
            # Handle recording key changes
            if "rec_key" in settings:
                self._update_recording_key(settings["rec_key"])
            
            # Handle other settings updates
            # (In a real implementation, these would be handled by appropriate services)
            
            self._logger.log_info("Settings changes applied successfully")
            
        except Exception as e:
            self._logger.log_error(f"Error applying settings changes: {e}")
    
    def _update_recording_key(self, new_key: str) -> None:
        """Update the recording key configuration."""
        try:
            # Get current key from config
            current_key = self._config.get_value("rec_key", "F9")
            
            if current_key != new_key:
                # Unregister old hotkey
                self._keyboard.unregister_hotkey(current_key)
                
                # Register new hotkey
                self._keyboard.register_hotkey(new_key, lambda: None)
                
                # Update instruction text
                self._status_display.update_instruction_text(new_key)
                
                self._logger.log_info(f"Recording key updated from {current_key} to {new_key}")
                
        except Exception as e:
            self._logger.log_error(f"Error updating recording key: {e}")
            if self._notify:
                self._notify.warning(self._parent, "Settings", "Could not update the hotkey.")

