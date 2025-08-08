"""Icon path value object.

This module contains the IconPath value object for managing window icon paths.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from src_refactored.domain.common.result import Result
from src_refactored.domain.common.value_object import ValueObject


class IconSize(Enum):
    """Standard icon sizes for the application."""
    SMALL = "16x16"
    MEDIUM = "32x32"
    LARGE = "48x48"
    EXTRA_LARGE = "64x64"
    SYSTEM_TRAY = "16x16"
    TOOLBAR = "24x24"
    MENU = "16x16"
    DIALOG = "32x32"


class IconTheme(Enum):
    """Icon themes for different UI contexts."""
    LIGHT = "light"
    DARK = "dark"
    SYSTEM = "system"
    HIGH_CONTRAST = "high_contrast"
    COLORFUL = "colorful"


@dataclass(frozen=True)
class IconPath(ValueObject):
    """Icon path value object.
    
    Represents a file path to an icon with validation.
    """
    
    value: str

    SUPPORTED_EXTENSIONS = {".ico", ".png", ".jpg", ".jpeg", ".bmp", ".gif", ".svg"}

    def __post_init__(self):
        """Validate icon path after initialization."""
        if not self.value or not isinstance(self.value, str):
            msg = "Icon path must be a non-empty string"
            raise ValueError(msg)

        # Normalize path
        normalized_path = os.path.normpath(self.value.strip())

        # Validate path format
        if not self._is_valid_path_format(normalized_path):
            msg = f"Invalid icon path format: {normalized_path}"
            raise ValueError(msg)

        # Update the normalized path
        object.__setattr__(self, "value", normalized_path)

    @classmethod
    def from_string(cls, path: str,
    ) -> Result[IconPath]:
        """Create IconPath from string with validation.
        
        Args:
            path: The file path string
            
        Returns:
            Result containing IconPath or error
        """
        try:
            return Result.success(cls(value=path))
        except ValueError as e:
            return Result.failure(str(e))

    @classmethod
    def from_pathlib(cls, path: Path,
    ) -> Result[IconPath]:
        """Create IconPath from pathlib.Path.
        
        Args:
            path: The pathlib.Path object
            
        Returns:
            Result containing IconPath or error
        """
        try:
            return cls.from_string(str(path))
        except Exception as e:
            return Result.failure(f"Failed to create IconPath from Path: {e!s}")

    @classmethod
    def from_resource(cls, resource_path: str,
    ) -> Result[IconPath]:
        """Create IconPath from resource path.
        
        Args:
            resource_path: The resource path string
            
        Returns:
            Result containing IconPath or error
        """
        try:
            return cls.from_string(resource_path)
        except Exception as e:
            return Result.failure(f"Failed to create IconPath from resource: {e!s}")

    @classmethod
    def default(cls) -> IconPath:
        """Create default icon path.
        
        Returns:
            Default IconPath pointing to application icon
        """
        # Default to a common application icon path
        default_path = "assets/icons/app.ico"
        return cls(default_path)

    def exists(self) -> bool:
        """Check if the icon file exists.
        
        Returns:
            True if file exists, False otherwise
        """
        try:
            return os.path.isfile(self.value)
        except (OSError, TypeError):
            return False

    def is_absolute(self) -> bool:
        """Check if path is absolute.
        
        Returns:
            True if path is absolute, False otherwise
        """
        return os.path.isabs(self.value)

    def is_relative(self) -> bool:
        """Check if path is relative.
        
        Returns:
            True if path is relative, False otherwise
        """
        return not self.is_absolute()

    def get_extension(self) -> str:
        """Get file extension.
        
        Returns:
            File extension including the dot (e.g., '.ico')
        """
        return os.path.splitext(self.value)[1].lower()

    def get_filename(self) -> str:
        """Get filename without directory.
        
        Returns:
            Filename with extension
        """
        return os.path.basename(self.value)

    def get_filename_without_extension(self) -> str:
        """Get filename without extension.
        
        Returns:
            Filename without extension
        """
        return os.path.splitext(self.get_filename())[0]

    def get_directory(self) -> str:
        """Get directory path.
        
        Returns:
            Directory path containing the icon
        """
        return os.path.dirname(self.value)

    def to_absolute(self, base_path: str | None = None) -> Result[IconPath]:
        """Convert to absolute path.
        
        Args:
            base_path: Base path for relative paths (defaults to current working directory)
            
        Returns:
            Result containing absolute IconPath or error
        """
        try:
            if self.is_absolute():
                return Result.success(self)

            if base_path:
                absolute_path = os.path.join(base_path, self.value)
            else:
                absolute_path = os.path.abspath(self.value)

            return IconPath.from_string(absolute_path)
        except Exception as e:
            return Result.failure(f"Failed to convert to absolute path: {e!s}")

    def to_relative(self, base_path: str,
    ) -> Result[IconPath]:
        """Convert to relative path.
        
        Args:
            base_path: Base path to make relative to
            
        Returns:
            Result containing relative IconPath or error
        """
        try:
            if self.is_relative():
                return Result.success(self)

            relative_path = os.path.relpath(self.value, base_path)
            # Convert bytes to string if necessary
            if isinstance(relative_path, bytes):
                relative_path = relative_path.decode("utf-8")
            return IconPath.from_string(relative_path)
        except Exception as e:
            return Result.failure(f"Failed to convert to relative path: {e!s}")

    def validate_existence(self) -> Result[None]:
        """Validate that the icon file exists.
        
        Returns:
            Result indicating success or failure
        """
        if not self.exists():
            return Result.failure(f"Icon file does not exist: {self.value}")
        return Result.success(None)

    def validate_extension(self) -> Result[None]:
        """Validate that the file has a supported extension.
        
        Returns:
            Result indicating success or failure
        """
        extension = self.get_extension()
        if extension not in self.SUPPORTED_EXTENSIONS:
            supported = ", ".join(sorted(self.SUPPORTED_EXTENSIONS))
            return Result.failure(
                f"Unsupported icon extension '{extension}'. "
                f"Supported extensions: {supported}",
            )
        return Result.success(None)

    def validate_full(self) -> Result[None]:
        """Perform full validation (existence and extension).
        
        Returns:
            Result indicating success or failure
        """
        # Validate extension first
        ext_result = self.validate_extension()
        if not ext_result.is_success:
            return ext_result

        # Then validate existence
        return self.validate_existence()

    def _is_valid_path_format(self, path: str,
    ) -> bool:
        """Check if path format is valid.
        
        Args:
            path: Path to validate
            
        Returns:
            True if format is valid, False otherwise
        """
        try:
            # Check for invalid characters
            invalid_chars = {"<", ">", '"', "|", "?", "*"}
            if any(char in path for char in invalid_chars):
                return False

            # Check for empty components
            if "//" in path or "\\\\" in path:
                return False

            # Check path length (Windows limitation)
            if len(path) > 260:
                return False

            # Try to create Path object to validate
            Path(path)
            return True
        except (ValueError, OSError):
            return False

    def __str__(self) -> str:
        """String representation."""
        return self.value

    def __repr__(self) -> str:
        """Developer representation."""
        return f"IconPath('{self.value}')"