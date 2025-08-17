"""Keyboard Service Adapter.

This adapter bridges the real KeyboardService with the IKeyboardService protocol
expected by the presentation layer.
"""

from collections.abc import Callable
from typing import Any

from src.domain.common.ports.logging_port import LoggingPort
from src.domain.settings.value_objects.key_combination import KeyCombination
from src.infrastructure.audio.keyboard_service import KeyboardService


class KeyboardServiceAdapter:
    """Adapter that bridges KeyboardService with IKeyboardService protocol."""
    
    def __init__(self, real_service: KeyboardService, logger: LoggingPort | None = None):
        self._service = real_service
        self._logger = logger
        self._hotkey_callbacks: dict[str, Callable[[], None]] = {}
        self._hotkey_handlers: dict[str, Any] = {}
        self._recording_callback: Callable[[bool], None] | None = None
        
    def register_hotkey(self, key_combination: str, callback: Callable[[], None]) -> None:
        """Register a hotkey with callback - adapts to real service interface."""
        try:
            # Parse key combination from string
            key_combo = KeyCombination.from_string(key_combination)
            
            # Create hotkey handler that implements the protocol
            class HotkeyHandler:
                def __init__(self, callback_fn: Callable[[], None], adapter_ref):
                    self.callback = callback_fn
                    self.adapter = adapter_ref
                    self.is_pressed = False
                
                def on_hotkey_pressed(self, combination: KeyCombination) -> None:
                    if not self.is_pressed:  # Only trigger once when first pressed
                        self.is_pressed = True
                        self.adapter.on_hotkey_start()
                
                def on_hotkey_released(self, combination: KeyCombination) -> None:
                    if self.is_pressed:  # Only trigger when actually releasing
                        self.is_pressed = False
                        self.adapter.on_hotkey_stop()
            
            handler = HotkeyHandler(callback, self)
            self._hotkey_callbacks[key_combination] = callback
            self._hotkey_handlers[key_combination] = handler
            
            # Call the service with the correct parameters: hotkey_id, combination, handler
            result = self._service.register_hotkey(key_combination, key_combo, handler)
            
            if self._logger:
                self._logger.log_info(f"Registered hotkey: {key_combination}, result: {result}")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Failed to register hotkey {key_combination}", exception=e)
    
    def unregister_hotkey(self, key_combination: str) -> None:
        """Unregister a hotkey."""
        try:
            self._service.unregister_hotkey(key_combination)
            if key_combination in self._hotkey_callbacks:
                del self._hotkey_callbacks[key_combination]
                
            if self._logger:
                self._logger.log_info(f"Unregistered hotkey: {key_combination}")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Failed to unregister hotkey {key_combination}", exception=e)
    
    def start_monitoring(self) -> None:
        """Start keyboard monitoring - adapts to real service interface."""
        try:
            result = self._service.start_hook()
            if self._logger:
                self._logger.log_info(f"Started keyboard monitoring, result: {result}")
        except Exception as e:
            if self._logger:
                self._logger.log_error("Failed to start keyboard monitoring", exception=e)
    
    def stop_monitoring(self) -> None:
        """Stop keyboard monitoring - adapts to real service interface."""
        try:
            result = self._service.stop_hook()
            if self._logger:
                self._logger.log_info(f"Stopped keyboard monitoring, result: {result}")
        except Exception as e:
            if self._logger:
                self._logger.log_error("Failed to stop keyboard monitoring", exception=e)
    
    def set_recording_callback(self, callback: Callable[[bool], None]) -> None:
        """Set callback for recording start/stop events."""
        self._recording_callback = callback
    
    def on_hotkey_start(self) -> None:
        """Called when hotkey is pressed down."""
        if self._recording_callback:
            self._recording_callback(True)  # Start recording
        elif self._logger:
            self._logger.log_debug("Hotkey pressed but no recording callback set")
    
    def on_hotkey_stop(self) -> None:
        """Called when hotkey is released."""
        if self._recording_callback:
            self._recording_callback(False)  # Stop recording
        elif self._logger:
            self._logger.log_debug("Hotkey released but no recording callback set")
