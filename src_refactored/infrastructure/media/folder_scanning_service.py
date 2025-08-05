"""Folder scanning service for media file discovery."""

import os
from collections.abc import Callable
from pathlib import Path


class FolderScanningError(Exception):
    """Exception raised for folder scanning errors."""


class FolderScanningService:
    """Service for scanning folders and discovering media files."""

    def __init__(self, progress_callback: Callable[[str, float], None] | None = None):
        """Initialize the folder scanning service.
        
        Args:
            progress_callback: Optional callback for progress updates (message, percentage)
        """
        self.progress_callback = progress_callback

    def scan_folder_for_media(self, folder_path: str, supported_extensions: set[str]) -> list[str]:
        """Recursively scan a folder for media files.
        
        Args:
            folder_path: Path to the folder to scan
            supported_extensions: Set of supported file extensions (e.g., {'.mp3', '.wav'})
            
        Returns:
            List of media file paths found in the folder
            
        Raises:
            FolderScanningError: If folder scanning fails
        """
        try:
            if not os.path.exists(folder_path):
                msg = f"Folder does not exist: {folder_path}"
                raise FolderScanningError(msg)

            if not os.path.isdir(folder_path):
                msg = f"Path is not a directory: {folder_path}"
                raise FolderScanningError(msg)

            media_files = []

            for root, _, files in os.walk(folder_path):
                for file in files:
                    file_path = os.path.join(root, file)
                    if self._is_supported_file(file_path, supported_extensions):
                        media_files.append(file_path)

            return media_files

        except OSError as e:
            msg = f"Error accessing folder {folder_path}: {e}"
            raise FolderScanningError(msg)
        except Exception as e:
            msg = f"Unexpected error scanning folder: {e}"
            raise FolderScanningError(msg,
    )

    def scan_folder_with_progress(
    self,
    folder_path: str,
    supported_extensions: set[str]) -> list[str]:
        """Scan folder with progress reporting.
        
        Args:
            folder_path: Path to the folder to scan
            supported_extensions: Set of supported file extensions
            
        Returns:
            List of media file paths found in the folder
        """
        try:
            if self.progress_callback:
                self.progress_callback(f"Scanning folder: {os.path.basename(folder_path)}", 0)

            # First pass: count total files for progress calculation
            total_files = sum(len(files) for _, _, files in os.walk(folder_path))

            if total_files == 0:
                if self.progress_callback:
                    self.progress_callback("No files found in folder", 100)
                return []

            media_files = []
            processed_files = 0

            for root, _, files in os.walk(folder_path):
                for file in files:
                    file_path = os.path.join(root, file)

                    if self._is_supported_file(file_path, supported_extensions):
                        media_files.append(file_path)

                    processed_files += 1

if self.progress_callback and processed_files % 10 = (
    = 0:  # Update every 10 files)
                        progress = (processed_files / total_files) * 100
                        self.progress_callback(
                            f"Scanning... Found {len(media_files)} media files",
                            progress,
                        )

            if self.progress_callback:
                self.progress_callback(
                    f"Scan complete: Found {len(media_files)} media files",
                    100,
                )

            return media_files

        except Exception as e:
            if self.progress_callback:
                self.progress_callback(f"Scan failed: {e}", 100)
            msg = f"Error scanning folder with progress: {e}"
            raise FolderScanningError(msg)

    def scan_multiple_folders(
    self,
    folder_paths: list[str],
    supported_extensions: set[str]) -> list[str]:
        """Scan multiple folders for media files.
        
        Args:
            folder_paths: List of folder paths to scan
            supported_extensions: Set of supported file extensions
            
        Returns:
            Combined list of media file paths from all folders
        """
        all_media_files = []
        total_folders = len(folder_paths)

        for i, folder_path in enumerate(folder_paths):
            try:
                if self.progress_callback:
                    folder_progress = (i / total_folders) * 100 if total_folders > 0 else 0
                    self.progress_callback(
                        f"Scanning folder {i+1}/{total_folders}: {os.path.basename(folder_path,
    )}",
                        folder_progress,
                    )

                folder_files = self.scan_folder_for_media(folder_path, supported_extensions)
                all_media_files.extend(folder_files)

            except FolderScanningError as e:
                if self.progress_callback:
                    self.progress_callback(f"Error scanning {folder_path}: {e}", 0)
                continue

        if self.progress_callback:
            self.progress_callback(
                f"Scan complete: Found {len(all_media_files)} total media files",
                100,
            )

        return all_media_files

    def get_folder_info(self, folder_path: str,
    ) -> dict:
        """Get information about a folder.
        
        Args:
            folder_path: Path to the folder
            
        Returns:
            Dictionary with folder information
        """
        try:
            if not os.path.exists(folder_path):
                return {"exists": False, "error": "Folder does not exist"}

            if not os.path.isdir(folder_path):
                return {"exists": False, "error": "Path is not a directory"}

            # Count files and subdirectories
            total_files = 0
            total_dirs = 0

            for _root, dirs, files in os.walk(folder_path):
                total_files += len(files)
                total_dirs += len(dirs)

            return {
                "exists": True,
                "path": folder_path,
                "total_files": total_files,
                "total_directories": total_dirs,
                "readable": os.access(folder_path, os.R_OK),
            }

        except Exception as e:
            return {"exists": False, "error": str(e)}

    def _is_supported_file(self, file_path: str, supported_extensions: set[str]) -> bool:
        """Check if a file has a supported extension.
        
        Args:
            file_path: Path to the file
            supported_extensions: Set of supported extensions
            
        Returns:
            True if file is supported, False otherwise
        """
        ext = Path(file_path).suffix.lower()
        return ext in supported_extensions


class FolderScanningManager:
    """High-level manager for folder scanning operations."""

    def __init__(self):
        self._service = FolderScanningService()

    def scan_folder_for_media(self, folder_path: str, supported_extensions: set[str]) -> list[str]:
        """Scan folder for media files with error handling.
        
        Args:
            folder_path: Path to the folder to scan
            supported_extensions: Set of supported file extensions
            
        Returns:
            List of media file paths, empty list if scanning fails
        """
        try:
            return self._service.scan_folder_for_media(folder_path, supported_extensions)
        except FolderScanningError:
            return []

    def scan_with_progress(self, folder_path: str, supported_extensions: set[str],
                          progress_callback: Callable[[str, float], None]) -> list[str]:
        """Scan folder with progress reporting.
        
        Args:
            folder_path: Path to the folder to scan
            supported_extensions: Set of supported file extensions
            progress_callback: Callback for progress updates
            
        Returns:
            List of media file paths
        """
        service = FolderScanningService(progress_callback)
        try:
            return service.scan_folder_with_progress(folder_path, supported_extensions)
        except FolderScanningError:
            return []

    def validate_folder(self, folder_path: str,
    ) -> bool:
        """Validate that a folder exists and is accessible.
        
        Args:
            folder_path: Path to the folder
            
        Returns:
            True if folder is valid and accessible
        """
        info = self._service.get_folder_info(folder_path)
        return info.get("exists", False) and info.get("readable", False)