"""Drag Drop Integration Service.

This module provides infrastructure services for managing drag and drop
functionality, including file handling, validation, and event processing.
"""

from collections.abc import Callable
from pathlib import Path

from PyQt6.QtCore import QObject, Qt, pyqtSignal
from PyQt6.QtGui import QDragEnterEvent, QDragLeaveEvent, QDragMoveEvent, QDropEvent
from PyQt6.QtWidgets import QWidget

from logger import setup_logger
from src.domain.common.result import Result
from src_refactored.domain.system_integration.value_objects.drag_drop_operations import (
    DragDropConfig,
    DropResult,
    FileType,
)


class DragDropIntegrationService(QObject):
    """Service for managing drag and drop integration."""

    # Signals
    drag_entered = pyqtSignal(list)  # file_paths
    drag_left = pyqtSignal()
    files_dropped = pyqtSignal(list)  # file_paths
    directories_dropped = pyqtSignal(list)  # directory_paths
    drop_completed = pyqtSignal(object)  # DropResult
    drop_error = pyqtSignal(str)  # error_message

    def __init__(self, config: DragDropConfig | None = None):
        """Initialize the drag drop integration service.
        
        Args:
            config: Configuration for drag and drop behavior
        """
        super().__init__()
        self.logger = setup_logger()
        self.config = config or DragDropConfig()
        self._enabled_widgets: list[QWidget] = []
        self._drop_handlers: list[Callable] = []

    def enable_drag_drop(self, widget: QWidget) -> Result[None]:
        """Enable drag and drop for a widget.
        
        Args:
            widget: Widget to enable drag and drop for
            
        Returns:
            Result indicating success or failure
        """
        try:
            if not self.config.enabled:
                return Result.failure("Drag and drop is disabled in configuration")

            if widget in self._enabled_widgets:
                return Result.success(None)  # Already enabled

            # Enable drops
            widget.setAcceptDrops(True)

            # Store original event handlers
            original_drag_enter = getattr(widget, "dragEnterEvent", None)
            original_drag_move = getattr(widget, "dragMoveEvent", None)
            original_drag_leave = getattr(widget, "dragLeaveEvent", None)
            original_drop = getattr(widget, "dropEvent", None)

            # Create new event handlers
            def drag_enter_event(event: QDragEnterEvent):
                self._handle_drag_enter(event)
                if original_drag_enter:
                    original_drag_enter(event)

            def drag_move_event(event: QDragMoveEvent):
                self._handle_drag_move(event)
                if original_drag_move:
                    original_drag_move(event)

            def drag_leave_event(event: QDragLeaveEvent):
                self._handle_drag_leave(event)
                if original_drag_leave:
                    original_drag_leave(event)

            def drop_event(event: QDropEvent):
                self._handle_drop(event)
                if original_drop:
                    original_drop(event)

            # Replace event handlers
            widget.dragEnterEvent = drag_enter_event
            widget.dragMoveEvent = drag_move_event
            widget.dragLeaveEvent = drag_leave_event
            widget.dropEvent = drop_event

            self._enabled_widgets.append(widget)
            self.logger.info("Enabled drag and drop for widget: {widget.objectName()}")

            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to enable drag and drop: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)

    def disable_drag_drop(self, widget: QWidget) -> Result[None]:
        """Disable drag and drop for a widget.
        
        Args:
            widget: Widget to disable drag and drop for
            
        Returns:
            Result indicating success or failure
        """
        try:
            if widget not in self._enabled_widgets:
                return Result.success(None)  # Already disabled

            widget.setAcceptDrops(False)
            self._enabled_widgets.remove(widget)

            self.logger.info("Disabled drag and drop for widget: {widget.objectName()}")
            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to disable drag and drop: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)

    def add_drop_handler(self, handler: Callable[[list[Path]], None]) -> None:
        """Add a handler for drop events.
        
        Args:
            handler: Function to call when files are dropped
        """
        if handler not in self._drop_handlers:
            self._drop_handlers.append(handler)
            self.logger.info("Added drop handler")

    def remove_drop_handler(self, handler: Callable[[list[Path]], None]) -> None:
        """Remove a drop handler.
        
        Args:
            handler: Handler function to remove
        """
        if handler in self._drop_handlers:
            self._drop_handlers.remove(handler)
            self.logger.info("Removed drop handler")

    def _handle_drag_enter(self, event: QDragEnterEvent) -> None:
        """Handle drag enter event."""
        try:
            mime_data = event.mimeData()
            if not mime_data.hasUrls():
                event.ignore()
                return

            # Check if any files are acceptable
            acceptable_files = []
            for url in mime_data.urls():
                file_path = Path(url.toLocalFile())
                if self._is_acceptable_file(file_path):
                    acceptable_files.append(file_path)

            if acceptable_files:
                if self.config.show_drop_indicator:
                    # Change cursor to indicate drop is possible
                    event.source().setCursor(Qt.CursorShape.DragCopyCursor)

                self.drag_entered.emit([str(f) for f in acceptable_files])
                event.acceptProposedAction()
            else:
                event.ignore()

        except Exception as e:
            self.logger.exception(f"Error in drag enter: {e!s}")
            event.ignore()

    def _handle_drag_move(self, event: QDragMoveEvent) -> None:
        """Handle drag move event."""
        # Accept the drag move if we accepted the drag enter
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            event.ignore()

    def _handle_drag_leave(self, event: QDragLeaveEvent) -> None:
        """Handle drag leave event."""
        try:
            # Reset cursor
            if hasattr(event.source(), "setCursor"):
                event.source().setCursor(Qt.CursorShape.ArrowCursor)

            self.drag_left.emit()
            event.accept()

        except Exception as e:
            self.logger.exception(f"Error in drag leave: {e!s}")

    def _handle_drop(self, event: QDropEvent) -> None:
        """Handle drop event."""
        try:
            # Reset cursor
            if hasattr(event.source(), "setCursor"):
                event.source().setCursor(Qt.CursorShape.ArrowCursor)

            mime_data = event.mimeData()
            if not mime_data.hasUrls():
                event.ignore()
                return

            # Process dropped files
            files = []
            directories = []
            errors = []

            for url in mime_data.urls():
                file_path = Path(url.toLocalFile())

                if file_path.is_dir():
                    if self.config.allow_directories:
                        directories.append(file_path)
                        # Collect audio/video files from directory
                        dir_files = self._collect_files_from_directory(file_path)
                        files.extend(dir_files)
                    else:
                        errors.append(f"Directories not allowed: {file_path}")

                elif file_path.is_file():
                    if self._is_acceptable_file(file_path):
                        files.append(file_path)
                    else:
                        errors.append(f"File type not supported: {file_path}")

            # Create result
            result = DropResult(
                success=len(errors) == 0,
                files_processed=files,
                directories_processed=directories,
                errors=errors,
                total_files=len(files),
            )

            # Emit signals
            if files:
                self.files_dropped.emit([str(f) for f in files])
            if directories:
                self.directories_dropped.emit([str(d) for d in directories])

            # Call registered handlers
            if self.config.auto_process and files:
                for handler in self._drop_handlers:
                    try:
                        handler(files)
                    except Exception as e:
                        self.logger.exception(f"Error in drop handler: {e!s}")
                        errors.append(f"Handler error: {e!s}")

            self.drop_completed.emit(result)

            if errors:
                self.drop_error.emit("; ".join(errors))

            event.acceptProposedAction()

        except Exception as e:
            error_msg = f"Error processing drop: {e!s}"
            self.logger.exception(error_msg)
            self.drop_error.emit(error_msg)
            event.ignore()

    def _is_acceptable_file(self, file_path: Path) -> bool:
        """Check if a file is acceptable for dropping."""
        try:
            # Check if it's a directory and directories are allowed
            if file_path.is_dir():
                return self.config.allow_directories

            # Check file extension
            if self.config.accepted_extensions:
                if file_path.suffix.lower() not in self.config.accepted_extensions:
                    return False

            # Check file size
            if self.config.max_file_size_mb:
                file_size_mb = file_path.stat().st_size / (1024 * 1024)
                if file_size_mb > self.config.max_file_size_mb:
                    return False

            return True

        except Exception as e:
            self.logger.exception(f"Error checking file acceptability: {e!s}")
            return False

    def _collect_files_from_directory(self, directory: Path) -> list[Path]:
        """Collect acceptable files from a directory."""
        files = []
        try:
            for file_path in directory.rglob("*"):
                if file_path.is_file() and self._is_acceptable_file(file_path):
                    files.append(file_path)
        except Exception as e:
            self.logger.exception(f"Error collecting files from directory: {e!s}")

        return files

    def get_enabled_widgets(self) -> list[QWidget]:
        """Get list of widgets with drag and drop enabled.
        
        Returns:
            List of enabled widgets
        """
        return self._enabled_widgets.copy()

    def update_config(self, config: DragDropConfig) -> None:
        """Update the drag and drop configuration.
        
        Args:
            config: New configuration
        """
        self.config = config
        self.logger.info("Updated drag and drop configuration")

    @classmethod
    def create_for_main_window(cls) -> "DragDropIntegrationService":
        """Factory method to create service configured for main window.
        
        Returns:
            Configured DragDropIntegrationService instance
        """
        config = DragDropConfig(
            enabled=True,
            accepted_file_types=[FileType.AUDIO, FileType.VIDEO],
            accepted_extensions=[
                ".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg",
                ".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv",
            ],
            allow_directories=True,
            show_drop_indicator=True,
            auto_process=True,
        )

        return cls(config)