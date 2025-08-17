"""Settings Controller.

This controller handles settings dialog and configuration management,
separating settings concerns from the main window.
"""

from contextlib import suppress

from PyQt6.QtWidgets import QDialog, QWidget

from src.domain.common.ports.logging_port import LoggingPort
from src.presentation.main_window.components.status_display_component import (
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
        resource_service=None,
    ):
        self._parent = parent
        self._config = config_service
        self._keyboard = keyboard_service
        self._status_display = status_display
        self._logger = logger
        self._notify = user_notifications
        self._resources = resource_service
        self._dialog_ref: QDialog | None = None
    
    def open_settings(self) -> None:
        """Open the settings dialog."""
        try:
            self._logger.log_info("Opening settings dialog")
            
            # Import and create the settings dialog
            from src.presentation.qt.services.file_dialog_service import FileDialogService
            from src.presentation.qt.settings_dialog import SettingsDialog
            from src.presentation.qt.settings_dialog_impl import SettingsDialogData
            
            # Prevent multiple dialogs (tray or button)
            if self._dialog_ref is not None and self._dialog_ref.isVisible():
                with suppress(Exception):
                    self._dialog_ref.raise_()
                    self._dialog_ref.activateWindow()
                return

            # Create settings dialog with proper parent
            settings_dialog = SettingsDialog(parent=self._parent, resource_service=self._resources)
            self._dialog_ref = settings_dialog

            # Load current settings from config and inject into dialog
            with suppress(Exception):
                current = SettingsDialogData(
                    model=str(self._config.get_setting("model", "whisper-turbo")),
                    quantization=str(self._config.get_setting("quantization", "Full")),
                    rec_key=str(self._config.get_setting("rec_key", "F9")),
                    recording_sound=bool(self._config.get_setting("recording_sound", True)),
                    sound_path=str(self._config.get_setting("sound_path", "@resources/splash.wav")),
                    output_srt=bool(self._config.get_setting("output_srt", False)),
                    llm_enabled=bool(self._config.get_setting("llm_enabled", False)),
                    llm_model=str(self._config.get_setting("llm_model", "gemma-3-1b-it")),
                    llm_quantization=str(self._config.get_setting("llm_quantization", "Full")),
                    llm_prompt=str(self._config.get_setting("llm_prompt", "You are a helpful assistant.")),
                )
                settings_dialog.set_data(current)
            
            # Connect signals to handle settings changes
            settings_dialog.settings_changed.connect(self._handle_settings_changed)

            # Wire reset and browse actions for full functionality
            with suppress(Exception):
                # Reset handlers
                def _handle_reset(field: str) -> None:
                    defaults = SettingsDialogData()
                    if field == "all":
                        settings_dialog.set_data(defaults)
                        self._persist_settings({
                            "model": defaults.model,
                            "quantization": defaults.quantization,
                            "rec_key": defaults.rec_key,
                            "recording_sound": defaults.recording_sound,
                            "sound_path": defaults.sound_path,
                            "output_srt": defaults.output_srt,
                            "llm_enabled": defaults.llm_enabled,
                            "llm_model": defaults.llm_model,
                            "llm_quantization": defaults.llm_quantization,
                            "llm_prompt": defaults.llm_prompt,
                        })
                        # Ensure hotkey reflects default immediately
                        self._update_recording_key(defaults.rec_key)
                        return

                    # Individual field reset
                    field_to_value = {
                        "model": defaults.model,
                        "quantization": defaults.quantization,
                        "rec_key": defaults.rec_key,
                        "sound_path": defaults.sound_path,
                        "llm_model": defaults.llm_model,
                        "llm_quantization": defaults.llm_quantization,
                    }
                    if field in field_to_value:
                        value = field_to_value[field]
                        try:
                            # Dialog has a helper for targeted resets
                            settings_dialog.reset_field(field, value)  # type: ignore[attr-defined]
                        except Exception:
                            # Fallback: rebuild full data snapshot
                            cur = SettingsDialogData()
                            settings_dialog.set_data(cur)
                        # Persist single field
                        key_map = {
                            "model": "model",
                            "quantization": "quantization",
                            "rec_key": "rec_key",
                            "sound_path": "sound_path",
                            "llm_model": "llm_model",
                            "llm_quantization": "llm_quantization",
                        }
                        self._config.save_setting(key_map[field], value)
                        if field == "rec_key":
                            self._update_recording_key(value)

                # Browse handler
                def _handle_browse() -> None:
                    fds = FileDialogService(self._parent)
                    result = fds.open_single_file(
                        parent=self._parent,
                        title="Select Sound File",
                        filters=fds.get_audio_filters(),
                        default_filter="Audio Files (*.mp3 *.wav *.flac *.m4a *.aac *.ogg *.wma)",
                    )
                    if result.success and result.file:
                        settings_dialog.set_sound_path(result.file)
                        self._config.save_setting("sound_path", result.file)

                with suppress(Exception):
                    settings_dialog.reset_requested.connect(_handle_reset)  # type: ignore[attr-defined]
                with suppress(Exception):
                    settings_dialog.sound_file_browse_requested.connect(_handle_browse)  # type: ignore[attr-defined]
            
            # Show the dialog modally
            result = settings_dialog.exec()
            
            if result == QDialog.DialogCode.Accepted:
                self._logger.log_info("Settings dialog accepted - changes saved")
                # Update status to show settings were applied
                self._status_display.update_status_text("Settings updated")
            else:
                self._logger.log_info("Settings dialog cancelled")
            self._dialog_ref = None
                
        except ImportError as e:
            self._logger.log_error(f"Settings dialog module not found: {e}")
            if self._notify:
                self._notify.error(self._parent, "Settings", "Settings dialog is not available.")
        except Exception as e:
            self._logger.log_error(f"Error opening settings dialog: {e}")
            if self._notify:
                self._notify.error(self._parent, "Settings", "Failed to open settings dialog.")
        finally:
            # Safety: clear reference if modal closed unexpectedly
            if self._dialog_ref is not None and not self._dialog_ref.isVisible():
                self._dialog_ref = None
    
    def _handle_settings_changed(self, settings: dict) -> None:
        """Handle settings changes from the settings dialog."""
        try:
            self._logger.log_info("Processing settings changes")
            
            # Handle recording key changes
            if "rec_key" in settings:
                self._update_recording_key(settings["rec_key"])
            
            # Persist settings to configuration file
            self._persist_settings(settings)
            
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
                # Persist change immediately
                with suppress(Exception):
                    self._config.save_setting("rec_key", new_key)
                
        except Exception as e:
            self._logger.log_error(f"Error updating recording key: {e}")
            if self._notify:
                self._notify.warning(self._parent, "Settings", "Could not update the hotkey.")

    def _persist_settings(self, settings: dict) -> None:
        """Persist provided settings to configuration storage."""
        try:
            persistable_keys = {
                "model",
                "quantization",
                "rec_key",
                "recording_sound",
                "sound_path",
                "output_srt",
                "llm_enabled",
                "llm_model",
                "llm_quantization",
                "llm_prompt",
            }
            for key, value in settings.items():
                if key in persistable_keys:
                    self._config.save_setting(key, value)
        except Exception as e:
            self._logger.log_warning(f"Failed to persist some settings: {e}")

