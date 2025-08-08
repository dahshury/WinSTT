"""File dialog service for UI file operations (Presentation)."""

from collections.abc import Callable
from pathlib import Path

from PyQt6.QtCore import QObject, QStandardPaths, pyqtSignal
from PyQt6.QtWidgets import QFileDialog, QMessageBox, QWidget


class FileDialogResult:
    def __init__(self,
                 success: bool,
                 files: list[str] | None = None,
                 selected_filter: str | None = None,
                 error_message: str | None = None):
        self.success = success
        self.files = files or []
        self.selected_filter = selected_filter
        self.error_message = error_message

    @property
    def file(self) -> str | None:
        return self.files[0] if self.files else None

    @property
    def has_files(self) -> bool:
        return bool(self.files)

    @property
    def file_count(self) -> int:
        return len(self.files)


class FileDialogService(QObject):
    files_selected = pyqtSignal(FileDialogResult)
    dialog_cancelled = pyqtSignal()
    validation_failed = pyqtSignal(str)

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self._default_directory: str | None = None
        self._remember_last_directory: bool = True
        self._last_directory: str | None = None
        self._validation_callback: Callable[[list[str]], tuple[bool, str]] | None = None
        self._confirm_overwrite: bool = True
        self._audio_filters = [
            "Audio Files (*.mp3 *.wav *.flac *.m4a *.aac *.ogg *.wma)",
            "MP3 Files (*.mp3)",
            "WAV Files (*.wav)",
            "FLAC Files (*.flac)",
            "All Files (*)",
        ]
        self._video_filters = [
            "Video Files (*.mp4 *.avi *.mkv *.mov *.wmv *.flv *.webm)",
            "MP4 Files (*.mp4)",
            "AVI Files (*.avi)",
            "MKV Files (*.mkv)",
            "All Files (*)",
        ]
        self._media_filters = [
            "Media Files (*.mp3 *.wav *.flac *.m4a *.aac *.ogg *.wma *.mp4 *.avi *.mkv *.mov *.wmv *.flv *.webm)",
            "Audio Files (*.mp3 *.wav *.flac *.m4a *.aac *.ogg *.wma)",
            "Video Files (*.mp4 *.avi *.mkv *.mov *.wmv *.flv *.webm)",
            "All Files (*)",
        ]
        self._text_filters = [
            "Text Files (*.txt *.log)",
            "JSON Files (*.json)",
            "CSV Files (*.csv)",
            "All Files (*)",
        ]

    def configure(self,
                 default_directory: str | None = None,
                 remember_last_directory: bool = True,
                 confirm_overwrite: bool = True,
    ) -> None:
        self._default_directory = default_directory
        self._remember_last_directory = remember_last_directory
        self._confirm_overwrite = confirm_overwrite

    def set_validation_callback(self, callback: Callable[[list[str]], tuple[bool, str]]) -> None:
        self._validation_callback = callback

    def open_single_file(self,
                        parent: QWidget | None = None,
                        title: str = "Open File",
                        filters: list[str] | None = None,
                        default_filter: str | None = None,
                        directory: str | None = None) -> FileDialogResult:
        try:
            start_dir = self._get_start_directory(directory)
            filter_string = self._prepare_filters(filters or ["All Files (*)"])
            file_path, selected_filter = QFileDialog.getOpenFileName(
                parent=parent,
                caption=title,
                directory=start_dir,
                filter=filter_string,
                initialFilter=default_filter or "",
            )
            if file_path:
                self._update_last_directory(file_path)
                if self._validation_callback:
                    is_valid, error_msg = self._validation_callback([file_path])
                    if not is_valid:
                        self.validation_failed.emit(error_msg)
                        return FileDialogResult(success=False, error_message=error_msg)
                result = FileDialogResult(success=True, files=[file_path], selected_filter=selected_filter)
                self.files_selected.emit(result)
                return result
            self.dialog_cancelled.emit()
            return FileDialogResult(success=False)
        except Exception as e:
            return FileDialogResult(success=False, error_message=f"Error opening file dialog: {e!s}")

    def open_multiple_files(self,
                           parent: QWidget | None = None,
                           title: str = "Open Files",
                           filters: list[str] | None = None,
                           default_filter: str | None = None,
                           directory: str | None = None,
                           max_files: int | None = None) -> FileDialogResult:
        try:
            start_dir = self._get_start_directory(directory)
            filter_string = self._prepare_filters(filters or ["All Files (*)"])
            file_paths, selected_filter = QFileDialog.getOpenFileNames(
                parent=parent,
                caption=title,
                directory=start_dir,
                filter=filter_string,
                initialFilter=default_filter or "",
            )
            if file_paths:
                if max_files and len(file_paths) > max_files:
                    error_msg = f"Too many files selected. Maximum allowed: {max_files}"
                    self.validation_failed.emit(error_msg)
                    return FileDialogResult(success=False, error_message=error_msg)
                self._update_last_directory(file_paths[0])
                if self._validation_callback:
                    is_valid, error_msg = self._validation_callback(file_paths)
                    if not is_valid:
                        self.validation_failed.emit(error_msg)
                        return FileDialogResult(success=False, error_message=error_msg)
                result = FileDialogResult(success=True, files=file_paths, selected_filter=selected_filter)
                self.files_selected.emit(result)
                return result
            self.dialog_cancelled.emit()
            return FileDialogResult(success=False)
        except Exception as e:
            return FileDialogResult(success=False, error_message=f"Error opening file dialog: {e!s}")

    def save_file(self,
                 parent: QWidget | None = None,
                 title: str = "Save File",
                 filters: list[str] | None = None,
                 default_filter: str | None = None,
                 directory: str | None = None,
                 default_filename: str | None = None) -> FileDialogResult:
        try:
            start_dir = self._get_start_directory(directory)
            if default_filename:
                start_dir = str(Path(start_dir) / default_filename)
            filter_string = self._prepare_filters(filters or ["All Files (*)"])
            file_path, selected_filter = QFileDialog.getSaveFileName(
                parent=parent,
                caption=title,
                directory=start_dir,
                filter=filter_string,
                initialFilter=default_filter or "",
            )
            if file_path:
                if self._confirm_overwrite and Path(file_path).exists():
                    reply = QMessageBox.question(
                        parent,
                        "Confirm Overwrite",
                        f"The file '{Path(file_path).name}' already exists.\nDo you want to overwrite it?",
                        QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                        QMessageBox.StandardButton.No,
                    )
                    if reply != QMessageBox.StandardButton.Yes:
                        return FileDialogResult(success=False)
                self._update_last_directory(file_path)
                if self._validation_callback:
                    is_valid, error_msg = self._validation_callback([file_path])
                    if not is_valid:
                        self.validation_failed.emit(error_msg)
                        return FileDialogResult(success=False, error_message=error_msg)
                result = FileDialogResult(success=True, files=[file_path], selected_filter=selected_filter)
                self.files_selected.emit(result)
                return result
            self.dialog_cancelled.emit()
            return FileDialogResult(success=False)
        except Exception as e:
            return FileDialogResult(success=False, error_message=f"Error opening save dialog: {e!s}")

    def select_directory(self,
                        parent: QWidget | None = None,
                        title: str = "Select Directory",
                        directory: str | None = None) -> FileDialogResult:
        try:
            start_dir = self._get_start_directory(directory)
            dir_path = QFileDialog.getExistingDirectory(
                parent=parent,
                caption=title,
                directory=start_dir,
                options=QFileDialog.Option.ShowDirsOnly,
            )
            if dir_path:
                self._update_last_directory(dir_path)
                result = FileDialogResult(success=True, files=[dir_path])
                self.files_selected.emit(result)
                return result
            self.dialog_cancelled.emit()
            return FileDialogResult(success=False)
        except Exception as e:
            return FileDialogResult(success=False, error_message=f"Error opening directory dialog: {e!s}")

    def _get_start_directory(self, directory: str | None) -> str:
        if directory and Path(directory).exists():
            return directory
        if self._remember_last_directory and self._last_directory:
            if Path(self._last_directory).exists():
                return self._last_directory
        if self._default_directory and Path(self._default_directory).exists():
            return self._default_directory
        return QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DocumentsLocation)

    def _update_last_directory(self, file_path: str,
    ) -> None:
        if self._remember_last_directory:
            path = Path(file_path)
            if path.is_file():
                self._last_directory = str(path.parent)
            else:
                self._last_directory = str(path)

    def _prepare_filters(self, filters: list[str]) -> str:
        return ";;".join(filters)

    def get_audio_filters(self) -> list[str]:
        return self._audio_filters.copy()

    def get_video_filters(self) -> list[str]:
        return self._video_filters.copy()

    def get_media_filters(self) -> list[str]:
        return self._media_filters.copy()

    def get_text_filters(self) -> list[str]:
        return self._text_filters.copy()

    def set_default_directory(self, directory: str,
    ) -> None:
        self._default_directory = directory

    def get_default_directory(self) -> str | None:
        return self._default_directory

    def get_last_directory(self) -> str | None:
        return self._last_directory

    def set_last_directory(self, directory: str,
    ) -> None:
        self._last_directory = directory

    def clear_last_directory(self) -> None:
        self._last_directory = None

