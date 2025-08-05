"""File dialog service for UI file operations.

This module provides infrastructure services for handling file dialogs
with customizable filters, validation, and path management.
"""

from collections.abc import Callable
from pathlib import Path

from PyQt6.QtCore import QObject, QStandardPaths, pyqtSignal
from PyQt6.QtWidgets import QFileDialog, QMessageBox, QWidget


class FileDialogResult:
    """Result container for file dialog operations."""

    def __init__(self,
                 success: bool,
                 files: list[str] | None = None,
                 selected_filter: str | None = None,
                 error_message: str | None = None):
        """Initialize file dialog result.
        
        Args:
            success: Whether the operation was successful
            files: List of selected file paths
            selected_filter: Selected file filter
            error_message: Error message if operation failed
        """
        self.success = success
        self.files = files or []
        self.selected_filter = selected_filter
        self.error_message = error_message

    @property
    def file(self) -> str | None:
        """Get the first selected file.
        
        Returns:
            First file path or None if no files selected
        """
        return self.files[0] if self.files else None

    @property
    def has_files(self) -> bool:
        """Check if any files were selected.
        
        Returns:
            True if files were selected, False otherwise
        """
        return bool(self.files)

    @property
    def file_count(self) -> int:
        """Get the number of selected files.
        
        Returns:
            Number of selected files
        """
        return len(self.files)


class FileDialogService(QObject):
    """Service for managing file dialog operations.
    
    This service provides infrastructure-only logic for file dialogs
    without any business logic dependencies.
    """

    # Signals for file dialog events
    files_selected = pyqtSignal(FileDialogResult)  # files selected
    dialog_cancelled = pyqtSignal()                # dialog cancelled
    validation_failed = pyqtSignal(str)            # validation failed

    def __init__(self, parent: QObject | None = None):
        """Initialize the file dialog service.
        
        Args:
            parent: Parent QObject
        """
        super().__init__(parent)

        # Default settings
        self._default_directory: str | None = None
        self._remember_last_directory: bool = True
        self._last_directory: str | None = None
        self._validation_callback: Callable[[list[str]], tuple[bool, str]] | None = None
        self._confirm_overwrite: bool = True

        # Common file filters
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
        """Configure file dialog behavior.
        
        Args:
            default_directory: Default directory to open dialogs in
            remember_last_directory: Whether to remember the last used directory
            confirm_overwrite: Whether to confirm file overwrites
        """
        self._default_directory = default_directory
        self._remember_last_directory = remember_last_directory
        self._confirm_overwrite = confirm_overwrite

    def set_validation_callback(self, callback: Callable[[list[str]], tuple[bool, str]]) -> None:
        """Set custom validation callback for selected files.
        
        Args:
            callback: Function that takes file list and returns (is_valid, error_message)
        """
        self._validation_callback = callback

    def open_single_file(self,
                        parent: QWidget | None = None,
                        title: str = "Open File",
                        filters: list[str] | None = None,
                        default_filter: str | None = None,
                        directory: str | None = None) -> FileDialogResult:
        """Open dialog to select a single file.
        
        Args:
            parent: Parent widget
            title: Dialog title
            filters: List of file filters
            default_filter: Default selected filter
            directory: Directory to open in
            
        Returns:
            FileDialogResult with selected file
        """
        try:
            # Determine directory
            start_dir = self._get_start_directory(directory)

            # Prepare filters
            filter_string = self._prepare_filters(filters or ["All Files (*)"])

            # Open dialog
            file_path, selected_filter = QFileDialog.getOpenFileName(
                parent=parent,
                caption=title,
                directory=start_dir,
                filter=filter_string,
                initialFilter=default_filter or "",
            )

            if file_path:
                # Update last directory
                self._update_last_directory(file_path)

                # Validate if callback is set
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
            error_msg = f"Error opening file dialog: {e!s}"
            return FileDialogResult(success=False, error_message=error_msg)

    def open_multiple_files(self,
                           parent: QWidget | None = None,
                           title: str = "Open Files",
                           filters: list[str] | None = None,
                           default_filter: str | None = None,
                           directory: str | None = None,
                           max_files: int | None = None) -> FileDialogResult:
        """Open dialog to select multiple files.
        
        Args:
            parent: Parent widget
            title: Dialog title
            filters: List of file filters
            default_filter: Default selected filter
            directory: Directory to open in
            max_files: Maximum number of files to select
            
        Returns:
            FileDialogResult with selected files
        """
        try:
            # Determine directory
            start_dir = self._get_start_directory(directory)

            # Prepare filters
            filter_string = self._prepare_filters(filters or ["All Files (*)"])

            # Open dialog
            file_paths, selected_filter = QFileDialog.getOpenFileNames(
                parent=parent,
                caption=title,
                directory=start_dir,
                filter=filter_string,
                initialFilter=default_filter or "",
            )

            if file_paths:
                # Check file count limit
                if max_files and len(file_paths) > max_files:
                    error_msg = f"Too many files selected. Maximum allowed: {max_files}"
                    self.validation_failed.emit(error_msg,
    )
                    return FileDialogResult(success=False, error_message=error_msg)

                # Update last directory
                self._update_last_directory(file_paths[0])

                # Validate if callback is set
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
            error_msg = f"Error opening file dialog: {e!s}"
            return FileDialogResult(success=False, error_message=error_msg)

    def save_file(self,
                 parent: QWidget | None = None,
                 title: str = "Save File",
                 filters: list[str] | None = None,
                 default_filter: str | None = None,
                 directory: str | None = None,
                 default_filename: str | None = None) -> FileDialogResult:
        """Open dialog to save a file.
        
        Args:
            parent: Parent widget
            title: Dialog title
            filters: List of file filters
            default_filter: Default selected filter
            directory: Directory to open in
            default_filename: Default filename
            
        Returns:
            FileDialogResult with save path
        """
        try:
            # Determine directory
            start_dir = self._get_start_directory(directory)
            if default_filename:
                start_dir = str(Path(start_dir) / default_filename)

            # Prepare filters
            filter_string = self._prepare_filters(filters or ["All Files (*)"],
    )

            # Open dialog
            file_path, selected_filter = QFileDialog.getSaveFileName(
                parent=parent,
                caption=title,
                directory=start_dir,
                filter=filter_string,
                initialFilter=default_filter or "",
            )

            if file_path:
                # Check for overwrite if enabled
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

                # Update last directory
                self._update_last_directory(file_path)

                # Validate if callback is set
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
            error_msg = f"Error opening save dialog: {e!s}"
            return FileDialogResult(success=False, error_message=error_msg)

    def select_directory(self,
                        parent: QWidget | None = None,
                        title: str = "Select Directory",
                        directory: str | None = None) -> FileDialogResult:
        """Open dialog to select a directory.
        
        Args:
            parent: Parent widget
            title: Dialog title
            directory: Directory to open in
            
        Returns:
            FileDialogResult with selected directory
        """
        try:
            # Determine directory
            start_dir = self._get_start_directory(directory)

            # Open dialog
            dir_path = QFileDialog.getExistingDirectory(
                parent=parent,
                caption=title,
                directory=start_dir,
                options=QFileDialog.Option.ShowDirsOnly,
            )

            if dir_path:
                # Update last directory
                self._update_last_directory(dir_path)

                result = FileDialogResult(success=True, files=[dir_path])
                self.files_selected.emit(result)
                return result
            self.dialog_cancelled.emit()
            return FileDialogResult(success=False)

        except Exception as e:
            error_msg = f"Error opening directory dialog: {e!s}"
            return FileDialogResult(success=False, error_message=error_msg)

    def _get_start_directory(self, directory: str | None) -> str:
        """Get the starting directory for dialogs.
        
        Args:
            directory: Requested directory
            
        Returns:
            Directory path to use
        """
        if directory and Path(directory).exists():
            return directory

        if self._remember_last_directory and self._last_directory:
            if Path(self._last_directory).exists():
                return self._last_directory

        if self._default_directory and Path(self._default_directory).exists():
            return self._default_directory

        # Fall back to standard locations
        return QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DocumentsLocation)

    def _update_last_directory(self, file_path: str,
    ) -> None:
        """Update the last used directory.
        
        Args:
            file_path: File or directory path
        """
        if self._remember_last_directory:
            path = Path(file_path)
            if path.is_file():
                self._last_directory = str(path.parent)
            else:
                self._last_directory = str(path,
    )

    def _prepare_filters(self, filters: list[str]) -> str:
        """Prepare filter string for QFileDialog.
        
        Args:
            filters: List of filter strings
            
        Returns:
            Combined filter string
        """
        return ";;" .join(filters)

    def get_audio_filters(self) -> list[str]:
        """Get predefined audio file filters.
        
        Returns:
            List of audio file filters
        """
        return self._audio_filters.copy()

    def get_video_filters(self) -> list[str]:
        """Get predefined video file filters.
        
        Returns:
            List of video file filters
        """
        return self._video_filters.copy()

    def get_media_filters(self) -> list[str]:
        """Get predefined media file filters.
        
        Returns:
            List of media file filters
        """
        return self._media_filters.copy()

    def get_text_filters(self) -> list[str]:
        """Get predefined text file filters.
        
        Returns:
            List of text file filters
        """
        return self._text_filters.copy()

    def set_default_directory(self, directory: str,
    ) -> None:
        """Set the default directory.
        
        Args:
            directory: Default directory path
        """
        self._default_directory = directory

    def get_default_directory(self) -> str | None:
        """Get the default directory.
        
        Returns:
            Default directory path or None
        """
        return self._default_directory

    def get_last_directory(self) -> str | None:
        """Get the last used directory.
        
        Returns:
            Last directory path or None
        """
        return self._last_directory

    def set_last_directory(self, directory: str,
    ) -> None:
        """Set the last used directory.
        
        Args:
            directory: Directory path
        """
        self._last_directory = directory

    def clear_last_directory(self) -> None:
        """Clear the last used directory."""
        self._last_directory = None

    def is_remember_last_directory_enabled(self) -> bool:
        """Check if remembering last directory is enabled.
        
        Returns:
            True if enabled, False otherwise
        """
        return self._remember_last_directory

    def is_confirm_overwrite_enabled(self) -> bool:
        """Check if confirm overwrite is enabled.
        
        Returns:
            True if enabled, False otherwise
        """
        return self._confirm_overwrite


class FileDialogManager:
    """High-level manager for file dialog functionality.
    
    Provides a simplified interface for common file dialog patterns.
    """

    def __init__(self, parent: QObject | None = None):
        """Initialize the file dialog manager.
        
        Args:
            parent: Parent QObject
        """
        self.service = FileDialogService(parent)

    def open_audio_file(self, parent: QWidget | None = None) -> FileDialogResult:
        """Open dialog to select an audio file.
        
        Args:
            parent: Parent widget
            
        Returns:
            FileDialogResult with selected audio file
        """
        return self.service.open_single_file(
            parent=parent,
            title="Open Audio File",
            filters=self.service.get_audio_filters(),
        )

    def open_audio_files(self, parent: QWidget | None = None, max_files: int = 10,
    ) -> FileDialogResult:
        """Open dialog to select multiple audio files.
        
        Args:
            parent: Parent widget
            max_files: Maximum number of files to select
            
        Returns:
            FileDialogResult with selected audio files
        """
        return self.service.open_multiple_files(
            parent=parent,
            title="Open Audio Files",
            filters=self.service.get_audio_filters(),
            max_files=max_files,
        )

    def open_video_file(self, parent: QWidget | None = None) -> FileDialogResult:
        """Open dialog to select a video file.
        
        Args:
            parent: Parent widget
            
        Returns:
            FileDialogResult with selected video file
        """
        return self.service.open_single_file(
            parent=parent,
            title="Open Video File",
            filters=self.service.get_video_filters(),
        )

    def open_media_files(self, parent: QWidget | None = None, max_files: int = 10,
    ) -> FileDialogResult:
        """Open dialog to select multiple media files.
        
        Args:
            parent: Parent widget
            max_files: Maximum number of files to select
            
        Returns:
            FileDialogResult with selected media files
        """
        return self.service.open_multiple_files(
            parent=parent,
            title="Open Media Files",
            filters=self.service.get_media_filters(),
            max_files=max_files,
        )

    def browse_sound_file(self, parent: QWidget | None = None) -> FileDialogResult:
        """Open dialog to select a sound file for recording notifications.
        
        This method provides specific functionality for selecting sound files
        used in recording notifications, with limited format support.
        
        Args:
            parent: Parent widget
            
        Returns:
            FileDialogResult with selected sound file
        """
        # Use limited audio formats for sound files (mp3, wav only)
        sound_filters = ["Audio files (*.mp3 *.wav)"]

        return self.service.open_single_file(
            parent=parent,
            title="Select Sound File",
            filters=sound_filters,
        )

    def save_text_file(self,
                      parent: QWidget | None = None,
                      default_filename: str = "output.txt",
    ) -> FileDialogResult:
        """Open dialog to save a text file.
        
        Args:
            parent: Parent widget
            default_filename: Default filename
            
        Returns:
            FileDialogResult with save path
        """
        return self.service.save_file(
            parent=parent,
            title="Save Text File",
            filters=self.service.get_text_filters(),
            default_filename=default_filename,
        )

    def save_transcription(self,
                          parent: QWidget | None = None,
                          default_filename: str = "transcription.txt") -> FileDialogResult:
        """Open dialog to save a transcription file.
        
        Args:
            parent: Parent widget
            default_filename: Default filename
            
        Returns:
            FileDialogResult with save path
        """
        transcription_filters = [
            "Text Files (*.txt)",
            "JSON Files (*.json)",
            "CSV Files (*.csv)",
            "All Files (*)",
        ]

        return self.service.save_file(
            parent=parent,
            title="Save Transcription",
            filters=transcription_filters,
            default_filename=default_filename,
        )

    def select_output_directory(self, parent: QWidget | None = None) -> FileDialogResult:
        """Open dialog to select an output directory.
        
        Args:
            parent: Parent widget
            
        Returns:
            FileDialogResult with selected directory
        """
        return self.service.select_directory(
            parent=parent,
            title="Select Output Directory",
        )

    def get_service(self) -> FileDialogService:
        """Get the underlying file dialog service.
        
        Returns:
            FileDialogService instance
        """
        return self.service