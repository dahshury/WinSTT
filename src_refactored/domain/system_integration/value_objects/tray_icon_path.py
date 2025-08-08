"""Tray icon path value object for system integration domain."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from src_refactored.domain.common.ports.file_system_port import FileSystemPort


@dataclass(frozen=True)
class TrayIconPath:
    """Value object representing a tray icon file path."""

    path: str

    def __post_init__(self) -> None:
        """Validate tray icon path."""
        if not self.path or not self.path.strip():
            msg = "Tray icon path cannot be empty"
            raise ValueError(msg)

        # Validate file extension using domain logic
        valid_extensions = {".png", ".ico", ".jpg", ".jpeg", ".bmp", ".gif", ".svg"}
        
        # Extract extension using string operations
        extension = "." + self.path.split(".")[-1].lower() if "." in self.path else ""

        if extension not in valid_extensions:
            msg = (
                f"Invalid tray icon file extension: {extension}. "
                f"Supported extensions: {', '.join(sorted(valid_extensions))}"
            )
            raise ValueError(msg)

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

        # Validate absolute path using string heuristics only
        p: Final[str] = absolute_path
        is_abs = p.startswith(("/", "\\")) or (len(p) > 1 and p[1] == ":")
        if not is_abs:
            msg = f"Path must be absolute: {absolute_path}"
            raise ValueError(msg)

        return cls(path=p)

    @classmethod
    def from_relative_path(cls, relative_path: str, base_dir: str | None = None) -> TrayIconPath:
        """Create tray icon path from relative path."""
        if not relative_path:
            msg = "Relative path cannot be empty"
            raise ValueError(msg)

        # Avoid using current working directory in domain; just join
        if base_dir:
            sep = "/" if "/" in base_dir or "/" in relative_path else "\\"
            base = base_dir.rstrip("/\\")
            return cls(path=f"{base}{sep}{relative_path}")
        # Without a base, keep relative as-is; infra can resolve
        return cls(path=relative_path)

    def exists(self, file_system_port: FileSystemPort) -> bool:
        """Check if the tray icon file exists."""
        try:
            exists_result = file_system_port.file_exists(self.path)
            return exists_result.is_success and bool(exists_result.value)
        except Exception:
            return False

    def is_absolute(self, file_system_port: FileSystemPort) -> bool:
        """Check if the path is absolute."""
        try:
            absolute_result = file_system_port.is_absolute_path(self.path)
            return absolute_result.is_success and bool(absolute_result.value)
        except Exception:
            return False

    def get_filename(self) -> str:
        """Get the filename from the path."""
        # Extract filename using string operations
        if "/" in self.path:
            return self.path.split("/")[-1]
        if "\\" in self.path:
            return self.path.split("\\")[-1]
        return self.path

    def get_extension(self) -> str:
        """Get the file extension."""
        if "." in self.path:
            return "." + self.path.split(".")[-1].lower()
        return ""

    def get_directory(self) -> str:
        """Get the directory containing the icon file."""
        # Extract directory using string operations
        if "/" in self.path:
            return "/".join(self.path.split("/")[:-1])
        if "\\" in self.path:
            return "\\".join(self.path.split("\\")[:-1])
        return ""

    def get_size_bytes(self, file_system_port: FileSystemPort) -> int | None:
        """Get file size in bytes, None if file doesn't exist."""
        try:
            size_result = file_system_port.get_file_size(self.path)
            return size_result.value if size_result.is_success else None
        except Exception:
            return None

    def is_supported_format(self) -> bool:
        """Check if the icon format is supported by most tray systems."""
        # ICO and PNG are most widely supported
        preferred_formats = {".ico", ".png"}
        return self.get_extension() in preferred_formats

    def to_uri(self) -> str:
        """Convert path to file URI."""
        # Convert path to URI should be handled by infra; provide simple fallback
        p_original: Final[str] = self.path.replace("\\", "/")
        p = p_original
        if p.startswith("/") or (len(p) > 1 and p[1] == ":"):
            # naive file uri
            if ":" in p and not p.startswith("/"):
                # Avoid reassigning a Final name by using a new variable
                p = "/" + p
            return f"file://{p}"
        return f"file:///{p}"

    def resolve(self) -> TrayIconPath:
        """Resolve the path to absolute form."""
        # Domain should not resolve paths; return self
        return TrayIconPath(path=self.path)

    def with_suffix(self, suffix: str,
    ) -> TrayIconPath:
        """Create new TrayIconPath with different file extension."""
        if not suffix.startswith("."):
            suffix = "." + suffix

        base = self.path
        dot = base.rfind(".")
        if dot != -1:
            base = base[:dot]
        return TrayIconPath(path=f"{base}{suffix}")

    def with_name(self, name: str,
    ) -> TrayIconPath:
        """Create new TrayIconPath with different filename."""
        # Replace final segment name using string ops
        parts = self.path.replace("\\", "/").split("/")
        if not parts:
            return TrayIconPath(path=name)
        parts[-1] = name
        return TrayIconPath(path="/".join(parts))

    def relative_to(self, base_path: str,
    ) -> str:
        """Get path relative to base path."""
        # Simple relative computation using strings (best-effort); infra should handle robustly
        path_norm = self.path.replace("\\", "/")
        base_norm = base_path.replace("\\", "/").rstrip("/")
        if path_norm.startswith(base_norm + "/"):
            return path_norm[len(base_norm) + 1 :]
        return path_norm

    def validate_accessibility(self, file_system_port: FileSystemPort) -> bool:
        """Validate that the icon file is accessible for reading."""
        try:
            # Check if file exists
            exists_result = file_system_port.file_exists(self.path)
            if not exists_result.is_success or not exists_result.value:
                return False

            # Get file info to check if it's a file
            file_info_result = file_system_port.get_file_info(self.path)
            if not file_info_result.is_success:
                return False
            
            file_info = file_info_result.value
            if file_info is None:
                return False
            return file_info.is_file and file_info.exists

        except Exception:
            return False

    def get_validation_errors(self, file_system_port: FileSystemPort) -> list[str]:
        """Get list of validation errors for the icon path."""
        errors = []

        try:
            # Check if path is empty
            if not self.path.strip():
                errors.append("Path cannot be empty")
                return errors

            # Check file extension using domain logic
            valid_extensions = {".png", ".ico", ".jpg", ".jpeg", ".bmp", ".gif", ".svg"}
            extension = "." + self.path.split(".")[-1].lower() if "." in self.path else ""
            
            if extension not in valid_extensions:
                errors.append(f"Unsupported file extension: {extension}")

            # Check if file exists through port
            exists_result = file_system_port.file_exists(self.path)
            if not exists_result.is_success or not exists_result.value:
                errors.append(f"File does not exist: {self.path}")
            else:
                # Check if it's a file
                file_info_result = file_system_port.get_file_info(self.path)
                if file_info_result.is_success:
                    file_info = file_info_result.value
                    if file_info is None or not file_info.is_file:
                        errors.append(f"Path is not a file: {self.path}")

            # Check file size (warn if too large for tray icon)
            size = self.get_size_bytes(file_system_port)
            if size and size > 1024 * 1024:  # 1MB
                errors.append(f"File size is large for tray icon: {size} bytes")

        except Exception as e:
            errors.append(f"Path validation error: {e}")

        return errors

    def __str__(self) -> str:
        """String representation of the tray icon path."""
        return self.path

    def __repr__(self) -> str:
        """Detailed string representation."""
        return f"TrayIconPath(path='{self.path}')"