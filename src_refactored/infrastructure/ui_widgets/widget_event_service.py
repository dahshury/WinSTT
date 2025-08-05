"""Widget Event Service for event handling management.

This service provides centralized widget event handling functionality,
extracted from settings_dialog.py (lines 59-66, 68-111, 806-832, 867-879).
"""

from collections.abc import Callable

from PyQt6.QtCore import QEvent, QObject, Qt, pyqtSignal
from PyQt6.QtGui import QDragEnterEvent, QDragLeaveEvent, QKeyEvent, QMouseEvent, QPaintEvent
from PyQt6.QtWidgets import QGroupBox, QLabel, QLineEdit, QPushButton, QSlider, QWidget

from src_refactored.domain.ui_widgets.value_objects.widget_events import EventType


class WidgetEventService(QObject):
    """Service for managing widget event handling.
    
    Extracted from settings_dialog.py event handling patterns.
    """

    # Signals for event notifications
    event_occurred = pyqtSignal(str, object)  # event_type, event_data
    toggle_changed = pyqtSignal(bool)  # toggle state changed
    key_combination_changed = pyqtSignal(str)  # key combination string
    file_dropped = pyqtSignal(str)  # file path

    def __init__(self):
        """Initialize the event service."""
        super().__init__()
        self.event_handlers: dict[EventType, Callable] = {}
        self.pressed_keys: set[str] = set()
        self.supported_file_types = [".wav", ".mp3", ".flac", ".ogg", ".m4a"]

    def register_event_handler(self, event_type: EventType, handler: Callable,
    ) -> None:
        """Register an event handler for a specific event type.
        
        Args:
            event_type: Type of event to handle
            handler: Callback function to handle the event
        """
        self.event_handlers[event_type] = handler

    def handle_mouse_press_event(self, widget: QWidget, event: QMouseEvent,
    ) -> bool:
        """Handle mouse press events for toggle widgets.
        
        Args:
            widget: Widget that received the event
            event: Mouse press event
            
        Returns:
            True if event was handled, False otherwise
        """
        if isinstance(widget, QSlider) and event.button() == Qt.MouseButton.LeftButton:
            # Toggle the state for slider-based toggle switches
            current_value = widget.value()
            new_value = 0 if current_value == 1 else 1
            widget.setValue(new_value)

            # Emit toggle changed signal
            self.toggle_changed.emit(new_value == 1)

            # Call registered handler if available
            if EventType.MOUSE_PRESS in self.event_handlers:
                self.event_handlers[EventType.MOUSE_PRESS](widget, event)

            event.accept()
            return True

        return False

    def handle_paint_event(self, widget: QSlider, event: QPaintEvent,
    ) -> None:
        """Handle paint events for toggle widgets with dynamic styling.
        
        Args:
            widget: Slider widget to paint
            event: Paint event
        """
        # Call the original paint event
        QSlider.paintEvent(widget, event)

        # Apply dynamic styling based on toggle state
        if widget.value() == 1:
            # Checked/on state styling
            widget.setStyleSheet("""
                QSlider::groove:horizontal {
                    border: 1px solid rgba(78, 106, 129, 120);
                    height: 10px;
                    background: rgba(0, 122, 255, 40);
                    border-radius: 5px;
                }
                QSlider::handle:horizontal {
                    background: rgb(255, 255, 255);
                    border: 1px solid rgba(78, 106, 129, 150);
                    width: 9px;
                    height: 9px;
                    margin: 0px;
                    border-radius: 4px;
                }
            """)
        else:
            # Unchecked/off state styling
            widget.setStyleSheet("""
                QSlider::groove:horizontal {
                    border: 1px solid rgba(78, 106, 129, 120);
                    height: 10px;
                    background: rgba(54, 71, 84, 180);
                    border-radius: 5px;
                }
                QSlider::handle:horizontal {
                    background: rgb(255, 255, 255);
                    border: 1px solid rgba(78, 106, 129, 150);
                    width: 9px;
                    height: 9px;
                    margin: 0px;
                    border-radius: 4px;
                }
            """)

        # Call registered handler if available
        if EventType.PAINT in self.event_handlers:
            self.event_handlers[EventType.PAINT](widget, event)

    def handle_key_press_event(self, event: QKeyEvent,
    ) -> None:
        """Handle key press events for recording key combinations.
        
        Args:
            event: Key press event
        """
        key_text = self._get_key_name(event)
        if key_text:
            self.pressed_keys.add(key_text)
            self._update_key_combination_display()

            # Call registered handler if available
            if EventType.KEY_PRESS in self.event_handlers:
                self.event_handlers[EventType.KEY_PRESS](event)

    def handle_key_release_event(self, event: QKeyEvent,
    ) -> None:
        """Handle key release events for recording key combinations.
        
        Args:
            event: Key release event
        """
        key_text = self._get_key_name(event)
        if key_text and key_text in self.pressed_keys:
            self.pressed_keys.discard(key_text)
            self._update_key_combination_display()

            # Call registered handler if available
            if EventType.KEY_RELEASE in self.event_handlers:
                self.event_handlers[EventType.KEY_RELEASE](event)

    def handle_drag_enter_event(self, widget: QWidget, event: QDragEnterEvent,
    ) -> bool:
        """Handle drag enter events for file dropping.
        
        Args:
            widget: Widget receiving the drag
            event: Drag enter event
            
        Returns:
            True if drag was accepted, False otherwise
        """
        mime_data = event.mimeData()
        if mime_data.hasUrls():
            file_path = mime_data.urls()[0].toLocalFile()
            if (any(file_path.lower().endswith(ext)
                    for ext in self.supported_file_types) and
                isinstance(widget, QLabel | QLineEdit | QPushButton | QGroupBox | QWidget)):
                # Set cursor for supported widget types
                widget.setCursor(Qt.CursorShape.DragCopyCursor)
                event.acceptProposedAction()

                # Call registered handler if available
                if EventType.DRAG_ENTER in self.event_handlers:
                    self.event_handlers[EventType.DRAG_ENTER](widget, event)

                return True
        return False

    def handle_drag_leave_event(self, widget: QWidget, event: QDragLeaveEvent,
    ) -> bool:
        """Handle drag leave events.
        
        Args:
            widget: Widget the drag is leaving
            event: Drag leave event
            
        Returns:
            True if event was handled, False otherwise
        """
        # Reset cursor when drag leaves
        if isinstance(widget, QLabel | QLineEdit | QPushButton | QGroupBox | QWidget):
            widget.unsetCursor()

            # Call registered handler if available
            if EventType.DRAG_LEAVE in self.event_handlers:
                self.event_handlers[EventType.DRAG_LEAVE](widget, event)

            return True
        return False

    def handle_close_event(self, widget: QWidget, event: QEvent,
    ) -> None:
        """Handle close events for proper cleanup.
        
        Args:
            widget: Widget being closed
            event: Close event
        """
        # Call registered handler if available
        if EventType.CLOSE in self.event_handlers:
            self.event_handlers[EventType.CLOSE](widget, event)

        # Accept the close event
        event.accept()

    def handle_show_event(self, widget: QWidget, event: QEvent,
    ) -> None:
        """Handle show events for widget initialization.
        
        Args:
            widget: Widget being shown
            event: Show event
        """
        # Call registered handler if available
        if EventType.SHOW in self.event_handlers:
            self.event_handlers[EventType.SHOW](widget, event)

    def _get_key_name(self, event: QKeyEvent,
    ) -> str | None:
        """Get the printable name of a key.
        
        Args:
            event: Key event
            
        Returns:
            String representation of the key or None
        """
        key = event.key()

        # Handle modifier keys
        key_mapping = {
            Qt.Key.Key_Control: "Ctrl",
            Qt.Key.Key_Alt: "Alt",
            Qt.Key.Key_Shift: "Shift",
            Qt.Key.Key_Meta: "Win",
            Qt.Key.Key_Space: "Space",
            Qt.Key.Key_Escape: "Esc",
            Qt.Key.Key_Tab: "Tab",
            Qt.Key.Key_Backspace: "Backspace",
            Qt.Key.Key_Delete: "Delete",
        }
        
        if key in key_mapping:
            return key_mapping[key]
        
        if key in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
            return "Enter"
        
        if Qt.Key.Key_F1 <= key <= Qt.Key.Key_F12:
            return f"F{key - Qt.Key.Key_F1 + 1}"
        
        # For regular keys, use the text representation
        text = event.text()
        if text and text.isprintable():
            return text.upper()

        return None

    def _update_key_combination_display(self) -> None:
        """Update the key combination display."""
        if len(self.pressed_keys) > 0:
            combination = "+".join(sorted(self.pressed_keys))
            self.key_combination_changed.emit(combination)

    def clear_pressed_keys(self) -> None:
        """Clear all pressed keys."""
        self.pressed_keys.clear()
        self.key_combination_changed.emit("")

    def get_current_key_combination(self) -> str:
        """Get the current key combination string.
        
        Returns:
            Current key combination as string
        """
        return "+".join(sorted(self.pressed_keys),
    ) if self.pressed_keys else ""

    def set_supported_file_types(self, file_types: list[str]) -> None:
        """Set supported file types for drag and drop.
        
        Args:
            file_types: List of file extensions (e.g., [".wav", ".mp3"])
        """
        self.supported_file_types = file_types

    def install_event_filter(self, widget: QWidget,
    ) -> None:
        """Install this service as an event filter on a widget.
        
        Args:
            widget: Widget to install event filter on
        """
        widget.installEventFilter(self)

    def event_filter(self, obj: QObject, event: QEvent,
    ) -> bool:
        """Qt event filter implementation.
        
        Args:
            obj: Object that received the event
            event: The event
            
        Returns:
            True if event was handled, False otherwise
        """
        if not isinstance(obj, QWidget):
            return False

        event_type = event.type()

        if event_type == QEvent.Type.DragEnter:
            return self.handle_drag_enter_event(obj, event)
        if event_type == QEvent.Type.DragLeave:
            return self.handle_drag_leave_event(obj, event)
        if event_type == QEvent.Type.MouseButtonPress:
            return self.handle_mouse_press_event(obj, event)

        return False

    @staticmethod
    def create_toggle_event_handler(widget: QSlider,
    ) -> "WidgetEventService":
        """Create an event service configured for toggle widget handling.
        
        Args:
            widget: Toggle slider widget
            
        Returns:
            Configured event service
        """
        service = WidgetEventService()

        # Override the widget's event methods
        original_mouse_press = widget.mousePressEvent

        def mouse_press_handler(event):
            if not service.handle_mouse_press_event(widget, event):
                original_mouse_press(event)

        def paint_handler(event):
            service.handle_paint_event(widget, event)

        widget.mousePressEvent = mouse_press_handler
        widget.paintEvent = paint_handler

        return service