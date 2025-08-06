"""Tray icon path value object for system integration domain."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TrayIconPath:
    """Value object representing a tray icon file path."""

    path: str

    def __post_init__(self):
        """Validate tray icon path."""
        if not self.path or not self.path.strip():
            msg = "Tray icon path cannot be empty"
            raise ValueError(msg)

        # Validate file extension
        valid_extensions = {".png", ".ico", ".jpg", ".jpeg", ".bmp", ".gif", ".svg"}
        path_obj = Path(self.path)

        if path_obj.suffix.lower() not in valid_extensions:
            msg = (
                f"Invalid tray icon file extension: {path_obj.suffix}. "
                f"Supported extensions: {', '.join(sorted(valid_extensions))}"
            )
            raise ValueError(
                msg,
            )

    @classmethod
    def from_resource(cls, resource_path: str,
    ) -> TrayIconPath:
        """Create tray icon path from resource path."""
        if not resource_path:
            msg = "Resource path cannot be empty"
            raise ValueError(msg)

        return cls(path=resource_path,
    )

    @classmethod
    def from_absolute_path(cls, absolute_path: str,
    ) -> TrayIconPath:
        """Create tray icon path from absolute file path."""
        if not absolute_path:
            msg = "Absolute path cannot be empty"
            raise ValueError(msg)

        path_obj = Path(absolute_path)
        if not path_obj.is_absolute():
            msg = f"Path must be absolute: {absolute_path}"
            raise ValueError(msg)

        return cls(path=str(path_obj),
    )

    @classmethod
    def from_relative_path(cls, relative_path: str, base_dir: str | None = None) -> TrayIconPath:
        """Create tray icon path from relative path."""
        if not relative_path:
            msg = "Relative path cannot be empty"
            raise ValueError(msg)

        full_path = Path(base_dir) / relative_path if base_dir else Path.cwd() / relative_path

        return cls(path=str(full_path.resolve()))

    def exists(self) -> bool:
        """Check if the tray icon file exists."""
        try:
            return Path(self.path).exists()
        except (OSError, ValueError):
            return False

    def is_absolute(self) -> bool:
        """Check if the path is absolute."""
        try:
            return Path(self.path).is_absolute()
        except (OSError, ValueError):
            return False

    def get_filename(self) -> str:
        """Get the filename from the path."""
        return Path(self.path).name

    def get_extension(self) -> str:
        """Get the file extension."""
        return Path(self.path).suffix.lower()

    def get_directory(self) -> str:
        """Get the directory containing the icon file."""
        return str(Path(self.path).parent)

    def get_size_bytes(self) -> int | None:
        """Get file size in bytes, None if file doesn't exist."""
        try:
            path_obj = Path(self.path)
            if path_obj.exists():
                return path_obj.stat().st_size
            return None
        except (OSError, ValueError):
            return None

    def is_supported_format(self) -> bool:
        """Check if the icon format is supported by most tray systems."""
        # ICO and PNG are most widely supported
        preferred_formats = {".ico", ".png"}
        return self.get_extension() in preferred_formats

    def to_uri(self) -> str:
        """Convert path to file URI."""
        path_obj = Path(self.path)
        return path_obj.as_uri()

    def resolve(self) -> TrayIconPath:
        """Resolve the path to absolute form."""
        try:
            resolved_path = Path(self.path).resolve()
            return TrayIconPath(path=str(resolved_path))
        except (OSError, ValueError) as e:
            msg = f"Cannot resolve path '{self.path}': {e}"
            raise ValueError(msg)

    def with_suffix(self, suffix: str,
    ) -> TrayIconPath:
        """Create new TrayIconPath with different file extension."""
        if not suffix.startswith("."):
            suffix = "." + suffix

        path_obj = Path(self.path)
        new_path = path_obj.with_suffix(suffix)
        return TrayIconPath(path=str(new_path))

    def with_name(self, name: str,
    ) -> TrayIconPath:
        """Create new TrayIconPath with different filename."""
        path_obj = Path(self.path)
        new_path = path_obj.with_name(name)
        return TrayIconPath(path=str(new_path))

    def relative_to(self, base_path: str,
    ) -> str:
        """Get path relative to base path."""
        try:
            path_obj = Path(self.path)
            base_obj = Path(base_path)
            return str(path_obj.relative_to(base_obj))
        except (OSError, ValueError) as e:
            msg = f"Cannot make path relative to '{base_path}': {e}"
            raise ValueError(msg)

    def validate_accessibility(self) -> bool:
        """Validate that the icon file is accessible for reading."""
        try:
            path_obj = Path(self.path)

            # Check if file exists
            if not path_obj.exists():
                return False

            # Check if it's a file (not directory)
            if not path_obj.is_file():
                return False

            # Check read permissions
            return os.access(self.path, os.R_OK)

        except (OSError, ValueError):
            return False

    def get_validation_errors(self) -> list[str]:
        """Get list of validation errors for the icon path."""
        errors = []

        try:
            path_obj = Path(self.path)

            # Check if path is empty
            if not self.path.strip():
                errors.append("Path cannot be empty")
                return errors

            # Check file extension
            valid_extensions = {".png", ".ico", ".jpg", ".jpeg", ".bmp", ".gif", ".svg"}
            if path_obj.suffix.lower() not in valid_extensions:
                errors.append(f"Unsupported file extension: {path_obj.suffix}")

            # Check if file exists
            if not path_obj.exists():
                errors.append(f"File does not exist: {self.path}")
            elif not path_obj.is_file():
                errors.append(f"Path is not a file: {self.path}")
            elif not os.access(self.path, os.R_OK):
                errors.append(f"File is not readable: {self.path}")

            # Check file size (warn if too large for tray icon)
            size = self.get_size_bytes()
            if size and size > 1024 * 1024:  # 1MB
                errors.append(f"File size is large for tray icon: {size} bytes")

        except (OSError, ValueError) as e:
            errors.append(f"Path validation error: {e}")

        return errors

    def __str__(self) -> str:
        """String representation of the tray icon path."""
        return self.path

    def __repr__(self) -> str:
        """Detailed string representation."""
        return f"TrayIconPath(path='{self.path}')"