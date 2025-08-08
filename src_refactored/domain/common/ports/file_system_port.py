"""File System Port.

This module defines the port for file system operations
without direct dependency on os module implementations.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from src_refactored.domain.common.result import Result


@dataclass(frozen=True)
class FileInfo:
    """File information value object."""
    path: str
    size_bytes: int
    created_at: datetime
    modified_at: datetime
    is_file: bool
    is_directory: bool
    exists: bool
    permissions: str = ""
    metadata: dict[str, Any] | None = None

    @property
    def size_mb(self) -> float:
        """Get file size in megabytes."""
        return self.size_bytes / (1024 * 1024)

    @property
    def size_kb(self) -> float:
        """Get file size in kilobytes."""
        return self.size_bytes / 1024


@dataclass(frozen=True)
class DirectoryInfo:
    """Directory information value object."""
    path: str
    file_count: int
    subdirectory_count: int
    total_size_bytes: int
    created_at: datetime
    modified_at: datetime
    exists: bool


class FileSystemPort(ABC):
    """Port for file system operations."""

    @abstractmethod
    def file_exists(self, file_path: str) -> Result[bool]:
        """Check if a file exists.
        
        Args:
            file_path: Path to the file
            
        Returns:
            Result with boolean indicating if file exists
        """

    @abstractmethod
    def directory_exists(self, directory_path: str) -> Result[bool]:
        """Check if a directory exists.
        
        Args:
            directory_path: Path to the directory
            
        Returns:
            Result with boolean indicating if directory exists
        """

    @abstractmethod
    def get_file_info(self, file_path: str) -> Result[FileInfo]:
        """Get information about a file.
        
        Args:
            file_path: Path to the file
            
        Returns:
            Result with file information
        """

    @abstractmethod
    def get_directory_info(self, directory_path: str) -> Result[DirectoryInfo]:
        """Get information about a directory.
        
        Args:
            directory_path: Path to the directory
            
        Returns:
            Result with directory information
        """

    @abstractmethod
    def get_file_size(self, file_path: str) -> Result[int]:
        """Get file size in bytes.
        
        Args:
            file_path: Path to the file
            
        Returns:
            Result with file size in bytes
        """

    @abstractmethod
    def get_modification_time(self, file_path: str) -> Result[datetime]:
        """Get file modification time.
        
        Args:
            file_path: Path to the file
            
        Returns:
            Result with modification time
        """

    @abstractmethod
    def create_directory(self, directory_path: str, recursive: bool = True) -> Result[None]:
        """Create a directory.
        
        Args:
            directory_path: Path to create
            recursive: Create parent directories if needed
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def delete_file(self, file_path: str) -> Result[None]:
        """Delete a file.
        
        Args:
            file_path: Path to the file to delete
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def delete_directory(self, directory_path: str, recursive: bool = False) -> Result[None]:
        """Delete a directory.
        
        Args:
            directory_path: Path to the directory to delete
            recursive: Delete contents recursively
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def copy_file(self, source_path: str, destination_path: str) -> Result[None]:
        """Copy a file.
        
        Args:
            source_path: Source file path
            destination_path: Destination file path
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def move_file(self, source_path: str, destination_path: str) -> Result[None]:
        """Move/rename a file.
        
        Args:
            source_path: Source file path
            destination_path: Destination file path
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def list_directory(self, directory_path: str) -> Result[list[str]]:
        """List contents of a directory.
        
        Args:
            directory_path: Path to the directory
            
        Returns:
            Result with list of file and directory names
        """

    @abstractmethod
    def get_file_extension(self, file_path: str) -> Result[str]:
        """Get file extension.
        
        Args:
            file_path: Path to the file
            
        Returns:
            Result with file extension (including dot)
        """

    @abstractmethod
    def get_file_name(self, file_path: str) -> Result[str]:
        """Get file name without path.
        
        Args:
            file_path: Path to the file
            
        Returns:
            Result with file name
        """

    @abstractmethod
    def get_directory_name(self, file_path: str) -> Result[str]:
        """Get directory containing the file.
        
        Args:
            file_path: Path to the file
            
        Returns:
            Result with directory path
        """

    @abstractmethod
    def join_paths(self, *path_components: str) -> Result[str]:
        """Join path components into a single path.
        
        Args:
            *path_components: Path components to join
            
        Returns:
            Result with joined path
        """

    @abstractmethod
    def resolve_path(self, file_path: str) -> Result[str]:
        """Resolve relative path to absolute path.
        
        Args:
            file_path: Path to resolve
            
        Returns:
            Result with absolute path
        """

    @abstractmethod
    def is_absolute_path(self, file_path: str) -> Result[bool]:
        """Check if path is absolute.
        
        Args:
            file_path: Path to check
            
        Returns:
            Result with boolean indicating if path is absolute
        """

    @abstractmethod
    def validate_file_path(self, file_path: str) -> Result[bool]:
        """Validate if file path is valid for the filesystem.
        
        Args:
            file_path: Path to validate
            
        Returns:
            Result with boolean indicating if path is valid
        """

    @abstractmethod
    def get_basename(self, file_path: str) -> Result[str]:
        """Get base name of a file (filename without directory path).
        
        Args:
            file_path: Path to the file
            
        Returns:
            Result with base name
        """

    @abstractmethod
    def split_extension(self, file_path: str) -> Result[tuple[str, str]]:
        """Split file path into base name and extension.
        
        Args:
            file_path: Path to the file
            
        Returns:
            Result with tuple of (base_name, extension)
        """