"""Settings Dialog Coordinator (Presentation layer).

Moved from Infrastructure to Presentation per hexagonal architecture. Imports now
reference `presentation/core` abstractions.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
import contextlib

from PyQt6.QtCore import QObject, QTimer, pyqtSignal

from src_refactored.infrastructure.presentation.qt.ui_core_abstractions import (
    IUIEventHandler,
    UIEventType,
)
from src_refactored.presentation.core.abstractions import (
    IUIComponent,
    Result,
)
from src_refactored.presentation.core.container import injectable

if TYPE_CHECKING:
    from PyQt6.QtWidgets import QWidget

    from src_refactored.infrastructure.presentation.qt.ui_core_abstractions import UIEvent

    from .settings_dialog_impl import SettingsDialog, SettingsDialogData


@dataclass
class SettingsDialogState:
    """State object for settings dialog."""
    current_model: str
    current_quantization: str
    enable_rec_sound: bool
    current_sound_path: str
    current_output_srt: bool
    current_rec_key: str
    current_llm_enabled: bool
    current_llm_model: str
    current_llm_quantization: str
    current_llm_prompt: str
    is_downloading_model: bool = False
    recording_key: str = ""
    pressed_keys: set[str] | None = None
    
    def __post_init__(self):
        if self.pressed_keys is None:
            self.pressed_keys = set()


@dataclass
class SettingsDialogDefaults:
    """Default values for settings dialog."""
    model: str = "whisper-turbo"
    quantization: str = "Full"
    recording_sound: bool = True
    sound_path: str = "resources/splash.mp3"
    output_srt: bool = False
    rec_key: str = "CTRL+ALT+A"
    llm_enabled: bool = False
    llm_model: str = "gemma-3-1b-it"
    llm_quantization: str = "Full"
    llm_prompt: str = "You are a helpful assistant."


class ISettingsService:
    """Interface for settings service."""
    
    def load_settings(self) -> dict[str, Any]:
        """Load settings from storage."""
        raise NotImplementedError
    
    def save_settings(self, settings: dict[str, Any]) -> Result[None]:
        """Save settings to storage."""
        raise NotImplementedError
    
    def get_default_settings(self) -> SettingsDialogDefaults:
        """Get default settings."""
        raise NotImplementedError


class IProgressService:
    """Interface for progress service."""
    
    def show_progress(self, message: str) -> None:
        """Show progress indicator."""
        raise NotImplementedError
    
    def hide_progress(self) -> None:
        """Hide progress indicator."""
        raise NotImplementedError
    
    def update_progress(self, value: int, message: str = "") -> None:
        """Update progress value."""
        raise NotImplementedError


@injectable()
class SettingsDialogCoordinator(QObject, IUIComponent, IUIEventHandler):
    """Coordinates settings dialog operations and event handling."""
    
    # Signals for communication
    settings_changed = pyqtSignal(dict)  # Emitted when settings change
    model_download_started = pyqtSignal(str)  # Emitted when model download starts
    model_download_completed = pyqtSignal(str)  # Emitted when model download completes
    model_download_failed = pyqtSignal(str)  # Emitted when model download fails
    progress_update = pyqtSignal(int, str)  # Emitted for progress updates
    
    def __init__(self, 
                 settings_service: ISettingsService,
                 progress_service: IProgressService,
                 parent: QWidget | None = None):
        super().__init__(parent)
        self.settings_service = settings_service
        self.progress_service = progress_service
        self.parent_window = parent
        self.logger = logging.getLogger(__name__)
        
        # Initialize state
        self.defaults = self.settings_service.get_default_settings()
        self.state = self._create_initial_state()
        
        # Supported file types for drag and drop
        self.supported_file_types = [".mp3", ".wav", ".ogg", ".flac", ".aac", ".wma", ".m4a"]
        
        # Debounce timer for progress bar operations
        self.progress_timer = QTimer()
        self.progress_timer.setSingleShot(True)
        self.progress_timer.setInterval(200)  # 200ms debounce
        
        # Tracking flags
        self.is_progress_bar_moving = False
        self.reset_buttons: list[QWidget] = []
        
        # Load initial settings
        self._load_settings()
        
        # Dialog reference
        self._dialog: SettingsDialog | None = None
    
    def _create_initial_state(self) -> SettingsDialogState:
        """Create initial state from defaults."""
        return SettingsDialogState(
            current_model=self.defaults.model,
            current_quantization=self.defaults.quantization,
            enable_rec_sound=self.defaults.recording_sound,
            current_sound_path=self.defaults.sound_path,
            current_output_srt=self.defaults.output_srt,
            current_rec_key=self.defaults.rec_key,
            current_llm_enabled=self.defaults.llm_enabled,
            current_llm_model=self.defaults.llm_model,
            current_llm_quantization=self.defaults.llm_quantization,
            current_llm_prompt=self.defaults.llm_prompt,
        )
    
    def _load_settings(self) -> None:
        """Load settings from storage and update state."""
        try:
            settings = self.settings_service.load_settings()
            
            # Update state with loaded settings
            self.state.current_model = settings.get("model", self.defaults.model)
            self.state.current_quantization = settings.get("quantization", self.defaults.quantization)
            self.state.enable_rec_sound = settings.get("recording_sound", self.defaults.recording_sound)
            self.state.current_sound_path = settings.get("sound_path", self.defaults.sound_path)
            self.state.current_output_srt = settings.get("output_srt", self.defaults.output_srt)
            self.state.current_rec_key = settings.get("rec_key", self.defaults.rec_key)
            self.state.current_llm_enabled = settings.get("llm_enabled", self.defaults.llm_enabled)
            self.state.current_llm_model = settings.get("llm_model", self.defaults.llm_model)
            self.state.current_llm_quantization = settings.get("llm_quantization", self.defaults.llm_quantization)
            self.state.current_llm_prompt = settings.get("llm_prompt", self.defaults.llm_prompt)
            
            self.logger.info("Settings loaded successfully")
            
        except Exception as e:
            self.logger.exception(f"Failed to load settings: {e}")
            # Keep default state on error
    
    def save_settings(self) -> Result[None]:
        """Save current state to storage."""
        try:
            settings = {
                "model": self.state.current_model,
                "quantization": self.state.current_quantization,
                "recording_sound": self.state.enable_rec_sound,
                "sound_path": self.state.current_sound_path,
                "output_srt": self.state.current_output_srt,
                "rec_key": self.state.current_rec_key,
                "llm_enabled": self.state.current_llm_enabled,
                "llm_model": self.state.current_llm_model,
                "llm_quantization": self.state.current_llm_quantization,
                "llm_prompt": self.state.current_llm_prompt,
            }
            
            result = self.settings_service.save_settings(settings)
            if result.is_success:
                self.settings_changed.emit(settings)
                self.logger.info("Settings saved successfully")
            
            return result
            
        except Exception as e:
            error_msg = f"Failed to save settings: {e}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def handle_model_changed(self, model: str) -> None:
        """Handle model selection change."""
        if model != self.state.current_model:
            self.state.current_model = model
            self.save_settings()
            self.logger.info(f"Model changed to: {model}")
    
    def handle_quantization_changed(self, quantization: str) -> None:
        """Handle quantization change."""
        if quantization != self.state.current_quantization:
            self.state.current_quantization = quantization
            self.save_settings()
            self.logger.info(f"Quantization changed to: {quantization}")
    
    def handle_recording_sound_changed(self, enabled: bool, sound_path: str | None = None) -> None:
        """Handle recording sound settings change."""
        changed = False
        
        if enabled != self.state.enable_rec_sound:
            self.state.enable_rec_sound = enabled
            changed = True
        
        if sound_path and sound_path != self.state.current_sound_path:
            self.state.current_sound_path = sound_path
            changed = True
        
        if changed:
            self.save_settings()
            self.logger.info(f"Recording sound settings changed: enabled={enabled}, path={sound_path}")
    
    def handle_srt_output_changed(self, enabled: bool) -> None:
        """Handle SRT output setting change."""
        if enabled != self.state.current_output_srt:
            self.state.current_output_srt = enabled
            self.save_settings()
            self.logger.info(f"SRT output changed to: {enabled}")
    
    def handle_llm_settings_changed(self, enabled: bool | None = None, model: str | None = None, 
                                   quantization: str | None = None, prompt: str | None = None) -> None:
        """Handle LLM settings change."""
        changed = False
        
        if enabled is not None and enabled != self.state.current_llm_enabled:
            self.state.current_llm_enabled = enabled
            changed = True
        
        if model and model != self.state.current_llm_model:
            self.state.current_llm_model = model
            changed = True
        
        if quantization and quantization != self.state.current_llm_quantization:
            self.state.current_llm_quantization = quantization
            changed = True
        
        if prompt and prompt != self.state.current_llm_prompt:
            self.state.current_llm_prompt = prompt
            changed = True
        
        if changed:
            self.save_settings()
            self.logger.info("LLM settings changed")
    
    def handle_hotkey_changed(self, hotkey: str) -> None:
        """Handle hotkey change."""
        if hotkey != self.state.current_rec_key:
            self.state.current_rec_key = hotkey
            self.save_settings()
            self.logger.info(f"Hotkey changed to: {hotkey}")
    
    def handle_file_drop(self, file_path: str) -> Result[None]:
        """Handle file drop for sound file selection."""
        try:
            # Validate file type
            if not any(file_path.lower().endswith(ext) for ext in self.supported_file_types):
                return Result.failure(f"Unsupported file type. Supported: {', '.join(self.supported_file_types)}")
            
            # Update sound path
            self.handle_recording_sound_changed(self.state.enable_rec_sound, file_path)
            
            # Notify parent window if available
            if self.parent_window and hasattr(self.parent_window, "display_message"):
                self.parent_window.display_message(txt=f"Recording sound updated to {os.path.basename(file_path)}")
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to handle file drop: {e}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def reset_all_settings(self) -> None:
        """Reset all settings to defaults."""
        try:
            self.state = self._create_initial_state()
            self.save_settings()
            self.logger.info("All settings reset to defaults")
            
        except Exception as e:
            self.logger.exception(f"Failed to reset settings: {e}")
    
    def start_model_download(self, model_name: str) -> None:
        """Start model download process."""
        self.state.is_downloading_model = True
        self._disable_reset_buttons()
        self.model_download_started.emit(model_name)
        self.progress_service.show_progress(f"Downloading {model_name}...")
        self.logger.info(f"Started downloading model: {model_name}")
    
    def complete_model_download(self, model_name: str) -> None:
        """Complete model download process."""
        self.state.is_downloading_model = False
        self._enable_reset_buttons()
        self.model_download_completed.emit(model_name)
        self.progress_service.hide_progress()
        self.logger.info(f"Completed downloading model: {model_name}")
    
    def fail_model_download(self, model_name: str, error: str) -> None:
        """Handle model download failure."""
        self.state.is_downloading_model = False
        self._enable_reset_buttons()
        self.model_download_failed.emit(error)
        self.progress_service.hide_progress()
        self.logger.error(f"Failed to download model {model_name}: {error}")
    
    def _disable_reset_buttons(self) -> None:
        """Disable reset buttons during operations."""
        for button in self.reset_buttons:
            if button:
                button.setEnabled(False)
    
    def _enable_reset_buttons(self) -> None:
        """Enable reset buttons after operations."""
        for button in self.reset_buttons:
            if button:
                button.setEnabled(True)
    
    def add_reset_button(self, button: QWidget) -> None:
        """Add a reset button to be managed."""
        self.reset_buttons.append(button)
    
    def get_current_state(self) -> SettingsDialogState:
        """Get current dialog state."""
        return self.state
    
    def handle_event(self, event: "UIEvent") -> Result[None]:
        """Handle UI events."""
        try:
            # Extract event id from event.data if present
            event_id = ""
            with contextlib.suppress(Exception):
                event_id = str(event.data.get("event_id", ""))

            if event_id == "SETTINGS_CHANGED":
                # Handle settings change event
                self.save_settings()
            elif event_id == "MODEL_DOWNLOAD_STARTED":
                # Handle model download start
                model_name = event.data.get("model_name", "Unknown")
                self.start_model_download(model_name)
            elif event_id == "MODEL_DOWNLOAD_COMPLETED":
                # Handle model download completion
                model_name = event.data.get("model_name", "Unknown")
                self.complete_model_download(model_name)
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to handle event {getattr(event, 'event_id', '')}: {e}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def initialize(self) -> Result[None]:
        """Initialize the coordinator."""
        try:
            self._load_settings()
            self.logger.info("Settings dialog coordinator initialized")
            return Result.success(None)
        except Exception as e:
            error_msg = f"Failed to initialize settings dialog coordinator: {e}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def show_dialog(self, resource_service=None) -> None:
        """Show the settings dialog."""
        try:
            if self._dialog is not None:
                self._dialog.raise_()
                self._dialog.activateWindow()
                return
            
            from .settings_dialog_impl import SettingsDialog
            
            # Create dialog with proper architecture
            self._dialog = SettingsDialog(
                parent=self.parent_window,
                resource_service=resource_service,
            )
            
            # Connect signals
            self._dialog.settings_changed.connect(self._on_settings_changed)
            self._dialog.reset_requested.connect(self._on_reset_requested)
            self._dialog.sound_file_browse_requested.connect(self._on_sound_browse_requested)
            self._dialog.finished.connect(self._on_dialog_closed)
            
            # Set current data
            data = self._state_to_dialog_data()
            self._dialog.set_data(data)
            
            # Show dialog
            self._dialog.show()
            
        except Exception as e:
            self.logger.exception(f"Failed to show settings dialog: {e}")
    
    def _state_to_dialog_data(self) -> SettingsDialogData:
        """Convert coordinator state to dialog data."""
        from .settings_dialog_impl import SettingsDialogData
        return SettingsDialogData(
            model=self.state.current_model,
            quantization=self.state.current_quantization,
            rec_key=self.state.current_rec_key,
            recording_sound=self.state.enable_rec_sound,
            sound_path=self.state.current_sound_path,
            output_srt=self.state.current_output_srt,
            llm_enabled=self.state.current_llm_enabled,
            llm_model=self.state.current_llm_model,
            llm_quantization=self.state.current_llm_quantization,
            llm_prompt=self.state.current_llm_prompt,
        )
    
    def _on_settings_changed(self, settings: dict) -> None:
        """Handle settings changed from dialog."""
        try:
            # Update coordinator state
            self.state.current_model = settings.get("model", self.state.current_model)
            self.state.current_quantization = settings.get("quantization", self.state.current_quantization)
            self.state.current_rec_key = settings.get("rec_key", self.state.current_rec_key)
            self.state.enable_rec_sound = settings.get("recording_sound", self.state.enable_rec_sound)
            self.state.current_sound_path = settings.get("sound_path", self.state.current_sound_path)
            self.state.current_output_srt = settings.get("output_srt", self.state.current_output_srt)
            self.state.current_llm_enabled = settings.get("llm_enabled", self.state.current_llm_enabled)
            self.state.current_llm_model = settings.get("llm_model", self.state.current_llm_model)
            self.state.current_llm_quantization = settings.get("llm_quantization", self.state.current_llm_quantization)
            self.state.current_llm_prompt = settings.get("llm_prompt", self.state.current_llm_prompt)
            
            # Save via application layer
            self.save_settings()
            
        except Exception as e:
            self.logger.exception(f"Failed to handle settings change: {e}")
    
    def _on_reset_requested(self, field_name: str) -> None:
        """Handle reset request from dialog."""
        try:
            if field_name == "all":
                self.reset_all_settings()
                # Update dialog with reset values
                if self._dialog:
                    data = self._state_to_dialog_data()
                    self._dialog.set_data(data)
            else:
                # Reset specific field
                default_value = getattr(self.defaults, field_name.replace("_", ""), None)
                if default_value is not None and self._dialog:
                    self._dialog.reset_field(field_name, default_value)
                    
        except Exception as e:
            self.logger.exception(f"Failed to handle reset request: {e}")
    
    def _on_sound_browse_requested(self) -> None:
        """Handle sound file browse request."""
        try:
            from PyQt6.QtWidgets import QFileDialog
            
            file_path, _ = QFileDialog.getOpenFileName(
                parent=self._dialog,
                caption="Select Sound File",
                directory="",
                filter="Audio Files (*.mp3 *.wav *.flac *.m4a *.aac *.ogg *.wma);;All Files (*)",
            )
            
            if file_path and self._dialog:
                self._dialog.set_sound_path(file_path)
                
        except Exception as e:
            self.logger.exception(f"Failed to handle sound browse: {e}")
    
    def _on_dialog_closed(self) -> None:
        """Handle dialog closed."""
        self._dialog = None

    def cleanup(self) -> None:
        """Cleanup resources."""
        try:
            if self._dialog:
                self._dialog.close()
                self._dialog = None
            self.progress_timer.stop()
            self.logger.info("Settings dialog coordinator cleaned up")
        except Exception as e:
            self.logger.exception(f"Error during cleanup: {e}")


