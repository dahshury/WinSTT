"""Drag and drop service for UI file handling (moved to Presentation)."""

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
        self.domain_data = domain_data
        self.mime_data = mime_data
        self.timestamp = QtCore.QDateTime.currentDateTime()

    @property
    def files(self) -> list[str]:
        return self.domain_data.files

    @property
    def position(self) -> tuple[float, float] | None:
        return self.domain_data.position


class DragDropService(QObject):
    """Service for managing drag and drop operations."""

    files_dropped = pyqtSignal(InfrastructureDragDropEventData)
    drag_entered = pyqtSignal(InfrastructureDragDropEventData)
    drag_moved = pyqtSignal(InfrastructureDragDropEventData)
    drag_left = pyqtSignal()
    invalid_files_dropped = pyqtSignal(list)

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self._accepted_extensions: set[str] = set()
        self._max_files: int | None = None
        self._max_file_size: int | None = None
        self._accept_directories: bool = False
        self._case_sensitive_extensions: bool = False
        self._enabled: bool = True
        self._drag_active: bool = False
        self._validation_callback: Callable[[list[str]], tuple] | None = None
        self._filter_callback: Callable[[list[str]], list[str]] | None = None

    def configure(self,
                 accepted_extensions: list[str] | None = None,
                 max_files: int | None = None,
                 max_file_size: int | None = None,
                 accept_directories: bool = False,
                 case_sensitive_extensions: bool = False,
    ) -> None:
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
        self._validation_callback = callback

    def set_filter_callback(self, callback: Callable[[list[str]], list[str]]) -> None:
        self._filter_callback = callback

    def enable_drag_drop(self, widget: QWidget,
    ) -> None:
        widget.setAcceptDrops(True)

        original_drag_enter = getattr(widget, "dragEnterEvent", None)
        original_drag_move = getattr(widget, "dragMoveEvent", None)
        original_drag_leave = getattr(widget, "dragLeaveEvent", None)
        original_drop = getattr(widget, "dropEvent", None)

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

        widget.dragEnterEvent = drag_enter_event
        widget.dragMoveEvent = drag_move_event
        widget.dragLeaveEvent = drag_leave_event
        widget.dropEvent = drop_event

    def disable_drag_drop(self, widget: QWidget,
    ) -> None:
        widget.setAcceptDrops(False)

    def _handle_drag_enter(self, event: QDragEnterEvent,
    ) -> None:
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
        self._drag_active = False
        self.drag_left.emit()
        event.accept()

    def _handle_drop(self, event: QDropEvent,
    ) -> None:
        if not self._enabled:
            event.ignore()
            return
        files = self._extract_files_from_mime_data(event.mimeData())
        if not files:
            event.ignore()
            return
        valid_files, invalid_files = self._validate_files(files)
        if valid_files:
            if self._filter_callback:
                valid_files = self._filter_callback(valid_files)
            if valid_files:
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
        files = []
        if mime_data.hasUrls():
            for url in mime_data.urls():
                if url.isLocalFile():
                    files.append(url.toLocalFile())
        return files

    def _validate_files(self, files: list[str]) -> tuple[list[str], list[str]]:
        valid_files: list[str] = []
        invalid_files: list[str] = []
        if self._max_files and len(files) > self._max_files:
            files = files[:self._max_files]
        for file_path in files:
            path = Path(file_path)
            if not path.exists():
                invalid_files.append(file_path)
                continue
            if path.is_dir():
                if self._accept_directories:
                    valid_files.append(file_path)
                else:
                    invalid_files.append(file_path)
                continue
            if self._accepted_extensions:
                file_ext = path.suffix
                if not self._case_sensitive_extensions:
                    file_ext = file_ext.lower()
                if file_ext not in self._accepted_extensions:
                    invalid_files.append(file_path)
                    continue
            if self._max_file_size:
                try:
                    if path.stat().st_size > self._max_file_size:
                        invalid_files.append(file_path)
                        continue
                except OSError:
                    invalid_files.append(file_path)
                    continue
            valid_files.append(file_path)
        if self._validation_callback and valid_files:
            is_valid, error_message = self._validation_callback(valid_files)
            if not is_valid:
                invalid_files.extend(valid_files)
                valid_files = []
        return valid_files, invalid_files

    def is_enabled(self) -> bool:
        return self._enabled

    def set_enabled(self, enabled: bool,
    ) -> None:
        self._enabled = enabled

    def is_drag_active(self) -> bool:
        return self._drag_active

    def get_accepted_extensions(self) -> set[str]:
        return self._accepted_extensions.copy()

    def get_max_files(self) -> int | None:
        return self._max_files

    def get_max_file_size(self) -> int | None:
        return self._max_file_size

    def accepts_directories(self) -> bool:
        return self._accept_directories

    def is_case_sensitive(self) -> bool:
        return self._case_sensitive_extensions

    def reset_configuration(self) -> None:
        self._accepted_extensions.clear()
        self._max_files = None
        self._max_file_size = None
        self._accept_directories = False
        self._case_sensitive_extensions = False
        self._validation_callback = None
        self._filter_callback = None


class DragDropManager:
    """High-level manager for drag and drop functionality."""

    def __init__(self, parent: QObject | None = None):
        self.service = DragDropService(parent)
        self._widgets: set[QWidget] = set()

    def setup_audio_file_drop(self,
                             widget: QWidget,
                             max_files: int = 10,
                             max_file_size: int = 100 * 1024 * 1024,
    ) -> None:
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
    ) -> None:
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
    ) -> None:
        media_extensions = [
            ".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".wma",
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
    ) -> None:
        sound_extensions = [".mp3", ".wav"]
        self.service.configure(
            accepted_extensions=sound_extensions,
            max_files=1,
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
        self.service.disable_drag_drop(widget)
        self._widgets.discard(widget)

    def disable_all(self) -> None:
        for widget in self._widgets.copy():
            self.service.disable_drag_drop(widget)
        self._widgets.clear()

    def set_enabled(self, enabled: bool,
    ) -> None:
        self.service.set_enabled(enabled)

    def get_service(self) -> DragDropService:
        return self.service

    def get_managed_widgets(self) -> set[QWidget]:
        return self._widgets.copy()

