"""Icon path value object.

This module defines the IconPath value object for managing window icon paths.
"""

from dataclasses import dataclass
from typing import Final

from src.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class IconPath(ValueObject):
    """Value object representing a path to an icon file."""
    
    path: str
    
    def _get_equality_components(self) -> tuple[object, ...]:
        return (self.path,)
    
    @classmethod
    def from_string(cls, path: str) -> "IconPath":
        """Create IconPath from string path.
        
        Args:
            path: String path to icon file
            
        Returns:
            IconPath instance
        """
        return cls(path)
    
    # Pathlib usage is avoided in domain-facing API.
    
    def __post_init__(self) -> None:
        """Validate the icon path."""
        if not isinstance(self.path, str):
            msg = "Icon path must be a string"
            raise ValueError(msg)
        if not self.path.strip():
            msg = "Icon path cannot be empty"
            raise ValueError(msg)
    
    # Do not return platform-specific types from the domain.
    
    def get_filename(self) -> str:
        """Get the filename from the path.
        
        Returns:
            Filename with extension
        """
        # Pure string operation to avoid pathlib in domain
        value = self.path
        if "/" in value:
            return value.rsplit("/", 1)[-1]
        if "\\" in value:
            return value.rsplit("\\", 1)[-1]
        return value
    
    def get_extension(self) -> str:
        """Get the file extension.
        
        Returns:
            File extension (including the dot)
        """
        dot = self.path.rfind(".")
        return self.path[dot:] if dot != -1 else ""
    
    def is_relative(self) -> bool:
        """Check if this is a relative path.
        
        Returns:
            True if path is relative
        """
        # Simple heuristic; absolute resolution must be handled by infra
        p: Final[str] = self.path
        return not (p.startswith(("/", "\\")) or (len(p) > 1 and p[1] == ":"))
    
    def is_absolute(self) -> bool:
        """Check if this is an absolute path.
        
        Returns:
            True if path is absolute
        """
        p: Final[str] = self.path
        return (p.startswith(("/", "\\")) or (len(p) > 1 and p[1] == ":"))
    
    def resolve_relative_to(self, base_path: str) -> "IconPath":
        """Resolve this path relative to a base path.
        
        Args:
            base_path: Base path to resolve against
            
        Returns:
            New IconPath with resolved absolute path
        """
        if self.is_absolute():
            return self
        
        # Pure join; actual resolution belongs to infra
        sep = "/" if "/" in base_path or "/" in self.path else "\\"
        base = base_path.rstrip("/\\")
        return IconPath(f"{base}{sep}{self.path}")
    
    def with_extension(self, new_extension: str) -> "IconPath":
        """Create a new IconPath with a different extension.
        
        Args:
            new_extension: New file extension (with or without dot)
            
        Returns:
            New IconPath with updated extension
        """
        if not new_extension.startswith("."):
            new_extension = "." + new_extension
            
        # Replace existing extension using string ops
        base = self.path
        dot = base.rfind(".")
        if dot != -1:
            base = base[:dot]
        return IconPath(f"{base}{new_extension}")
    
    def is_supported_format(self) -> bool:
        """Check if this icon format is commonly supported.
        
        Returns:
            True if format is commonly supported (.ico, .png, .jpg, .gif, .bmp)
        """
        extension = self.get_extension().lower()
        supported = {".ico", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg"}
        return extension in supported


# Common icon paths
DEFAULT_ICON = IconPath("default.ico")
APP_ICON = IconPath("app.ico")
WINDOW_ICON = IconPath("window.png")
