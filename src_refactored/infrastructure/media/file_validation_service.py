"""File validation service for media files.

This module provides infrastructure services for validating media file types
and determining supported formats for audio and video processing.
"""

from collections.abc import Callable
from pathlib import Path


class FileValidationService:
    """Service for validating media file types and formats.
    
    This service provides infrastructure-only logic for file validation,
    without any UI or business logic dependencies.
    """

    # Supported file extensions
    AUDIO_EXTENSIONS = {".mp3", ".wav"}
    VIDEO_EXTENSIONS = {".mp4", ".avi", ".mkv", ".mov", ".flv", ".wmv"}

    def __init__(self, progress_callback: Callable[[str, float], None] | None = None):
        """Initialize the file validation service.
        
        Args:
            progress_callback: Optional callback for progress updates (message, percentage)
        """
        self.progress_callback = progress_callback

    def is_supported_media_file(self, file_path: str,
    ) -> bool:
        """Check if the file is a supported media type (audio or video).
        
        Args:
            file_path: Path to the file to validate
            
        Returns:
            True if the file is a supported media type, False otherwise
        """
        return self.is_audio_file(file_path) or self.is_video_file(file_path)

    def is_audio_file(self, file_path: str,
    ) -> bool:
        """Check if the file is an audio file.
        
        Args:
            file_path: Path to the file to validate
            
        Returns:
            True if the file is an audio file, False otherwise
        """
        ext = Path(file_path).suffix.lower()
        return ext in self.AUDIO_EXTENSIONS

    def is_video_file(self, file_path: str,
    ) -> bool:
        """Check if the file is a video file.
        
        Args:
            file_path: Path to the file to validate
            
        Returns:
            True if the file is a video file, False otherwise
        """
        ext = Path(file_path).suffix.lower()
        return ext in self.VIDEO_EXTENSIONS

    def validate_file_exists(self, file_path: str,
    ) -> bool:
        """Validate that a file exists and is accessible.
        
        Args:
            file_path: Path to the file to validate
            
        Returns:
            True if the file exists and is accessible, False otherwise
        """
        try:
            return Path(file_path).exists() and Path(file_path).is_file()
        except (OSError, ValueError):
            return False

    def get_file_extension(self, file_path: str,
    ) -> str:
        """Get the file extension in lowercase.
        
        Args:
            file_path: Path to the file
            
        Returns:
            File extension in lowercase (including the dot)
        """
        return Path(file_path).suffix.lower()

    def filter_supported_files(self, file_paths: list[str]) -> list[str]:
        """Filter a list of file paths to only include supported media files.
        
        Args:
            file_paths: List of file paths to filter
            
        Returns:
            List of file paths that are supported media files
        """
        supported_files = []
        total_files = len(file_paths)

        for i, file_path in enumerate(file_paths):
            if self.progress_callback:
                progress = (i / total_files,
    ) * 100 if total_files > 0 else 0
                self.progress_callback(f"Validating file {i+1}/{total_files}", progress)

            if self.validate_file_exists(file_path) and self.is_supported_media_file(file_path):
                supported_files.append(file_path)

        if self.progress_callback:
            self.progress_callback(f"Found {len(supported_files)} supported files", 100)

        return supported_files

    def get_supported_extensions(self) -> list[str]:
        """Get all supported file extensions.
        
        Returns:
            List of supported file extensions
        """
        return list(self.AUDIO_EXTENSIONS | self.VIDEO_EXTENSIONS)

    def get_audio_extensions(self) -> list[str]:
        """Get supported audio file extensions.
        
        Returns:
            List of supported audio file extensions
        """
        return list(self.AUDIO_EXTENSIONS)

    def get_video_extensions(self) -> list[str]:
        """Get supported video file extensions.
        
        Returns:
            List of supported video file extensions
        """
        return list(self.VIDEO_EXTENSIONS)