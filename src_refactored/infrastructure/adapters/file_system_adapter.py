"""File system adapter that implements protocol interfaces."""

from datetime import datetime
from pathlib import Path
from typing import Any

from src_refactored.domain.common.ports.file_system_port import (
    DirectoryInfo,
    FileInfo,
    FileSystemPort,
)
from src_refactored.domain.common.result import Result
from src_refactored.infrastructure.settings.file_system_service import FileSystemService


class FileSystemAdapter(FileSystemPort):
    """Adapter for FileSystemService to implement FileSystemPort."""

    def __init__(self, file_system_service: FileSystemService):
        self._service = file_system_service

    def file_exists(self, file_path: str) -> Result[bool]:
        """Check if a file exists."""
        try:
            exists = self._service.file_exists(file_path)
            return Result.success(exists)
        except Exception as e:
            return Result.failure(str(e))

    def directory_exists(self, directory_path: str) -> Result[bool]:
        """Check if a directory exists."""
        try:
            exists = self._service.directory_exists(directory_path)
            return Result.success(exists)
        except Exception as e:
            return Result.failure(str(e))

    def get_file_info(self, file_path: str) -> Result[FileInfo]:
        """Get information about a file."""
        try:
            size = self._service.get_file_size(file_path)
            modified_time = self._service.get_file_modified_time(file_path)
            exists = self._service.file_exists(file_path)
            
            file_info = FileInfo(
                path=file_path,
                size_bytes=size,
                created_at=modified_time,  # Using modified time as created time for now
                modified_at=modified_time,
                is_file=True,
                is_directory=False,
                exists=exists,
            )
            return Result.success(file_info)
        except Exception as e:
            return Result.failure(str(e))

    def get_directory_info(self, directory_path: str) -> Result[DirectoryInfo]:
        """Get information about a directory."""
        try:
            dir_path = Path(directory_path)
            if not dir_path.is_absolute():
                dir_path = self._service.base_path / dir_path
            
            file_count = len([f for f in dir_path.iterdir() if f.is_file()])
            subdirectory_count = len([d for d in dir_path.iterdir() if d.is_dir()])
            total_size_bytes = sum(f.stat().st_size for f in dir_path.rglob("*") if f.is_file())
            modified_time = datetime.fromtimestamp(dir_path.stat().st_mtime)
            exists = self._service.directory_exists(directory_path)
            
            dir_info = DirectoryInfo(
                path=directory_path,
                file_count=file_count,
                subdirectory_count=subdirectory_count,
                total_size_bytes=total_size_bytes,
                created_at=modified_time,  # Using modified time as created time for now
                modified_at=modified_time,
                exists=exists,
            )
            return Result.success(dir_info)
        except Exception as e:
            return Result.failure(str(e))

    def get_file_size(self, file_path: str) -> Result[int]:
        """Get file size in bytes."""
        try:
            size = self._service.get_file_size(file_path)
            return Result.success(size)
        except Exception as e:
            return Result.failure(str(e))

    def get_modification_time(self, file_path: str) -> Result[datetime]:
        """Get file modification time."""
        try:
            modified_time = self._service.get_file_modified_time(file_path)
            return Result.success(modified_time)
        except Exception as e:
            return Result.failure(str(e))

    def create_directory(self, directory_path: str, recursive: bool = True) -> Result[None]:
        """Create a directory."""
        try:
            self._service.ensure_directory(directory_path)
            return Result.success(None)
        except Exception as e:
            return Result.failure(str(e))

    def delete_file(self, file_path: str) -> Result[None]:
        """Delete a file."""
        try:
            self._service.delete_file(file_path)
            return Result.success(None)
        except Exception as e:
            return Result.failure(str(e))

    def delete_directory(self, directory_path: str, recursive: bool = False) -> Result[None]:
        """Delete a directory."""
        try:
            self._service.delete_directory(directory_path, recursive)
            return Result.success(None)
        except Exception as e:
            return Result.failure(str(e))

    def copy_file(self, source_path: str, destination_path: str) -> Result[None]:
        """Copy a file."""
        try:
            self._service.copy_file(source_path, destination_path)
            return Result.success(None)
        except Exception as e:
            return Result.failure(str(e))

    def move_file(self, source_path: str, destination_path: str) -> Result[None]:
        """Move/rename a file."""
        try:
            self._service.move_file(source_path, destination_path)
            return Result.success(None)
        except Exception as e:
            return Result.failure(str(e))

    def list_directory(self, directory_path: str) -> Result[list[str]]:
        """List contents of a directory."""
        try:
            dir_path = Path(directory_path)
            if not dir_path.is_absolute():
                dir_path = self._service.base_path / dir_path
            
            contents = [item.name for item in dir_path.iterdir()]
            return Result.success(contents)
        except Exception as e:
            return Result.failure(str(e))

    def get_file_extension(self, file_path: str) -> Result[str]:
        """Get file extension."""
        try:
            extension = Path(file_path).suffix
            return Result.success(extension)
        except Exception as e:
            return Result.failure(str(e))

    def get_file_name(self, file_path: str) -> Result[str]:
        """Get file name without path."""
        try:
            name = Path(file_path).name
            return Result.success(name)
        except Exception as e:
            return Result.failure(str(e))

    def get_directory_name(self, file_path: str) -> Result[str]:
        """Get directory containing the file."""
        try:
            dir_name = str(Path(file_path).parent)
            return Result.success(dir_name)
        except Exception as e:
            return Result.failure(str(e))

    def join_paths(self, *path_components: str) -> Result[str]:
        """Join path components into a single path."""
        try:
            joined_path = str(Path(*path_components))
            return Result.success(joined_path)
        except Exception as e:
            return Result.failure(str(e))

    def resolve_path(self, file_path: str) -> Result[str]:
        """Resolve relative path to absolute path."""
        try:
            resolved_path = str(Path(file_path).resolve())
            return Result.success(resolved_path)
        except Exception as e:
            return Result.failure(str(e))

    def is_absolute_path(self, file_path: str) -> Result[bool]:
        """Check if path is absolute."""
        try:
            is_absolute = self._service.is_absolute_path(file_path)
            return Result.success(is_absolute)
        except Exception as e:
            return Result.failure(str(e))

    def validate_file_path(self, file_path: str) -> Result[bool]:
        """Validate if file path is valid for the filesystem."""
        try:
            # Basic validation - path is not empty and doesn't contain invalid characters
            is_valid = bool(file_path and file_path.strip() and not any(char in file_path for char in ["<", ">", ":", '"', "|", "?", "*"]))
            return Result.success(is_valid)
        except Exception as e:
            return Result.failure(str(e))

    def get_basename(self, file_path: str) -> Result[str]:
        """Get base name of a file (filename without directory path)."""
        try:
            basename = Path(file_path).stem
            return Result.success(basename)
        except Exception as e:
            return Result.failure(str(e))

    def split_extension(self, file_path: str) -> Result[tuple[str, str]]:
        """Split file path into base name and extension."""
        try:
            path = Path(file_path)
            base_name = str(path.with_suffix(""))
            extension = path.suffix
            return Result.success((base_name, extension))
        except Exception as e:
            return Result.failure(str(e))

    # Additional methods from the original adapter
    def read_json_file(self, path: str) -> Result[dict[str, Any]]:
        """Read JSON configuration from file."""
        try:
            data = self._service.read_json_file(path)
            return Result.success(data)
        except Exception as e:
            return Result.failure(str(e))

    def get_project_root(self) -> Result[str]:
        """Get project root directory."""
        try:
            root = self._service.get_project_root()
            return Result.success(root)
        except Exception as e:
            return Result.failure(str(e))

    def resolve_config_path(self, relative_path: str) -> Result[str]:
        """Resolve configuration file path."""
        try:
            path = self._service.resolve_config_path(relative_path)
            return Result.success(path)
        except Exception as e:
            return Result.failure(str(e))

    def write_file(self, path: str, content: bytes) -> Result[None]:
        """Write content to file."""
        try:
            content_str = content.decode("utf-8") if isinstance(content, bytes) else content
            self._service.write_text_file(path, content_str)
            return Result.success(None)
        except Exception as e:
            return Result.failure(str(e))

    def read_file(self, path: str) -> Result[bytes]:
        """Read file content."""
        try:
            content = self._service.read_text_file(path)
            return Result.success(content.encode("utf-8"))
        except Exception as e:
            return Result.failure(str(e))

    def get_available_space(self, path: str) -> Result[int]:
        """Get available disk space in bytes."""
        try:
            total, used, free = self._service.get_disk_usage(path)
            return Result.success(free)
        except Exception as e:
            return Result.failure(str(e))