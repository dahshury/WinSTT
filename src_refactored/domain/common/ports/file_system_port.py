"""File System Port Interface.

This module defines the port interface for file system operations in the domain layer.
"""

from abc import ABC, abstractmethod


class IFileSystemPort(ABC):
    """Port interface for file system operations."""

    @abstractmethod
    def get_basename(self, file_path: str) -> str:
        """Get the base name of a file path.
        
        Args:
            file_path: The file path
            
        Returns:
            Base name of the file
        """
        ...

    @abstractmethod
    def split_extension(self, file_path: str) -> tuple[str, str]:
        """Split file path into base and extension.
        
        Args:
            file_path: The file path
            
        Returns:
            Tuple of (base_path, extension)
        """
        ...

    @abstractmethod
    def join_path(self, *parts: str) -> str:
        """Join path components.
        
        Args:
            *parts: Path components to join
            
        Returns:
            Joined path
        """
        ...

    @abstractmethod
    def get_absolute_path(self, path: str) -> str:
        """Get absolute path.
        
        Args:
            path: Relative or absolute path
            
        Returns:
            Absolute path
        """
        ...

    @abstractmethod
    def is_absolute_path(self, path: str) -> bool:
        """Check if path is absolute.
        
        Args:
            path: Path to check
            
        Returns:
            True if path is absolute
        """
        ...

    @abstractmethod
    def path_exists(self, path: str) -> bool:
        """Check if path exists.
        
        Args:
            path: Path to check
            
        Returns:
            True if path exists
        """
        ...

    @abstractmethod
    def is_file(self, path: str) -> bool:
        """Check if path is a file.
        
        Args:
            path: Path to check
            
        Returns:
            True if path is a file
        """
        ...

    @abstractmethod
    def is_directory(self, path: str) -> bool:
        """Check if path is a directory.
        
        Args:
            path: Path to check
            
        Returns:
            True if path is a directory
        """
        ...

    @abstractmethod
    def create_directory(self, path: str, parents: bool = True) -> bool:
        """Create directory.
        
        Args:
            path: Directory path to create
            parents: Whether to create parent directories
            
        Returns:
            True if directory was created successfully
        """
        ...

    @abstractmethod
    def remove_file(self, path: str) -> bool:
        """Remove a file.
        
        Args:
            path: File path to remove
            
        Returns:
            True if file was removed successfully
        """
        ...

    @abstractmethod
    def get_current_directory(self) -> str:
        """Get current working directory.
        
        Returns:
            Current working directory path
        """
        ...

    @abstractmethod
    def get_home_directory(self) -> str:
        """Get user home directory.
        
        Returns:
            User home directory path
        """
        ...

    @abstractmethod
    def get_temp_directory(self) -> str:
        """Get temporary directory.
        
        Returns:
            Temporary directory path
        """
        ...
