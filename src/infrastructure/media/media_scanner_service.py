"""Media scanner service for discovering media files.

This module provides infrastructure services for scanning directories
and discovering media files with progress tracking capabilities.
"""

import os
from collections.abc import Callable
from pathlib import Path


class MediaScannerService:
    """Service for scanning directories and discovering media files.
    
    This service provides infrastructure-only logic for media file discovery,
    without any UI or business logic dependencies.
    """

    def __init__(self,
                 supported_extensions: set[str] | None = None,
                 progress_callback: Callable[[str, float], None] | None = None):
        """Initialize the media scanner service.
        
        Args:
            supported_extensions: Set of supported file extensions (with dots)
            progress_callback: Optional callback for progress updates (message, percentage)
        """
        self.supported_extensions = supported_extensions or {
            ".mp3", ".wav",  # Audio
            ".mp4", ".avi", ".mkv", ".mov", ".flv", ".wmv",  # Video
        }
        self.progress_callback = progress_callback

    def scan_folder_for_media(self, folder_path: str,
    ) -> list[str]:
        """Recursively scan a folder for media files.
        
        Args:
            folder_path: Path to the folder to scan
            
        Returns:
            List of paths to discovered media files
        """
        media_files: list[str] = []

        try:
            folder_path_obj = Path(folder_path)

            if not folder_path_obj.exists() or not folder_path_obj.is_dir():
                if self.progress_callback:
                    self.progress_callback(f"Invalid folder path: {folder_path}", 0)
                return media_files

            if self.progress_callback:
                self.progress_callback(f"Scanning folder: {folder_path_obj.name}", 0)

            # First pass: count total files for progress tracking
            total_files = 0
            for root, _, files in os.walk(folder_path):
                total_files += len(files)

            if total_files == 0:
                if self.progress_callback:
                    self.progress_callback("No files found in folder", 100)
                return media_files

            # Second pass: scan files and check for media
            processed_files = 0

            for root, _, files in os.walk(folder_path):
                for file in files:
                    processed_files += 1
                    file_path = os.path.join(root, file)

                    # Update progress
                    if self.progress_callback and total_files > 0:
                        progress = (processed_files / total_files) * 100
                        relative_path = os.path.relpath(file_path, folder_path)
                        self.progress_callback(f"Scanning: {relative_path}", progress)

                    # Check if file is a supported media type
                    if self._is_supported_media_file(file_path):
                        media_files.append(file_path)

            if self.progress_callback:
                self.progress_callback(f"Found {len(media_files)} media files", 100)

        except (OSError, PermissionError) as e:
            if self.progress_callback:
                self.progress_callback(f"Error scanning folder: {e}", 0)

        return media_files

    def scan_multiple_folders(self, folder_paths: list[str]) -> list[str]:
        """Scan multiple folders for media files.
        
        Args:
            folder_paths: List of folder paths to scan
            
        Returns:
            List of paths to discovered media files from all folders
        """
        all_media_files = []
        total_folders = len(folder_paths)

        for i, folder_path in enumerate(folder_paths):
            if self.progress_callback:
                folder_progress = (i / total_folders) * 100 if total_folders > 0 else 0
                self.progress_callback(f"Scanning folder {i+1}/{total_folders}", folder_progress)

            media_files = self.scan_folder_for_media(folder_path)
            all_media_files.extend(media_files)

        if self.progress_callback:
            self.progress_callback(f"Total files found: {len(all_media_files)}", 100)

        return all_media_files

    def scan_files_in_directory(self, directory_path: str, recursive: bool = False) -> list[str]:
        """Scan files in a specific directory (optionally recursive).
        
        Args:
            directory_path: Path to the directory to scan
            recursive: Whether to scan subdirectories recursively
            
        Returns:
            List of paths to discovered media files
        """
        media_files: list[str] = []

        try:
            directory_path_obj = Path(directory_path)

            if not directory_path_obj.exists() or not directory_path_obj.is_dir():
                if self.progress_callback:
                    self.progress_callback(f"Invalid directory path: {directory_path}", 0)
                return media_files

            if recursive:
                return self.scan_folder_for_media(directory_path)

            # Non-recursive scan
            files = list(directory_path_obj.iterdir())
            total_files = len(files)

            if self.progress_callback:
                self.progress_callback(f"Scanning {total_files} files in directory", 0)

            for i, file_path in enumerate(files):
                if file_path.is_file():
                    if self.progress_callback and total_files > 0:
                        progress = ((i + 1) / total_files) * 100
                        self.progress_callback(f"Checking: {file_path.name}", progress)

                    if self._is_supported_media_file(str(file_path)):
                        media_files.append(str(file_path))

            if self.progress_callback:
                self.progress_callback(f"Found {len(media_files)} media files", 100)

        except (OSError, PermissionError) as e:
            if self.progress_callback:
                self.progress_callback(f"Error scanning directory: {e}", 0)

        return media_files

    def get_directory_stats(self, directory_path: str,
    ) -> dict:
        """Get statistics about a directory's media content.
        
        Args:
            directory_path: Path to the directory to analyze
            
        Returns:
            Dictionary with statistics about the directory
        """
        stats = {
            "total_files": 0,
            "media_files": 0,
            "audio_files": 0,
            "video_files": 0,
            "subdirectories": 0,
            "total_size_bytes": 0,
        }

        try:
            directory_path_obj = Path(directory_path)

            if not directory_path_obj.exists() or not directory_path_obj.is_dir():
                return stats

            for root, dirs, files in os.walk(directory_path):
                stats["subdirectories"] += len(dirs)

                for file in files:
                    file_path = os.path.join(root, file)
                    stats["total_files"] += 1

                    try:
                        stats["total_size_bytes"] += os.path.getsize(file_path)
                    except OSError:
                        pass  # Skip files we can't access

                    if self._is_supported_media_file(file_path):
                        stats["media_files"] += 1

                        ext = Path(file_path).suffix.lower()
                        if ext in {".mp3", ".wav"}:
                            stats["audio_files"] += 1
                        elif ext in {".mp4", ".avi", ".mkv", ".mov", ".flv", ".wmv"}:
                            stats["video_files"] += 1

        except (OSError, PermissionError):
            pass  # Return partial stats if there are permission issues

        return stats

    def _is_supported_media_file(self, file_path: str,
    ) -> bool:
        """Check if a file is a supported media type.
        
        Args:
            file_path: Path to the file to check
            
        Returns:
            True if the file is a supported media type, False otherwise
        """
        try:
            ext = Path(file_path).suffix.lower()
            return ext in self.supported_extensions
        except (OSError, ValueError):
            return False

    def add_supported_extension(self, extension: str,
    ) -> None:
        """Add a new supported file extension.
        
        Args:
            extension: File extension to add (should include the dot)
        """
        if not extension.startswith("."):
            extension = "." + extension
        self.supported_extensions.add(extension.lower())

    def remove_supported_extension(self, extension: str,
    ) -> None:
        """Remove a supported file extension.
        
        Args:
            extension: File extension to remove (should include the dot)
        """
        if not extension.startswith("."):
            extension = "." + extension
        self.supported_extensions.discard(extension.lower())

    def get_supported_extensions(self) -> set[str]:
        """Get the current set of supported file extensions.
        
        Returns:
            Set of supported file extensions
        """
        return self.supported_extensions.copy()