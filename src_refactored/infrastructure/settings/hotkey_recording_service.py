"""Hotkey Recording Service for key recording and combination validation.

This service handles hotkey recording, validation, and management,
extracted from settings_dialog.py (lines 867-969).
"""

import logging
from collections.abc import Callable

from PyQt6.QtCore import QObject, Qt, pyqtSignal
from PyQt6.QtGui import QKeyEvent


class HotkeyRecordingService(QObject):
    """Service for recording and validating hotkey combinations.
    
    Provides infrastructure for capturing key combinations, validating them,
    and managing hotkey recording state with progress tracking.
    """

    # Signals for progress tracking and events
    recording_started = pyqtSignal()
    recording_stopped = pyqtSignal(str)  # final_combination
    key_combination_changed = pyqtSignal(str)  # current_combination
    recording_failed = pyqtSignal(str)  # error_message
    validation_completed = pyqtSignal(bool, str)  # is_valid, message

    def __init__(self):
        super().__init__()
        self.logger = logging.getLogger(__name__)

        # Recording state
        self.recording_key = False
        self.pressed_keys: set[str] = set()
        self.current_combination = ""

        # Style configurations for recording states
        self.recording_style = """
            QTextEdit {
                background-color: rgb(80, 40, 40);
                color: rgb(144, 164, 174);
                border-style: outset;
                border-radius: 3px;
                border-width: 1px;
                border-color: rgb(78, 106, 129)
            }
        """

        self.normal_style = """
            QTextEdit {
                background-color: rgb(54, 71, 84);
                color: rgb(144, 164, 174);
                border-style: outset;
                border-radius: 3px;
                border-width: 1px;
                border-color: rgb(78, 106, 129)
            }
        """

        # Special key mappings
        self.special_keys = {
            Qt.Key.Key_F1: "F1", Qt.Key.Key_F2: "F2", Qt.Key.Key_F3: "F3",
            Qt.Key.Key_F4: "F4", Qt.Key.Key_F5: "F5", Qt.Key.Key_F6: "F6",
            Qt.Key.Key_F7: "F7", Qt.Key.Key_F8: "F8", Qt.Key.Key_F9: "F9",
            Qt.Key.Key_F10: "F10", Qt.Key.Key_F11: "F11", Qt.Key.Key_F12: "F12",
            Qt.Key.Key_Escape: "ESC", Qt.Key.Key_Tab: "TAB",
            Qt.Key.Key_CapsLock: "CAPS", Qt.Key.Key_Space: "SPACE",
        }

        # Callbacks for UI updates
        self.style_update_callback: Callable[[str], None] | None = None
        self.text_update_callback: Callable[[str], None] | None = None
        self.button_text_callback: Callable[[str], None] | None = None

    def start_recording(self) -> None:
        """Start recording hotkey combination."""
        try:
            self.recording_key = True
            self.pressed_keys.clear()
            self.current_combination = ""

            # Update UI elements
            if self.style_update_callback:
                self.style_update_callback(self.recording_style)
            if self.button_text_callback:
                self.button_text_callback("Stop")

            self.recording_started.emit()
            self.logger.info("Started hotkey recording")

        except Exception as e:
            error_msg = f"Error starting hotkey recording: {e!s}"
            self.logger.exception(error_msg)
            self.recording_failed.emit(error_msg)

    def stop_recording(self) -> str:
        """Stop recording hotkey combination.
        
        Returns:
            Final key combination string
        """
        try:
            self.recording_key = False

            # Update UI elements
            if self.style_update_callback:
                self.style_update_callback(self.normal_style)
            if self.button_text_callback:
                self.button_text_callback("Change Key")

            # Finalize combination
            if len(self.pressed_keys) > 0:
                # Sort keys with modifiers first, then by length (reverse)
                sorted_keys = sorted(self.pressed_keys, key=lambda x: (x not in ["CTRL", "ALT", "SHIFT", "META"], len(x)), reverse=True)
                self.current_combination = "+".join(sorted_keys).upper()

            self.pressed_keys.clear()

            self.recording_stopped.emit(self.current_combination)
            self.logger.info(f"Stopped hotkey recording: {self.current_combination}")

            return self.current_combination

        except Exception as e:
            error_msg = f"Error stopping hotkey recording: {e!s}"
            self.logger.exception(error_msg)
            self.recording_failed.emit(error_msg)
            return ""

    def toggle_recording(self) -> None:
        """Toggle recording state."""
        if self.recording_key:
            self.stop_recording()
        else:
            self.start_recording()

    def handle_key_press(self, event: QKeyEvent) -> None:
        """Handle key press events during recording.
        
        Args:
            event: Qt key event
        """
        if not self.recording_key:
            return

        try:
            key_text = self.get_key_name(event)
            if key_text:
                self.pressed_keys.add(key_text)
                self.update_combination_display()

        except Exception as e:
            error_msg = f"Error handling key press: {e!s}"
            self.logger.exception(error_msg)
            self.recording_failed.emit(error_msg)

    def handle_key_release(self, event: QKeyEvent) -> None:
        """Handle key release events during recording.
        
        Args:
            event: Qt key event
        """
        if not self.recording_key:
            return

        try:
            key_text = self.get_key_name(event)
            if key_text and key_text in self.pressed_keys:
                self.pressed_keys.discard(key_text)
                self.update_combination_display()

        except Exception as e:
            error_msg = f"Error handling key release: {e!s}"
            self.logger.exception(error_msg)
            self.recording_failed.emit(error_msg)

    def get_key_name(self, event: QKeyEvent) -> str | None:
        """Get the printable name of a key.
        
        Args:
            event: Qt key event
            
        Returns:
            String representation of the key, or None if not recognized
        """
        key = event.key()

        # Handle modifier keys
        if key == Qt.Key.Key_Control:
            return "CTRL"
        if key == Qt.Key.Key_Alt:
            return "ALT"
        if key == Qt.Key.Key_Shift:
            return "SHIFT"
        if key == Qt.Key.Key_Meta:
            return "META"

        # Try to get the text for the key
        key_text = event.text().upper()

        # If the key doesn't have a text representation, check special keys
        if not key_text or len(key_text) == 0:
            if key in self.special_keys:
                return self.special_keys[key]
            return None

        return key_text

    def update_combination_display(self) -> None:
        """Update the display of the current key combination."""
        if len(self.pressed_keys) > 0:
            combination = "+".join(sorted(self.pressed_keys))

            if self.text_update_callback:
                self.text_update_callback(combination)

            self.key_combination_changed.emit(combination)

    def validate_combination(self, combination: str) -> tuple[bool, str]:
        """Validate a key combination.
        
        Args:
            combination: Key combination string to validate
            
        Returns:
            Tuple of (is_valid, error_message)
        """
        try:
            if not combination:
                return False, "Key combination cannot be empty"

            parts = combination.split("+")

            if len(parts) < 2:
                return False, "Key combination must include at least one modifier (CTRL, ALT, SHIFT)"

            valid_modifiers = ["CTRL", "ALT", "SHIFT", "META"]
            valid_keys = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "ESC", "TAB", "CAPS", "SPACE"]

            # Check if all parts except the last are valid modifiers
            for part in parts[:-1]:
                if part.upper() not in valid_modifiers:
                    return False, f"Invalid modifier key: {part}"

            # Check if the last part is a valid key
            if parts[-1].upper() not in valid_keys:
                return False, f"Invalid key: {parts[-1]}"

            self.validation_completed.emit(True, "Valid key combination")
            return True, "Valid key combination"

        except Exception as e:
            error_msg = f"Error validating key combination: {e!s}"
            self.validation_completed.emit(False, error_msg)
            return False, error_msg

    def set_style_update_callback(self, callback: Callable[[str], None]) -> None:
        """Set callback for updating UI styles.
        
        Args:
            callback: Function to call with style string
        """
        self.style_update_callback = callback

    def set_text_update_callback(self, callback: Callable[[str], None]) -> None:
        """Set callback for updating text display.
        
        Args:
            callback: Function to call with text string
        """
        self.text_update_callback = callback

    def set_button_text_callback(self, callback: Callable[[str], None]) -> None:
        """Set callback for updating button text.
        
        Args:
            callback: Function to call with button text
        """
        self.button_text_callback = callback

    def is_recording(self) -> bool:
        """Check if currently recording.
        
        Returns:
            True if recording, False otherwise
        """
        return self.recording_key

    def get_current_combination(self) -> str:
        """Get the current key combination.
        
        Returns:
            Current key combination string
        """
        return self.current_combination

    def get_recording_style(self) -> str:
        """Get the CSS style for recording state.
        
        Returns:
            CSS style string for recording state
        """
        return self.recording_style

    def get_normal_style(self) -> str:
        """Get the CSS style for normal state.
        
        Returns:
            CSS style string for normal state
        """
        return self.normal_style