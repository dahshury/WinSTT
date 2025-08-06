"""Drag and drop service for UI file handling.

This module provides infrastructure services for handling drag and drop
operations with file validation and event management.
"""

from collections.abc import Callable
from pathlib import Path

from PyQt6 import QtCore
from PyQt6.QtCore import QMimeData, QObject, pyqtSignal
from PyQt6.QtGui import QDragEnterEvent, QDragLeaveEvent, QDragMoveEvent, QDropEvent
from PyQt6.QtWidgets import QWidget

from src_refactored.domain.ui_coordination.value_objects.drag_drop_operations import (
    DragDropEventData,
)


class InfrastructureDragDropEventData:
    """Infrastructure-specific drag and drop event data with PyQt integration."""

    def __init__(self,
                 domain_data: DragDropEventData,
                 mime_data: QMimeData | None = None):
        """Initialize infrastructure drag drop event data.
        
        Args:
            domain_data: Domain drag drop event data
            mime_data: Original QMimeData object
        """
        self.domain_data = domain_data
        self.mime_data = mime_data
        self.timestamp = QtCore.QDateTime.currentDateTime()

    @property
    def files(self) -> list[str]:
        """Get files from domain data."""
        return self.domain_data.files

    @property
    def position(self) -> tuple[float, float] | None:
        """Get position from domain data."""
        return self.domain_data.position


class DragDropService(QObject):
    """Service for managing drag and drop operations.
    
    This service provides infrastructure-only logic for drag and drop
    handling without any business logic dependencies.
    """

    # Signals for drag and drop events
    files_dropped = pyqtSignal(InfrastructureDragDropEventData)  # files dropped
    drag_entered = pyqtSignal(InfrastructureDragDropEventData)   # drag entered widget
    drag_moved = pyqtSignal(InfrastructureDragDropEventData)     # drag moved over widget
    drag_left = pyqtSignal()                       # drag left widget
    invalid_files_dropped = pyqtSignal(list)       # invalid files attempted

    def __init__(self, parent: QObject | None = None):
        """Initialize the drag and drop service.
        
        Args:
            parent: Parent QObject
        """
        super().__init__(parent)

        # Configuration
        self._accepted_extensions: set[str] = set()
        self._max_files: int | None = None
        self._max_file_size: int | None = None  # in bytes
        self._accept_directories: bool = False
        self._case_sensitive_extensions: bool = False

        # State
        self._enabled: bool = True
        self._drag_active: bool = False

        # Callbacks
        self._validation_callback: Callable[[list[str]], tuple] | None = None
        self._filter_callback: Callable[[list[str]], list[str]] | None = None

    def configure(self,
                 accepted_extensions: list[str] | None = None,
                 max_files: int | None = None,
                 max_file_size: int | None = None,
                 accept_directories: bool = False,
                 case_sensitive_extensions: bool = False,
    ) -> None:
        """Configure drag and drop behavior.
        
        Args:
            accepted_extensions: List of accepted file extensions (e.g., ['.mp3', '.wav'])
            max_files: Maximum number of files to accept
            max_file_size: Maximum file size in bytes
            accept_directories: Whether to accept directory drops
            case_sensitive_extensions: Whether extension matching is case sensitive
        """
        if accepted_extensions is not None:
            if case_sensitive_extensions:
                self._accepted_extensions = set(accepted_extensions)
            else:
                self._accepted_extensions = {ext.lower() for ext in accepted_extensions}

        self._max_files = max_files
        self._max_file_size = max_file_size
        self._accept_directories = accept_directories
        self._case_sensitive_extensions = case_sensitive_extensions

    def set_validation_callback(self, callback: Callable[[list[str]], tuple]) -> None:
        """Set custom validation callback.
        
        Args:
            callback: Function that takes file list and returns (is_valid, error_message)
        """
        self._validation_callback = callback

    def set_filter_callback(self, callback: Callable[[list[str]], list[str]]) -> None:
        """Set custom filter callback.
        
        Args:
            callback: Function that takes file list and returns filtered file list
        """
        self._filter_callback = callback

    def enable_drag_drop(self, widget: QWidget,
    ) -> None:
        """Enable drag and drop for a widget.
        
        Args:
            widget: Widget to enable drag and drop for
        """
        widget.setAcceptDrops(True)

        # Store original event handlers
        original_drag_enter = getattr(widget, "dragEnterEvent", None)
        original_drag_move = getattr(widget, "dragMoveEvent", None)
        original_drag_leave = getattr(widget, "dragLeaveEvent", None)
        original_drop = getattr(widget, "dropEvent", None)

        # Create wrapped event handlers
        def drag_enter_event(event: QDragEnterEvent,
    ):
            self._handle_drag_enter(event)
            if original_drag_enter:
                original_drag_enter(event)

        def drag_move_event(event: QDragMoveEvent,
    ):
            self._handle_drag_move(event)
            if original_drag_move:
                original_drag_move(event)

        def drag_leave_event(event: QDragLeaveEvent,
    ):
            self._handle_drag_leave(event)
            if original_drag_leave:
                original_drag_leave(event)

        def drop_event(event: QDropEvent,
    ):
            self._handle_drop(event)
            if original_drop:
                original_drop(event)

        # Replace event handlers using setattr to avoid shadowing warnings
        widget.dragEnterEvent = drag_enter_event
        widget.dragMoveEvent = drag_move_event
        widget.dragLeaveEvent = drag_leave_event
        widget.dropEvent = drop_event

    def disable_drag_drop(self, widget: QWidget,
    ) -> None:
        """Disable drag and drop for a widget.
        
        Args:
            widget: Widget to disable drag and drop for
        """
        widget.setAcceptDrops(False)

    def _handle_drag_enter(self, event: QDragEnterEvent,
    ) -> None:
        """Handle drag enter event.
        
        Args:
            event: Drag enter event
        """
        if not self._enabled:
            event.ignore()
            return

        files = self._extract_files_from_mime_data(event.mimeData())
        if not files:
            event.ignore()
            return

        valid_files, invalid_files = self._validate_files(files)

        if valid_files:
            event.acceptProposedAction()
            self._drag_active = True

            event_data = DragDropEventData(
                files=valid_files,
                position=(event.position().x(), event.position().y()),
            )
            self.drag_entered.emit(event_data)
        else:
            event.ignore()
            if invalid_files:
                self.invalid_files_dropped.emit(invalid_files)

    def _handle_drag_move(self, event: QDragMoveEvent,
    ) -> None:
        """Handle drag move event.
        
        Args:
            event: Drag move event
        """
        if not self._enabled or not self._drag_active:
            event.ignore()
            return

        files = self._extract_files_from_mime_data(event.mimeData())
        if files:
            event.acceptProposedAction()

            event_data = DragDropEventData(
                files=files,
                position=(event.position().x(), event.position().y()),
            )
            self.drag_moved.emit(event_data)
        else:
            event.ignore()

    def _handle_drag_leave(self, event: QDragLeaveEvent,
    ) -> None:
        """Handle drag leave event.
        
        Args:
            event: Drag leave event
        """
        self._drag_active = False
        self.drag_left.emit()
        event.accept()

    def _handle_drop(self, event: QDropEvent,
    ) -> None:
        """Handle drop event.
        
        Args:
            event: Drop event
        """
        if not self._enabled:
            event.ignore()
            return

        files = self._extract_files_from_mime_data(event.mimeData())
        if not files:
            event.ignore()
            return

        valid_files, invalid_files = self._validate_files(files)

        if valid_files:
            # Apply custom filter if set
            if self._filter_callback:
                valid_files = self._filter_callback(valid_files)

            if valid_files:  # Check again after filtering
                event.acceptProposedAction()

                event_data = DragDropEventData(
                    files=valid_files,
                    position=(event.position().x(), event.position().y()),
                )
                self.files_dropped.emit(event_data)
            else:
                event.ignore()
        else:
            event.ignore()

        if invalid_files:
            self.invalid_files_dropped.emit(invalid_files)

        self._drag_active = False

    def _extract_files_from_mime_data(self, mime_data: QMimeData,
    ) -> list[str]:
        """Extract file paths from mime data.
        
        Args:
            mime_data: QMimeData object
            
        Returns:
            List of file paths
        """
        files = []

        if mime_data.hasUrls():
            for url in mime_data.urls():
                if url.isLocalFile():
                    file_path = url.toLocalFile()
                    files.append(file_path)

        return files

    def _validate_files(self, files: list[str]) -> tuple[list[str], list[str]]:
        """Validate dropped files.
        
        Args:
            files: List of file paths to validate
            
        Returns:
            Tuple of (valid_files, invalid_files)
        """
        valid_files = []
        invalid_files = []

        # Check file count limit
        if self._max_files and len(files) > self._max_files:
            # Take only the first max_files
            files = files[:self._max_files]

        for file_path in files:
            path = Path(file_path)

            # Check if file exists
            if not path.exists():
                invalid_files.append(file_path)
                continue

            # Check if it's a directory
            if path.is_dir():
                if self._accept_directories:
                    valid_files.append(file_path)
                else:
                    invalid_files.append(file_path)
                continue

            # Check file extension
            if self._accepted_extensions:
                file_ext = path.suffix
                if not self._case_sensitive_extensions:
                    file_ext = file_ext.lower()

                if file_ext not in self._accepted_extensions:
                    invalid_files.append(file_path)
                    continue

            # Check file size
            if self._max_file_size:
                try:
                    file_size = path.stat().st_size
                    if file_size > self._max_file_size:
                        invalid_files.append(file_path)
                        continue
                except OSError:
                    invalid_files.append(file_path)
                    continue

            valid_files.append(file_path,
    )

        # Apply custom validation if set
        if self._validation_callback and valid_files:
            is_valid, error_message = self._validation_callback(valid_files)
            if not is_valid:
                invalid_files.extend(valid_files)
                valid_files = []

        return valid_files, invalid_files

    def is_enabled(self) -> bool:
        """Check if drag and drop is enabled.
        
        Returns:
            True if enabled, False otherwise
        """
        return self._enabled

    def set_enabled(self, enabled: bool,
    ) -> None:
        """Enable or disable drag and drop.
        
        Args:
            enabled: Whether to enable drag and drop
        """
        self._enabled = enabled

    def is_drag_active(self) -> bool:
        """Check if a drag operation is currently active.
        
        Returns:
            True if drag is active, False otherwise
        """
        return self._drag_active

    def get_accepted_extensions(self) -> set[str]:
        """Get accepted file extensions.
        
        Returns:
            Set of accepted extensions
        """
        return self._accepted_extensions.copy()

    def get_max_files(self) -> int | None:
        """Get maximum number of files.
        
        Returns:
            Maximum file count or None if unlimited
        """
        return self._max_files

    def get_max_file_size(self) -> int | None:
        """Get maximum file size.
        
        Returns:
            Maximum file size in bytes or None if unlimited
        """
        return self._max_file_size

    def accepts_directories(self) -> bool:
        """Check if directories are accepted.
        
        Returns:
            True if directories are accepted, False otherwise
        """
        return self._accept_directories

    def is_case_sensitive(self) -> bool:
        """Check if extension matching is case sensitive.
        
        Returns:
            True if case sensitive, False otherwise
        """
        return self._case_sensitive_extensions

    def reset_configuration(self) -> None:
        """Reset configuration to defaults."""
        self._accepted_extensions.clear()
        self._max_files = None
        self._max_file_size = None
        self._accept_directories = False
        self._case_sensitive_extensions = False
        self._validation_callback = None
        self._filter_callback = None


class DragDropManager:
    """High-level manager for drag and drop functionality.
    
    Provides a simplified interface for common drag and drop patterns.
    """

    def __init__(self, parent: QObject | None = None):
        """Initialize the drag and drop manager.
        
        Args:
            parent: Parent QObject
        """
        self.service = DragDropService(parent)
        self._widgets: set[QWidget] = set()

    def setup_audio_file_drop(self,
                             widget: QWidget,
                             max_files: int = 10,
                             max_file_size: int = 100 * 1024 * 1024,
    ) -> None:  # 100MB
        """Setup drag and drop for audio files.
        
        Args:
            widget: Widget to enable drag and drop for
            max_files: Maximum number of files
            max_file_size: Maximum file size in bytes
        """
        audio_extensions = [".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".wma"]

        self.service.configure(
            accepted_extensions=audio_extensions,
            max_files=max_files,
            max_file_size=max_file_size,
            accept_directories=False,
            case_sensitive_extensions=False,
        )

        self.service.enable_drag_drop(widget)
        self._widgets.add(widget)

    def setup_video_file_drop(self,
                             widget: QWidget,
                             max_files: int = 5,
                             max_file_size: int = 500 * 1024 * 1024,
    ) -> None:  # 500MB
        """Setup drag and drop for video files.
        
        Args:
            widget: Widget to enable drag and drop for
            max_files: Maximum number of files
            max_file_size: Maximum file size in bytes
        """
        video_extensions = [".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv", ".webm"]

        self.service.configure(
            accepted_extensions=video_extensions,
            max_files=max_files,
            max_file_size=max_file_size,
            accept_directories=False,
            case_sensitive_extensions=False,
        )

        self.service.enable_drag_drop(widget)
        self._widgets.add(widget)

    def setup_media_file_drop(self,
                             widget: QWidget,
                             max_files: int = 10,
                             max_file_size: int = 500 * 1024 * 1024,
    ) -> None:  # 500MB
        """Setup drag and drop for both audio and video files.
        
        Args:
            widget: Widget to enable drag and drop for
            max_files: Maximum number of files
            max_file_size: Maximum file size in bytes
        """
        media_extensions = [
            # Audio
            ".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".wma",
            # Video
            ".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv", ".webm",
        ]

        self.service.configure(
            accepted_extensions=media_extensions,
            max_files=max_files,
            max_file_size=max_file_size,
            accept_directories=False,
            case_sensitive_extensions=False,
        )

        self.service.enable_drag_drop(widget)
        self._widgets.add(widget)

    def setup_sound_file_drop(self,
                              widget: QWidget,
                              max_file_size: int = 10 * 1024 * 1024,
    ) -> None:  # 10MB
        """Setup drag and drop for sound files (mp3, wav only).
        
        This method provides specific functionality for sound file drops
        used in recording notifications, with limited format support.
        
        Args:
            widget: Widget to enable drag and drop for
            max_file_size: Maximum file size in bytes
        """
        sound_extensions = [".mp3", ".wav"]

        self.service.configure(
            accepted_extensions=sound_extensions,
            max_files=1,  # Only one sound file at a time
            max_file_size=max_file_size,
            accept_directories=False,
            case_sensitive_extensions=False,
        )

        self.service.enable_drag_drop(widget)
        self._widgets.add(widget)

    def setup_custom_drop(self,
                         widget: QWidget,
                         accepted_extensions: list[str],
                         max_files: int | None = None,
                         max_file_size: int | None = None,
                         accept_directories: bool = False,
    ) -> None:
        """Setup drag and drop with custom configuration.
        
        Args:
            widget: Widget to enable drag and drop for
            accepted_extensions: List of accepted file extensions
            max_files: Maximum number of files
            max_file_size: Maximum file size in bytes
            accept_directories: Whether to accept directories
        """
        self.service.configure(
            accepted_extensions=accepted_extensions,
            max_files=max_files,
            max_file_size=max_file_size,
            accept_directories=accept_directories,
            case_sensitive_extensions=False,
        )

        self.service.enable_drag_drop(widget)
        self._widgets.add(widget)

    def disable_for_widget(self, widget: QWidget,
    ) -> None:
        """Disable drag and drop for a specific widget.
        
        Args:
            widget: Widget to disable drag and drop for
        """
        self.service.disable_drag_drop(widget)
        self._widgets.discard(widget)

    def disable_all(self) -> None:
        """Disable drag and drop for all managed widgets."""
        for widget in self._widgets.copy():
            self.service.disable_drag_drop(widget)
        self._widgets.clear()

    def set_enabled(self, enabled: bool,
    ) -> None:
        """Enable or disable drag and drop globally.
        
        Args:
            enabled: Whether to enable drag and drop
        """
        self.service.set_enabled(enabled)

    def get_service(self) -> DragDropService:
        """Get the underlying drag and drop service.
        
        Returns:
            DragDropService instance
        """
        return self.service

    def get_managed_widgets(self) -> set[QWidget]:
        """Get set of managed widgets.
        
        Returns:
            Set of widgets with drag and drop enabled
        """
        return self._widgets.copy()