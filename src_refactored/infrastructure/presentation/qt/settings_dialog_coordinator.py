"""Settings Dialog Coordinator for refactored WinSTT application.

This module provides the main coordination and event handling integration
for the settings dialog, following the refactored DDD architecture.
"""

import logging
import os
from dataclasses import dataclass
from typing import Any

from PyQt6.QtCore import QObject, QTimer, pyqtSignal
from PyQt6.QtWidgets import QWidget

from src_refactored.presentation.core.container import injectable
from src_refactored.domain.common.result import Result
from src_refactored.infrastructure.presentation.qt.ui_core_abstractions import (
    IUIEventHandler,
    IUIComponent,
    UIEvent,
    UIEventType,
    UIState,
)


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
    recording_key: bool = False
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
    """Coordinates settings dialog operations and event handling.
    
    This class manages the overall coordination of the settings dialog,
    handling events, state management, and communication with services.
    """
    
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
        self._state_data = self._create_initial_state()
        
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
            state = self._state_data
            state.current_model = settings.get("model", self.defaults.model)
            state.current_quantization = settings.get("quantization", self.defaults.quantization)
            state.enable_rec_sound = settings.get("recording_sound", self.defaults.recording_sound)
            state.current_sound_path = settings.get("sound_path", self.defaults.sound_path)
            state.current_output_srt = settings.get("output_srt", self.defaults.output_srt)
            state.current_rec_key = settings.get("rec_key", self.defaults.rec_key)
            state.current_llm_enabled = settings.get("llm_enabled", self.defaults.llm_enabled)
            state.current_llm_model = settings.get("llm_model", self.defaults.llm_model)
            state.current_llm_quantization = settings.get("llm_quantization", self.defaults.llm_quantization)
            state.current_llm_prompt = settings.get("llm_prompt", self.defaults.llm_prompt)
            
            self.logger.info("Settings loaded successfully")
            
        except Exception as e:
            self.logger.exception(f"Failed to load settings: {e}")
            # Keep default state on error
    
    def save_settings(self) -> Result[None]:
        """Save current state to storage."""
        try:
            s = self._state_data
            settings = {
                "model": s.current_model,
                "quantization": s.current_quantization,
                "recording_sound": s.enable_rec_sound,
                "sound_path": s.current_sound_path,
                "output_srt": s.current_output_srt,
                "rec_key": s.current_rec_key,
                "llm_enabled": s.current_llm_enabled,
                "llm_model": s.current_llm_model,
                "llm_quantization": s.current_llm_quantization,
                "llm_prompt": s.current_llm_prompt,
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
        if model != self._state_data.current_model:
            self._state_data.current_model = model
            self.save_settings()
            self.logger.info(f"Model changed to: {model}")
    
    def handle_quantization_changed(self, quantization: str) -> None:
        """Handle quantization change."""
        if quantization != self._state_data.current_quantization:
            self._state_data.current_quantization = quantization
            self.save_settings()
            self.logger.info(f"Quantization changed to: {quantization}")
    
    def handle_recording_sound_changed(self, enabled: bool, sound_path: str | None = None) -> None:
        """Handle recording sound settings change."""
        changed = False
        
        if enabled != self._state_data.enable_rec_sound:
            self._state_data.enable_rec_sound = enabled
            changed = True
        
        if sound_path and sound_path != self._state_data.current_sound_path:
            self._state_data.current_sound_path = sound_path
            changed = True
        
        if changed:
            self.save_settings()
            self.logger.info(f"Recording sound settings changed: enabled={enabled}, path={sound_path}")
    
    def handle_srt_output_changed(self, enabled: bool) -> None:
        """Handle SRT output setting change."""
        if enabled != self._state_data.current_output_srt:
            self._state_data.current_output_srt = enabled
            self.save_settings()
            self.logger.info(f"SRT output changed to: {enabled}")
    
    def handle_llm_settings_changed(self, enabled: bool | None = None, model: str | None = None, 
                                   quantization: str | None = None, prompt: str | None = None) -> None:
        """Handle LLM settings change."""
        changed = False
        
        if enabled is not None and enabled != self._state_data.current_llm_enabled:
            self._state_data.current_llm_enabled = enabled
            changed = True
        
        if model and model != self._state_data.current_llm_model:
            self._state_data.current_llm_model = model
            changed = True
        
        if quantization and quantization != self._state_data.current_llm_quantization:
            self._state_data.current_llm_quantization = quantization
            changed = True
        
        if prompt and prompt != self._state_data.current_llm_prompt:
            self._state_data.current_llm_prompt = prompt
            changed = True
        
        if changed:
            self.save_settings()
            self.logger.info("LLM settings changed")
    
    def handle_hotkey_changed(self, hotkey: str) -> None:
        """Handle hotkey change."""
        if hotkey != self._state_data.current_rec_key:
            self._state_data.current_rec_key = hotkey
            self.save_settings()
            self.logger.info(f"Hotkey changed to: {hotkey}")
    
    def handle_file_drop(self, file_path: str) -> Result[None]:
        """Handle file drop for sound file selection."""
        try:
            # Validate file type
            if not any(file_path.lower().endswith(ext) for ext in self.supported_file_types):
                return Result.failure(f"Unsupported file type. Supported: {', '.join(self.supported_file_types)}")
            
            # Update sound path
            self.handle_recording_sound_changed(self._state_data.enable_rec_sound, file_path)
            
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
            self._state_data = self._create_initial_state()
            self.save_settings()
            self.logger.info("All settings reset to defaults")
            
        except Exception as e:
            self.logger.exception(f"Failed to reset settings: {e}")
    
    def start_model_download(self, model_name: str) -> None:
        """Start model download process."""
        self._state_data.is_downloading_model = True
        self._disable_reset_buttons()
        self.model_download_started.emit(model_name)
        self.progress_service.show_progress(f"Downloading {model_name}...")
        self.logger.info(f"Started downloading model: {model_name}")
    
    def complete_model_download(self, model_name: str) -> None:
        """Complete model download process."""
        self._state_data.is_downloading_model = False
        self._enable_reset_buttons()
        self.model_download_completed.emit(model_name)
        self.progress_service.hide_progress()
        self.logger.info(f"Completed downloading model: {model_name}")
    
    def fail_model_download(self, model_name: str, error: str) -> None:
        """Handle model download failure."""
        self._state_data.is_downloading_model = False
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
        return self._state_data
    
    def handle_event(self, event: UIEvent) -> Result[None]:
        """Handle UI events."""
        try:
            # Map to available UIEventType members defined in ui_core_abstractions
            if event.event_type.name == "SETTINGS_CHANGED":
                # Handle settings change event
                self.save_settings()
            elif event.event_type.name == "MODEL_DOWNLOAD_STARTED":
                # Handle model download start
                model_name = event.data.get("model_name", "Unknown")
                self.start_model_download(model_name)
            elif event.event_type.name == "MODEL_DOWNLOAD_COMPLETED":
                # Handle model download completion
                model_name = event.data.get("model_name", "Unknown")
                self.complete_model_download(model_name)
            else:
                # Unrecognized UIEventType for this coordinator; ignore gracefully
                return Result.success(None)
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to handle event {event.event_type}: {e}"
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
    
    def cleanup(self) -> Result[None]:
        """Cleanup resources."""
        try:
            self.progress_timer.stop()
            self.logger.info("Settings dialog coordinator cleaned up")
            return Result.success(None)
        except Exception as e:
            error_msg = f"Error during cleanup: {e}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)