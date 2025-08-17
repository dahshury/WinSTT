"""Hotkey Configuration Widget Component.

This module provides a reusable widget for hotkey configuration
that integrates with domain services and follows DDD architecture principles.
"""


from PyQt6.QtCore import QSize, Qt, QTimer, pyqtSignal
from PyQt6.QtGui import QIcon, QKeyEvent
from PyQt6.QtWidgets import (
    QGroupBox,
    QHBoxLayout,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from src.domain.settings.value_objects.key_combination import KeyCombination
from src.infrastructure.common.resource_service import resource_path


class HotkeyConfigWidget(QGroupBox):
    """Hotkey configuration widget component.
    
    This widget provides UI controls for hotkey configuration including
    key capture, display, and reset functionality.
    """

    # Signals for hotkey configuration changes
    hotkey_changed = pyqtSignal(str)
    hotkey_reset = pyqtSignal()
    hotkey_capture_started = pyqtSignal()
    hotkey_capture_finished = pyqtSignal()

    def __init__(self, parent=None):
        """Initialize the hotkey configuration widget.
        
        Args:
            parent: Parent widget
        """
        super().__init__("Recording Key Settings", parent)

        # Current configuration
        self._current_hotkey = "F2"
        self._is_capturing = False

        # Default configuration
        self._default_hotkey = "F2"

        # UI components
        self.rec_key_edit: QTextEdit | None = None
        self.change_rec_key_btn: QPushButton | None = None
        self.rec_key_reset_btn: QPushButton | None = None

        # Capture timer for timeout
        self._capture_timer = QTimer()
        self._capture_timer.setSingleShot(True)
        self._capture_timer.timeout.connect(self._stop_capture)

        # Setup UI
        self._setup_ui()
        self._setup_connections()

    def _setup_ui(self):
        """Setup the user interface."""
        # Apply styling
        self._apply_styling()

        # Create main layout
        layout = QVBoxLayout(self)
        layout.setSpacing(8)

        # Create hotkey configuration section
        self._create_hotkey_configuration(layout)

    def _apply_styling(self):
        """Apply dark theme styling to the widget."""
        self.setStyleSheet("""
            QGroupBox {
                background-color: rgb(18, 25, 31);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 5px;
                margin-top: 10px;
                font-weight: bold;
                color: rgb(144, 164, 174);
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 5px 0 5px;
            }
        """)

    def _create_hotkey_configuration(self, layout: QVBoxLayout):
        """Create the hotkey configuration section.
        
        Args:
            layout: Parent layout to add the section to
        """
        hotkey_widget = QWidget()
        hotkey_layout = QHBoxLayout(hotkey_widget)
        hotkey_layout.setContentsMargins(0, 0, 0, 0)

        # Hotkey display field
        self.rec_key_edit = QTextEdit()
        self.rec_key_edit.setFixedHeight(30)
        self.rec_key_edit.setText(self._current_hotkey)
        self.rec_key_edit.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.rec_key_edit.setReadOnly(True)
        self.rec_key_edit.setStyleSheet("""
            QTextEdit {
                background-color: rgb(54, 71, 84);
                color: rgb(144, 164, 174);
                border-style: outset;
                border-radius: 3px;
                border-width: 1px;
                border-color: rgb(78, 106, 129);
                padding: 5px;
            }
        """)

        # Change key button
        self.change_rec_key_btn = QPushButton("Change Key")
        self.change_rec_key_btn.setFixedHeight(30)
        self.change_rec_key_btn.setStyleSheet("""
            QPushButton {
                background-color: rgb(54, 71, 84);
                color: rgb(144, 164, 174);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
                padding: 5px 10px;
            }
            QPushButton:hover {
                background-color: rgb(78, 106, 129);
            }
            QPushButton:pressed {
                background-color: rgb(98, 126, 149);
            }
        """)

        # Reset button
        self.rec_key_reset_btn = self._create_reset_button("Reset to default recording key")

        # Add to layout
        hotkey_layout.addWidget(self.rec_key_edit, 1)
        hotkey_layout.addWidget(self.change_rec_key_btn)
        hotkey_layout.addWidget(self.rec_key_reset_btn)

        layout.addWidget(hotkey_widget)

    def _create_reset_button(self, tooltip: str) -> QPushButton:
        """Create a standardized reset button.
        
        Args:
            tooltip: Tooltip text for the button
            
        Returns:
            Configured reset button
        """
        reset_btn = QPushButton()
        reset_btn.setToolTip(tooltip)
        reset_btn.setIcon(QIcon(resource_path("@resources/Command-Reset-256.png")))
        reset_btn.setIconSize(QSize(16, 16))
        reset_btn.setFixedSize(17, 30)
        reset_btn.setStyleSheet("""
            QPushButton {
                background-color: rgb(54, 71, 84);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
            }
            QPushButton:hover {
                background-color: rgb(78, 106, 129);
            }
        """)
        return reset_btn

    def _setup_connections(self):
        """Setup signal connections."""
        if self.change_rec_key_btn:
            self.change_rec_key_btn.clicked.connect(self._on_change_key_clicked)

        if self.rec_key_reset_btn:
            self.rec_key_reset_btn.clicked.connect(self._on_reset_clicked)

    def _on_change_key_clicked(self):
        """Handle change key button click."""
        if self._is_capturing:
            self._stop_capture()
        else:
            self._start_capture()

    def _on_reset_clicked(self):
        """Handle reset button click."""
        self._set_hotkey(self._default_hotkey)
        self.hotkey_reset.emit()

    def _start_capture(self):
        """Start hotkey capture mode."""
        self._is_capturing = True

        # Update UI to show capture mode
        if self.rec_key_edit:
            self.rec_key_edit.setText("Press any key...")
            self.rec_key_edit.setStyleSheet("""
                QTextEdit {
                    background-color: rgb(74, 91, 104);
                    color: rgb(255, 255, 255);
                    border-style: outset;
                    border-radius: 3px;
                    border-width: 2px;
                    border-color: rgb(98, 126, 149);
                    padding: 5px;
                }
            """)

        if self.change_rec_key_btn:
            self.change_rec_key_btn.setText("Cancel")

        # Set focus to capture keys
        self.setFocus()

        # Start timeout timer (10 seconds)
        self._capture_timer.start(10000)

        # Emit signal
        self.hotkey_capture_started.emit()

    def _stop_capture(self):
        """Stop hotkey capture mode."""
        if not self._is_capturing:
            return

        self._is_capturing = False

        # Stop timer
        self._capture_timer.stop()

        # Restore UI
        if self.rec_key_edit:
            self.rec_key_edit.setText(self._current_hotkey)
            self.rec_key_edit.setStyleSheet("""
                QTextEdit {
                    background-color: rgb(54, 71, 84);
                    color: rgb(144, 164, 174);
                    border-style: outset;
                    border-radius: 3px;
                    border-width: 1px;
                    border-color: rgb(78, 106, 129);
                    padding: 5px;
                }
            """)

        if self.change_rec_key_btn:
            self.change_rec_key_btn.setText("Change Key")

        # Emit signal
        self.hotkey_capture_finished.emit()

    def _set_hotkey(self, hotkey: str):
        """Set the hotkey value.
        
        Args:
            hotkey: Hotkey string to set
        """
        if hotkey != self._current_hotkey:
            self._current_hotkey = hotkey
            if self.rec_key_edit and not self._is_capturing:
                self.rec_key_edit.setText(hotkey)
            self.hotkey_changed.emit(hotkey)

    def _format_key_combination(self, event: QKeyEvent) -> str:
        """Format a key event into a hotkey string.
        
        Args:
            event: Key event to format
            
        Returns:
            Formatted hotkey string
        """
        modifiers = []

        # Check for modifier keys
        if event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            modifiers.append("Ctrl")
        if event.modifiers() & Qt.KeyboardModifier.AltModifier:
            modifiers.append("Alt")
        if event.modifiers() & Qt.KeyboardModifier.ShiftModifier:
            modifiers.append("Shift")
        if event.modifiers() & Qt.KeyboardModifier.MetaModifier:
            modifiers.append("Meta")

        # Get the key name
        key = event.key()
        key_name = ""

        # Handle special keys
        if key == Qt.Key.Key_F1:
            key_name = "F1"
        elif key == Qt.Key.Key_F2:
            key_name = "F2"
        elif key == Qt.Key.Key_F3:
            key_name = "F3"
        elif key == Qt.Key.Key_F4:
            key_name = "F4"
        elif key == Qt.Key.Key_F5:
            key_name = "F5"
        elif key == Qt.Key.Key_F6:
            key_name = "F6"
        elif key == Qt.Key.Key_F7:
            key_name = "F7"
        elif key == Qt.Key.Key_F8:
            key_name = "F8"
        elif key == Qt.Key.Key_F9:
            key_name = "F9"
        elif key == Qt.Key.Key_F10:
            key_name = "F10"
        elif key == Qt.Key.Key_F11:
            key_name = "F11"
        elif key == Qt.Key.Key_F12:
            key_name = "F12"
        elif key == Qt.Key.Key_Space:
            key_name = "Space"
        elif key == Qt.Key.Key_Tab:
            key_name = "Tab"
        elif (key >= Qt.Key.Key_A and key <= Qt.Key.Key_Z) or (key >= Qt.Key.Key_0 and key <= Qt.Key.Key_9):
            key_name = chr(key)
        else:
            # For other keys, use the text representation
            key_name = event.text().upper() if event.text() else f"Key_{key}"

        # Combine modifiers and key
        if modifiers:
            return "+".join([*modifiers, key_name])
        return key_name

    def keyPressEvent(self, event: QKeyEvent):
        """Handle key press events during capture mode.
        
        Args:
            event: Key press event
        """
        if self._is_capturing:
            # Ignore modifier-only keys
            if event.key() in [
                Qt.Key.Key_Control,
                Qt.Key.Key_Alt,
                Qt.Key.Key_Shift,
                Qt.Key.Key_Meta,
            ]:
                return

            # Format the key combination
            hotkey = self._format_key_combination(event)

            # Set the new hotkey
            self._set_hotkey(hotkey)

            # Stop capture
            self._stop_capture()

            event.accept()
        else:
            super().keyPressEvent(event)

    # Public interface methods
    def set_hotkey(self, hotkey: str):
        """Set the current hotkey.
        
        Args:
            hotkey: Hotkey string to set
        """
        self._set_hotkey(hotkey)

    def get_hotkey(self) -> str:
        """Get the current hotkey.
        
        Returns:
            Current hotkey string
        """
        return self._current_hotkey

    def get_hotkey_configuration(self) -> KeyCombination:
        """Get the current hotkey configuration as a domain object.
        
        Returns:
            KeyCombination domain object
        """
        return KeyCombination.from_string(self._current_hotkey)

    def set_hotkey_configuration(self, config: KeyCombination):
        """Set the hotkey configuration from a domain object.
        
        Args:
            config: KeyCombination domain object
        """
        self.set_hotkey(config.to_string())

    def reset_to_default(self):
        """Reset hotkey to default value."""
        self._set_hotkey(self._default_hotkey)
        self.hotkey_reset.emit()

    def set_enabled(self, enabled: bool):
        """Enable or disable the widget.
        
        Args:
            enabled: Whether to enable the widget
        """
        if self.rec_key_edit:
            self.rec_key_edit.setEnabled(enabled)
        if self.change_rec_key_btn:
            self.change_rec_key_btn.setEnabled(enabled)
        if self.rec_key_reset_btn:
            self.rec_key_reset_btn.setEnabled(enabled)

        # Stop capture if disabled
        if not enabled and self._is_capturing:
            self._stop_capture()

    def is_capturing(self) -> bool:
        """Check if the widget is currently capturing a hotkey.
        
        Returns:
            True if capturing, False otherwise
        """
        return self._is_capturing

    def cancel_capture(self):
        """Cancel the current hotkey capture."""
        if self._is_capturing:
            self._stop_capture()

    def set_default_hotkey(self, hotkey: str):
        """Set the default hotkey.
        
        Args:
            hotkey: Default hotkey string
        """
        self._default_hotkey = hotkey

    def get_default_hotkey(self) -> str:
        """Get the default hotkey.
        
        Returns:
            Default hotkey string
        """
        return self._default_hotkey

    def set_capture_timeout(self, timeout_ms: int):
        """Set the capture timeout in milliseconds.
        
        Args:
            timeout_ms: Timeout in milliseconds
        """
        if timeout_ms > 0:
            self._capture_timer.setInterval(timeout_ms)

    def get_capture_timeout(self) -> int:
        """Get the current capture timeout.
        
        Returns:
            Timeout in milliseconds
        """
        return self._capture_timer.interval()