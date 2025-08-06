"""Settings Dialog Lifecycle Management Component.

This module provides lifecycle management functionality for the settings dialog,
handling show/hide/close events, progress bar reparenting, and cleanup operations.
"""

import contextlib
import logging
from collections.abc import Callable
from typing import Any

from PyQt6.QtCore import QObject, QTimer, pyqtSignal
from PyQt6.QtGui import QCloseEvent, QShowEvent
from PyQt6.QtWidgets import QDialog, QLayout, QProgressBar, QWidget

from src_refactored.domain.common.ports.dialog_lifecycle_port import IDialogLifecycleManager
from src_refactored.infrastructure.lifecycle.dialog_lifecycle_service import (
    DialogLifecycleService,
)


class SettingsLifecycleManager(QObject):
    """Lifecycle manager for settings dialog.
    
    This component handles:
    - Dialog show/hide/close events
    - Progress bar reparenting during downloads
    - UI state management during operations
    - Signal connection cleanup
    - Resource cleanup on close
    """

    # Signals for lifecycle events
    dialog_opening = pyqtSignal()
    dialog_opened = pyqtSignal()
    dialog_closing = pyqtSignal()
    dialog_closed = pyqtSignal()
    progress_bar_moved = pyqtSignal(str)  # direction: 'to_dialog' or 'to_parent'
    ui_state_changed = pyqtSignal(bool)  # enabled
    cleanup_completed = pyqtSignal()
    lifecycle_error = pyqtSignal(str)  # error_message

    def __init__(self, dialog: QDialog, lifecycle_manager: IDialogLifecycleManager, parent=None):
        """Initialize the lifecycle manager.
        
        Args:
            dialog: The dialog to manage
            lifecycle_manager: Dialog lifecycle manager port
            parent: Parent object
        """
        super().__init__(parent)

        # Core references
        self._dialog = dialog
        self._parent_window = None

        # Injected dependencies
        self._manage_lifecycle_use_case = lifecycle_manager

        # Initialize services
        self._lifecycle_service = DialogLifecycleService()

        # Progress bar management
        self._progress_bar: QProgressBar | None = None
        self._original_progress_parent: QWidget | None = None
        self._original_progress_geometry = None
        self._progress_placeholder_layout: QLayout | None = None
        self._is_progress_bar_moving = False

        # Download state
        self._is_downloading_model = False

        # UI state management
        self._ui_elements_enabled = True
        self._ui_elements: list[QWidget] = []

        # Event handlers
        self._close_handler: Callable | None = None
        self._show_handler: Callable | None = None
        self._exec_handler: Callable | None = None

        # Signal connections to cleanup
        self._signal_connections: list[tuple] = []

        # Timers for delayed operations
        self._cleanup_timer = QTimer()
        self._cleanup_timer.setSingleShot(True)
        self._cleanup_timer.timeout.connect(self._reset_progress_moving_flag)

        # Logger
        self._logger = logging.getLogger(__name__)

    def set_parent_window(self, parent_window: QWidget):
        """Set the parent window reference.
        
        Args:
            parent_window: The main window that owns this dialog
        """
        self._parent_window = parent_window

    def set_progress_bar(self, progress_bar: QProgressBar):
        """Set the progress bar to manage.
        
        Args:
            progress_bar: Progress bar widget
        """
        self._progress_bar = progress_bar

    def set_progress_placeholder_layout(self, layout: QLayout):
        """Set the layout where progress bar should be placed in dialog.
        
        Args:
            layout: Layout for progress bar placement
        """
        self._progress_placeholder_layout = layout

    def set_download_state(self, is_downloading: bool):
        """Set the download state.
        
        Args:
            is_downloading: Whether a download is in progress
        """
        self._is_downloading_model = is_downloading

    def add_ui_element(self, element: QWidget):
        """Add a UI element to manage.
        
        Args:
            element: Widget to manage state for
        """
        if element not in self._ui_elements:
            self._ui_elements.append(element)

    def remove_ui_element(self, element: QWidget):
        """Remove a UI element from management.
        
        Args:
            element: Widget to remove
        """
        if element in self._ui_elements:
            self._ui_elements.remove(element)

    def set_ui_elements(self, elements: list[QWidget]):
        """Set the list of UI elements to manage.
        
        Args:
            elements: List of widgets to manage
        """
        self._ui_elements = elements.copy()

    def set_close_handler(self, handler: Callable[[QCloseEvent], None]):
        """Set custom close event handler.
        
        Args:
            handler: Function to call on close event
        """
        self._close_handler = handler

    def set_show_handler(self, handler: Callable[[QShowEvent], None]):
        """Set custom show event handler.
        
        Args:
            handler: Function to call on show event
        """
        self._show_handler = handler

    def set_exec_handler(self, handler: Callable[[], Any]):
        """Set custom exec handler.
        
        Args:
            handler: Function to call on exec
        """
        self._exec_handler = handler

    def add_signal_connection(self, signal, slot):
        """Add a signal connection to track for cleanup.
        
        Args:
            signal: The signal object
            slot: The slot function
        """
        self._signal_connections.append((signal, slot))

    def handle_close_event(self, event: QCloseEvent):
        """Handle the dialog close event.
        
        Args:
            event: Close event
        """
        try:
            self.dialog_closing.emit()

            # Cleanup signal connections
            self._cleanup_signal_connections()

            # Handle progress bar reparenting if downloading
            if self._is_downloading_model:
                self._handle_close_during_download()

            # Call custom handler if set
            if self._close_handler:
                self._close_handler(event)

            # Accept the event
            event.accept()

            # Emit completion signal
            self.dialog_closed.emit()

        except Exception as e:
            self._logger.exception(f"Error handling close event: {e}")
            self.lifecycle_error.emit(f"Close error: {e!s}")
            event.accept()  # Still close the dialog

    def handle_show_event(self, event: QShowEvent):
        """Handle the dialog show event.
        
        Args:
            event: Show event
        """
        try:
            self.dialog_opening.emit()

            # Update UI state if downloading
            if self._is_downloading_model:
                self._set_ui_elements_enabled(False)

            # Handle progress bar if downloading
            if self._should_move_progress_bar_to_dialog():
                QTimer.singleShot(100, self._move_progress_bar_to_dialog)

            # Call custom handler if set
            if self._show_handler:
                self._show_handler(event)

            # Emit completion signal
            self.dialog_opened.emit()

        except Exception as e:
            self._logger.exception(f"Error handling show event: {e}")
            self.lifecycle_error.emit(f"Show error: {e!s}")

    def handle_exec(self) -> Any:
        """Handle the dialog exec call.
        
        Returns:
            Result of dialog execution
        """
        try:
            self._logger.debug("Executing dialog")

            # Update UI state if downloading
            if self._is_downloading_model:
                self._set_ui_elements_enabled(False)

            # Handle progress bar if downloading
            if self._should_move_progress_bar_to_dialog():
                QTimer.singleShot(50, self._move_progress_bar_to_dialog)

            # Call custom handler if set
            if self._exec_handler:
                return self._exec_handler()

            # Default behavior - call dialog's exec
            return self._dialog.exec()

        except Exception as e:
            self._logger.exception(f"Error handling exec: {e}")
            self.lifecycle_error.emit(f"Exec error: {e!s}")
            return QDialog.DialogCode.Rejected

    def _cleanup_signal_connections(self):
        """Clean up tracked signal connections."""
        for signal, slot in self._signal_connections:
            try:
                signal.disconnect(slot)
            except (TypeError, RuntimeError):
                # Already disconnected or connection failed
                pass

        self._signal_connections.clear()

    def _handle_close_during_download(self):
        """Handle closing dialog during download."""
        if not self._parent_window or not self._progress_bar:
            return

        if self._is_progress_bar_moving:
            return

        try:
            self._is_progress_bar_moving = True

            # Remove progress bar from dialog layout
            self._remove_progress_bar_from_dialog()

            # Return progress bar to parent
            self._return_progress_bar_to_parent()

            # Emit signal
            self.progress_bar_moved.emit("to_parent")

        except RuntimeError:
            # Progress bar has been deleted
            self._logger.warning("Progress bar was deleted during close")
        finally:
            # Reset flag after delay
            self._cleanup_timer.start(200)

    def _remove_progress_bar_from_dialog(self):
        """Remove progress bar from dialog layout."""
        if not self._progress_placeholder_layout or not self._progress_bar:
            return

        for i in reversed(range(self._progress_placeholder_layout.count())):
            item = self._progress_placeholder_layout.itemAt(i)
            if item and item.widget() == self._progress_bar:
                self._progress_placeholder_layout.removeItem(item)
                break

    def _return_progress_bar_to_parent(self):
        """Return progress bar to its original parent."""
        if not self._progress_bar:
            return

        # Set parent
        if self._original_progress_parent:
            self._progress_bar.setParent(self._original_progress_parent)

            # Restore geometry if available
            if self._original_progress_geometry:
                self._progress_bar.setGeometry(self._original_progress_geometry)
        # Fallback to centralwidget
        elif hasattr(self._parent_window, "centralwidget"):
            self._progress_bar.setParent(self._parent_window.centralwidget)

        # Make visible and update
        self._progress_bar.setVisible(True)
        self._progress_bar.raise_()
        self._progress_bar.update()

        # Update parent
        if self._original_progress_parent:
            self._original_progress_parent.update()
        elif hasattr(self._parent_window, "centralwidget"):
            self._parent_window.centralwidget.update()

    def _should_move_progress_bar_to_dialog(self) -> bool:
        """Check if progress bar should be moved to dialog.
        
        Returns:
            True if progress bar should be moved
        """
        return (
            self._is_downloading_model and
            self._progress_bar is not None and
            not self._is_progress_bar_moving
        )

    def _move_progress_bar_to_dialog(self):
        """Move progress bar to dialog."""
        if not self._progress_bar or not self._progress_placeholder_layout:
            return

        try:
            # Store original parent and geometry
            if not self._original_progress_parent:
                self._original_progress_parent = self._progress_bar.parent()
                self._original_progress_geometry = self._progress_bar.geometry()

            # Move to dialog
            self._progress_bar.setParent(self._dialog)
            self._progress_placeholder_layout.addWidget(self._progress_bar)

            # Make visible
            self._progress_bar.setVisible(True)
            self._progress_bar.update()

            # Emit signal
            self.progress_bar_moved.emit("to_dialog")

        except RuntimeError:
            self._logger.warning("Progress bar was deleted during move")

    def _set_ui_elements_enabled(self, enabled: bool):
        """Set enabled state for managed UI elements.
        
        Args:
            enabled: Whether elements should be enabled
        """
        self._ui_elements_enabled = enabled

        for element in self._ui_elements:
            try:
                element.setEnabled(enabled)
            except RuntimeError:
                # Widget has been deleted
                pass

        self.ui_state_changed.emit(enabled)

    def _reset_progress_moving_flag(self):
        """Reset the progress bar moving flag."""
        self._is_progress_bar_moving = False

    def get_dialog_state(self) -> dict:
        """Get current dialog state information.
        
        Returns:
            Dictionary with state information
        """
        return {
            "is_downloading": self._is_downloading_model,
            "ui_elements_enabled": self._ui_elements_enabled,
            "progress_bar_moving": self._is_progress_bar_moving,
            "has_progress_bar": self._progress_bar is not None,
            "has_parent_window": self._parent_window is not None,
            "ui_elements_count": len(self._ui_elements),
            "signal_connections_count": len(self._signal_connections),
        }

    def is_downloading(self) -> bool:
        """Check if download is in progress.
        
        Returns:
            True if downloading
        """
        return self._is_downloading_model

    def is_progress_bar_moving(self) -> bool:
        """Check if progress bar is currently being moved.
        
        Returns:
            True if moving
        """
        return self._is_progress_bar_moving

    def get_ui_elements_enabled(self) -> bool:
        """Get UI elements enabled state.
        
        Returns:
            True if UI elements are enabled
        """
        return self._ui_elements_enabled

    def force_enable_ui(self):
        """Force enable all UI elements."""
        self._set_ui_elements_enabled(True)

    def force_disable_ui(self):
        """Force disable all UI elements."""
        self._set_ui_elements_enabled(False)

    def reset_progress_bar_state(self):
        """Reset progress bar state and position."""
        if self._progress_bar and self._original_progress_parent:
            with contextlib.suppress(RuntimeError):
                self._return_progress_bar_to_parent()

        self._is_progress_bar_moving = False

    def cleanup(self):
        """Clean up the lifecycle manager."""
        try:
            # Cleanup signal connections
            self._cleanup_signal_connections()

            # Reset progress bar if needed
            self.reset_progress_bar_state()

            # Stop timers
            self._cleanup_timer.stop()

            # Clear references
            self._ui_elements.clear()
            self._progress_bar = None
            self._original_progress_parent = None
            self._original_progress_geometry = None
            self._progress_placeholder_layout = None

            # Reset state
            self._is_downloading_model = False
            self._is_progress_bar_moving = False
            self._ui_elements_enabled = True

            # Clear handlers
            self._close_handler = None
            self._show_handler = None
            self._exec_handler = None

            self.cleanup_completed.emit()

        except Exception as e:
            self._logger.exception(f"Error during cleanup: {e}")
            self.lifecycle_error.emit(f"Cleanup error: {e!s}")

    def get_lifecycle_statistics(self) -> dict:
        """Get lifecycle management statistics.
        
        Returns:
            Dictionary with statistics
        """
        return {
            "total_show_events": 0,  # Would track in full implementation
            "total_close_events": 0,
            "total_exec_calls": 0,
            "progress_bar_moves": 0,
            "ui_state_changes": 0,
            "cleanup_operations": 0,
        }

    def reset_statistics(self):
        """Reset lifecycle statistics."""
        # Would reset counters in full implementation

    def install_on_dialog(self):
        """Install lifecycle management on the dialog."""
        # Override dialog methods to use our handlers
        original_show_event = self._dialog.showEvent

        def close_event_wrapper(event):
            self.handle_close_event(event)

        def show_event_wrapper(event):
            self.handle_show_event(event)
            original_show_event(event)

        def exec_wrapper():
            return self.handle_exec()

        # Replace methods
        self._dialog.closeEvent = close_event_wrapper
        self._dialog.showEvent = show_event_wrapper
        self._dialog.exec = exec_wrapper

    def uninstall_from_dialog(self):
        """Uninstall lifecycle management from the dialog."""
        # This would restore original methods in a full implementation
        # For now, just cleanup
        self.cleanup()

    def get_managed_widgets_info(self) -> list[dict]:
        """Get information about managed widgets.
        
        Returns:
            List of widget information dictionaries
        """
        widget_info = []
        for widget in self._ui_elements:
            try:
                info = {
                    "class_name": widget.__class__.__name__,
                    "object_name": widget.objectName(),
                    "enabled": widget.isEnabled(),
                    "visible": widget.isVisible(),
                }
                widget_info.append(info)
            except RuntimeError:
                # Widget has been deleted
                widget_info.append({
                    "class_name": "DeletedWidget",
                    "object_name": "unknown",
                    "enabled": False,
                    "visible": False,
                })

        return widget_info

    def validate_state(self) -> bool:
        """Validate the current state of the lifecycle manager.
        
        Returns:
            True if state is valid
        """
        try:
            # Check dialog reference
            if not self._dialog:
                return False

            # Check progress bar consistency
            if self._progress_bar and self._is_progress_bar_moving:
                # Should have original parent info
                if not self._original_progress_parent:
                    return False

            # Check UI elements
            valid_elements = 0
            for element in self._ui_elements:
                try:
                    # Try to access a property to check if widget is valid
                    _ = element.isEnabled()
                    valid_elements += 1
                except RuntimeError:
                    # Widget has been deleted
                    pass

            # At least some elements should be valid if we have any
            return not (self._ui_elements and valid_elements == 0)

        except Exception:
            return False