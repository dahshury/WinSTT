"""Settings Event Filter Component.

This module provides event filtering and routing functionality
for the settings dialog, handling drag-and-drop operations and key events.
"""

import os
from collections.abc import Callable

from PyQt6.QtCore import QEvent, QObject, Qt, pyqtSignal
from PyQt6.QtGui import QDragEnterEvent, QDropEvent, QKeyEvent
from PyQt6.QtWidgets import (
    QGroupBox,
    QLabel,
    QLineEdit,
    QPushButton,
    QWidget,
)

from src.domain.system_integration.ports.event_processing_port import (
    IDragDropProcessor,
    IKeyEventProcessor,
)


class SettingsEventFilter(QObject):
    """Event filter for settings dialog.
    
    This component handles:
    - Drag and drop events for file operations
    - Key press/release events for hotkey capture
    - Cursor management during drag operations
    - Event routing and delegation
    """

    # Signals for event handling
    file_dropped = pyqtSignal(str)  # file_path
    drag_entered = pyqtSignal(str)  # file_path
    drag_left = pyqtSignal()
    key_pressed = pyqtSignal(object)  # QKeyEvent
    key_released = pyqtSignal(object)  # QKeyEvent
    event_filtered = pyqtSignal(str, str)  # event_type, details

    def __init__(self, 
                 drag_drop_processor: IDragDropProcessor,
                 key_event_processor: IKeyEventProcessor,
                 parent=None):
        """Initialize the event filter.
        
        Args:
            drag_drop_processor: Drag and drop processor port
            key_event_processor: Key event processor port
            parent: Parent object
        """
        super().__init__(parent)

        # Injected dependencies
        self._process_drag_drop_use_case = drag_drop_processor
        self._process_key_event_use_case = key_event_processor



        # Configuration
        self.supported_file_types = [".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac"]
        self.is_recording_key = False

        # Event handlers
        self._drag_enter_handler: Callable | None = None
        self._drag_leave_handler: Callable | None = None
        self._drop_handler: Callable | None = None
        self._key_press_handler: Callable | None = None
        self._key_release_handler: Callable | None = None

        # Widget references for cursor management
        self._cursor_widgets: list[QWidget] = []

    def set_supported_file_types(self, file_types: list[str]):
        """Set the supported file types for drag and drop.
        
        Args:
            file_types: List of file extensions (e.g., ['.wav', '.mp3'])
        """
        self.supported_file_types = file_types

    def set_recording_key_mode(self, enabled: bool):
        """Enable or disable recording key capture mode.
        
        Args:
            enabled: Whether to capture key events
        """
        self.is_recording_key = enabled

    def add_cursor_widget(self, widget: QWidget):
        """Add a widget for cursor management during drag operations.
        
        Args:
            widget: Widget to manage cursor for
        """
        if widget not in self._cursor_widgets:
            self._cursor_widgets.append(widget)

    def remove_cursor_widget(self, widget: QWidget):
        """Remove a widget from cursor management.
        
        Args:
            widget: Widget to remove
        """
        if widget in self._cursor_widgets:
            self._cursor_widgets.remove(widget)

    def clear_cursor_widgets(self):
        """Clear all cursor widgets."""
        self._cursor_widgets.clear()

    def set_drag_enter_handler(self, handler: Callable[[str], None]):
        """Set custom handler for drag enter events.
        
        Args:
            handler: Function to call with file path
        """
        self._drag_enter_handler = handler

    def set_drag_leave_handler(self, handler: Callable[[], None]):
        """Set custom handler for drag leave events.
        
        Args:
            handler: Function to call when drag leaves
        """
        self._drag_leave_handler = handler

    def set_drop_handler(self, handler: Callable[[str], bool]):
        """Set custom handler for drop events.
        
        Args:
            handler: Function to call with file path, should return True if handled
        """
        self._drop_handler = handler

    def set_key_press_handler(self, handler: Callable[[QKeyEvent], None]):
        """Set custom handler for key press events.
        
        Args:
            handler: Function to call with key event
        """
        self._key_press_handler = handler

    def set_key_release_handler(self, handler: Callable[[QKeyEvent], None]):
        """Set custom handler for key release events.
        
        Args:
            handler: Function to call with key event
        """
        self._key_release_handler = handler

    def eventFilter(self, obj: QObject, event: QEvent) -> bool:
        """Filter events for the settings dialog.
        
        Args:
            obj: Object that received the event
            event: The event to filter
            
        Returns:
            True if event was handled, False otherwise
        """
        try:
            # Handle drag enter events
            if event.type() == QEvent.Type.DragEnter:
                return self._handle_drag_enter(obj, event)

            # Handle drag leave events
            if event.type() == QEvent.Type.DragLeave:
                return self._handle_drag_leave(obj, event)

            # Handle drop events
            if event.type() == QEvent.Type.Drop:
                return self._handle_drop(obj, event)

            # Handle key press events
            if event.type() == QEvent.Type.KeyPress and self.is_recording_key:
                return self._handle_key_press(obj, event)

            # Handle key release events
            if event.type() == QEvent.Type.KeyRelease and self.is_recording_key:
                return self._handle_key_release(obj, event)

        except Exception as e:
            # Log error and continue
            self.event_filtered.emit("error", f"Event filter error: {e!s}")

        return False

    def _handle_drag_enter(self, obj: QObject, event: QEvent) -> bool:
        """Handle drag enter events.
        
        Args:
            obj: Object that received the event
            event: Drag enter event
            
        Returns:
            True if event was handled
        """
        if not isinstance(event, QDragEnterEvent):
            return False
            
        mime_data = event.mimeData()
        if not mime_data.hasUrls():
            return False

        file_path = mime_data.urls()[0].toLocalFile()
        if not self._is_supported_file(file_path):
            return False

        # Set cursor for supported widget types
        if self._is_cursor_managed_widget(obj) and isinstance(obj, QWidget):
            obj.setCursor(Qt.CursorShape.DragCopyCursor)
            event.acceptProposedAction()

            # Emit signal
            self.drag_entered.emit(file_path)

            # Call custom handler if set
            if self._drag_enter_handler:
                self._drag_enter_handler(file_path)

            self.event_filtered.emit("drag_enter", f"File: {os.path.basename(file_path)}")
            return True

        return False

    def _handle_drag_leave(self, obj: QObject, event: QEvent) -> bool:
        """Handle drag leave events.
        
        Args:
            obj: Object that received the event
            event: Drag leave event
            
        Returns:
            True if event was handled
        """
        # Reset cursor when drag leaves
        if self._is_cursor_managed_widget(obj) and isinstance(obj, QWidget):
            obj.unsetCursor()

            # Emit signal
            self.drag_left.emit()

            # Call custom handler if set
            if self._drag_leave_handler:
                self._drag_leave_handler()

            self.event_filtered.emit("drag_leave", "Cursor reset")
            return True

        return False

    def _handle_drop(self, obj: QObject, event: QEvent) -> bool:
        """Handle drop events.
        
        Args:
            obj: Object that received the event
            event: Drop event
            
        Returns:
            True if event was handled
        """
        if not isinstance(event, QDropEvent):
            return False
            
        mime_data = event.mimeData()
        if not mime_data.hasUrls():
            return False

        url = mime_data.urls()[0]
        path = url.toLocalFile()

        if not self._is_supported_file(path):
            return False

        # Reset cursor
        if self._is_cursor_managed_widget(obj) and isinstance(obj, QWidget):
            obj.unsetCursor()

        # Call custom handler if set
        handled = False
        if self._drop_handler:
            handled = self._drop_handler(path)

        if handled:
            # Emit signal
            self.file_dropped.emit(path)

            # Accept the action
            event.acceptProposedAction()

            self.event_filtered.emit("drop", f"File dropped: {os.path.basename(path)}")
            return True

        return False

    def _handle_key_press(self, obj: QObject, event: QKeyEvent) -> bool:
        """Handle key press events.
        
        Args:
            obj: Object that received the event
            event: Key press event
            
        Returns:
            True if event was handled
        """
        # Emit signal
        self.key_pressed.emit(event)

        # Call custom handler if set
        if self._key_press_handler:
            self._key_press_handler(event)

        self.event_filtered.emit("key_press", f"Key: {event.key()}")
        return True

    def _handle_key_release(self, obj: QObject, event: QKeyEvent) -> bool:
        """Handle key release events.
        
        Args:
            obj: Object that received the event
            event: Key release event
            
        Returns:
            True if event was handled
        """
        # Emit signal
        self.key_released.emit(event)

        # Call custom handler if set
        if self._key_release_handler:
            self._key_release_handler(event)

        self.event_filtered.emit("key_release", f"Key: {event.key()}")
        return True

    def _is_supported_file(self, file_path: str) -> bool:
        """Check if the file is a supported type.
        
        Args:
            file_path: Path to the file
            
        Returns:
            True if file type is supported
        """
        return any(file_path.lower().endswith(ext) for ext in self.supported_file_types)

    def _is_cursor_managed_widget(self, obj: QObject) -> bool:
        """Check if the object is a widget that should have cursor management.
        
        Args:
            obj: Object to check
            
        Returns:
            True if cursor should be managed for this widget
        """
        # Check if it's in our managed widgets list
        if obj in self._cursor_widgets:
            return True

        # Check if it's a supported widget type
        return isinstance(obj, QLabel | QLineEdit | QPushButton | QGroupBox | QWidget)

    def install_on_widget(self, widget: QWidget):
        """Install this event filter on a widget.
        
        Args:
            widget: Widget to install filter on
        """
        widget.installEventFilter(self)
        self.add_cursor_widget(widget)

    def uninstall_from_widget(self, widget: QWidget):
        """Uninstall this event filter from a widget.
        
        Args:
            widget: Widget to uninstall filter from
        """
        widget.removeEventFilter(self)
        self.remove_cursor_widget(widget)

    def install_on_widgets(self, widgets: list[QWidget]):
        """Install this event filter on multiple widgets.
        
        Args:
            widgets: List of widgets to install filter on
        """
        for widget in widgets:
            self.install_on_widget(widget)

    def uninstall_from_widgets(self, widgets: list[QWidget]):
        """Uninstall this event filter from multiple widgets.
        
        Args:
            widgets: List of widgets to uninstall filter from
        """
        for widget in widgets:
            self.uninstall_from_widget(widget)

    def get_supported_file_types(self) -> list[str]:
        """Get the list of supported file types.
        
        Returns:
            List of supported file extensions
        """
        return self.supported_file_types.copy()

    def is_file_supported(self, file_path: str) -> bool:
        """Check if a file is supported.
        
        Args:
            file_path: Path to check
            
        Returns:
            True if file is supported
        """
        return self._is_supported_file(file_path)

    def get_cursor_widgets(self) -> list[QWidget]:
        """Get the list of cursor-managed widgets.
        
        Returns:
            List of widgets with cursor management
        """
        return self._cursor_widgets.copy()

    def reset_all_cursors(self):
        """Reset cursors on all managed widgets."""
        for widget in self._cursor_widgets:
            try:
                widget.unsetCursor()
            except RuntimeError:
                # Widget has been deleted
                pass

    def cleanup(self):
        """Clean up the event filter."""
        # Reset all cursors
        self.reset_all_cursors()

        # Clear widget references
        self.clear_cursor_widgets()

        # Clear handlers
        self._drag_enter_handler = None
        self._drag_leave_handler = None
        self._drop_handler = None
        self._key_press_handler = None
        self._key_release_handler = None

        # Reset state
        self.is_recording_key = False

    def get_filter_info(self) -> dict:
        """Get information about the event filter.
        
        Returns:
            Dictionary with filter information
        """
        return {
            "supported_file_types": self.supported_file_types,
            "is_recording_key": self.is_recording_key,
            "cursor_widgets_count": len(self._cursor_widgets),
            "has_drag_enter_handler": self._drag_enter_handler is not None,
            "has_drag_leave_handler": self._drag_leave_handler is not None,
            "has_drop_handler": self._drop_handler is not None,
            "has_key_press_handler": self._key_press_handler is not None,
            "has_key_release_handler": self._key_release_handler is not None,
        }

    def set_file_type_filter(self, category: str):
        """Set file type filter based on category.
        
        Args:
            category: File category ('audio', 'all', etc.)
        """
        if category == "audio":
            self.supported_file_types = [".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac"]
        elif category == "all":
            self.supported_file_types = [".*"]  # Accept all files
        else:
            # Custom category - keep current types
            pass

    def add_file_type(self, extension: str):
        """Add a file type to the supported list.
        
        Args:
            extension: File extension to add (e.g., '.wav')
        """
        if extension not in self.supported_file_types:
            self.supported_file_types.append(extension)

    def remove_file_type(self, extension: str):
        """Remove a file type from the supported list.
        
        Args:
            extension: File extension to remove
        """
        if extension in self.supported_file_types:
            self.supported_file_types.remove(extension)

    def enable_all_events(self):
        """Enable handling of all event types."""
        self.is_recording_key = True

    def disable_all_events(self):
        """Disable handling of all event types."""
        self.is_recording_key = False
        self.reset_all_cursors()

    def get_event_statistics(self) -> dict:
        """Get statistics about handled events.
        
        Returns:
            Dictionary with event statistics
        """
        # This would track event counts in a full implementation
        return {
            "total_events_handled": 0,
            "drag_enter_count": 0,
            "drag_leave_count": 0,
            "drop_count": 0,
            "key_press_count": 0,
            "key_release_count": 0,
        }

    def reset_statistics(self):
        """Reset event statistics."""
        # This would reset counters in a full implementation
