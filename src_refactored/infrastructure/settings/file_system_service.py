"""File system service for handling file and directory operations."""

import hashlib
import json
import shutil
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any


class FileSystemError(Exception):
    """Exception raised when file system operations fail."""


class FileSystemService:
    """Infrastructure service for file system operations."""

    def __init__(self, base_path: str | None = None):
        """Initialize the file system service.
        
        Args:
            base_path: Base path for relative operations
        """
        self.base_path = Path(base_path) if base_path else Path.cwd()

    def ensure_directory(self, path: str | Path) -> Path:
        """Ensure a directory exists, creating it if necessary.
        
        Args:
            path: Directory path to ensure
            
        Returns:
            Path object of the directory
            
        Raises:
            FileSystemError: If directory creation fails
        """
        try:
            dir_path = Path(path)
            if not dir_path.is_absolute(,
    ):
                dir_path = self.base_path / dir_path

            dir_path.mkdir(parents=True, exist_ok=True)
            return dir_path
        except Exception as e:
            msg = f"Failed to create directory {path}: {e}"
            raise FileSystemError(msg,
    )

    def file_exists(self, path: str | Path) -> bool:
        """Check if a file exists.
        
        Args:
            path: File path to check
            
        Returns:
            True if file exists, False otherwise
        """
        file_path = Path(path)
        if not file_path.is_absolute():
            file_path = self.base_path / file_path

        return file_path.exists() and file_path.is_file()

    def directory_exists(self, path: str | Path) -> bool:
        """Check if a directory exists.
        
        Args:
            path: Directory path to check
            
        Returns:
            True if directory exists, False otherwise
        """
        dir_path = Path(path)
        if not dir_path.is_absolute():
            dir_path = self.base_path / dir_path

        return dir_path.exists() and dir_path.is_dir()

    def get_file_size(self, path: str | Path) -> int:
        """Get the size of a file in bytes.
        
        Args:
            path: File path
            
        Returns:
            File size in bytes
            
        Raises:
            FileSystemError: If file doesn't exist or can't be accessed
        """
        try:
            file_path = Path(path)
            if not file_path.is_absolute():
                file_path = self.base_path / file_path

            return file_path.stat().st_size
        except Exception as e:
            msg = f"Failed to get file size for {path}: {e}"
            raise FileSystemError(msg,
    )

    def get_file_modified_time(self, path: str | Path) -> datetime:
        """Get the last modification time of a file.
        
        Args:
            path: File path
            
        Returns:
            Last modification time
            
        Raises:
            FileSystemError: If file doesn't exist or can't be accessed
        """
        try:
            file_path = Path(path)
            if not file_path.is_absolute():
                file_path = self.base_path / file_path

            timestamp = file_path.stat().st_mtime
            return datetime.fromtimestamp(timestamp)
        except Exception as e:
            msg = f"Failed to get modification time for {path}: {e}"
            raise FileSystemError(msg,
    )

    def copy_file(self, source: str | Path, destination: str | Path) -> None:
        """Copy a file from source to destination.
        
        Args:
            source: Source file path
            destination: Destination file path
            
        Raises:
            FileSystemError: If copy operation fails
        """
        try:
            src_path = Path(source)
            dst_path = Path(destination)

            if not src_path.is_absolute():
                src_path = self.base_path / src_path
            if not dst_path.is_absolute():
                dst_path = self.base_path / dst_path

            # Ensure destination directory exists
            self.ensure_directory(dst_path.parent,
    )

            shutil.copy2(src_path, dst_path)
        except Exception as e:
            msg = f"Failed to copy {source} to {destination}: {e}"
            raise FileSystemError(msg,
    )

    def move_file(self, source: str | Path, destination: str | Path) -> None:
        """Move a file from source to destination.
        
        Args:
            source: Source file path
            destination: Destination file path
            
        Raises:
            FileSystemError: If move operation fails
        """
        try:
            src_path = Path(source)
            dst_path = Path(destination)

            if not src_path.is_absolute():
                src_path = self.base_path / src_path
            if not dst_path.is_absolute():
                dst_path = self.base_path / dst_path

            # Ensure destination directory exists
            self.ensure_directory(dst_path.parent)

            shutil.move(str(src_path,
    ), str(dst_path))
        except Exception as e:
            msg = f"Failed to move {source} to {destination}: {e}"
            raise FileSystemError(msg,
    )

    def delete_file(self, path: str | Path) -> None:
        """Delete a file.
        
        Args:
            path: File path to delete
            
        Raises:
            FileSystemError: If deletion fails
        """
        try:
            file_path = Path(path)
            if not file_path.is_absolute():
                file_path = self.base_path / file_path

            if file_path.exists():
                file_path.unlink()
        except Exception as e:
            msg = f"Failed to delete file {path}: {e}"
            raise FileSystemError(msg,
    )

    def delete_directory(self, path: str | Path, recursive: bool = False) -> None:
        """Delete a directory.
        
        Args:
            path: Directory path to delete
            recursive: Whether to delete recursively
            
        Raises:
            FileSystemError: If deletion fails
        """
        try:
            dir_path = Path(path)
            if not dir_path.is_absolute():
                dir_path = self.base_path / dir_path

            if dir_path.exists():
                if recursive:
                    shutil.rmtree(dir_path)
                else:
                    dir_path.rmdir()
        except Exception as e:
            msg = f"Failed to delete directory {path}: {e}"
            raise FileSystemError(msg,
    )

    def list_files(self, directory: str | Path, pattern: str = "*",
                   recursive: bool = False) -> list[Path]:
        """List files in a directory.
        
        Args:
            directory: Directory to list files from
            pattern: File pattern to match (glob pattern)
            recursive: Whether to search recursively
            
        Returns:
            List of file paths
            
        Raises:
            FileSystemError: If directory doesn't exist or can't be accessed
        """
        try:
            dir_path = Path(directory)
            if not dir_path.is_absolute():
                dir_path = self.base_path / dir_path

            if not dir_path.exists():
                msg = f"Directory {directory} does not exist"
                raise FileSystemError(msg)

            if recursive:
                return list(dir_path.rglob(pattern))
            return list(dir_path.glob(pattern))
        except Exception as e:
            msg = f"Failed to list files in {directory}: {e}"
            raise FileSystemError(msg,
    )

    def read_text_file(self, path: str | Path, encoding: str = "utf-8") -> str:
        """Read text content from a file.
        
        Args:
            path: File path to read
            encoding: Text encoding
            
        Returns:
            File content as string
            
        Raises:
            FileSystemError: If file can't be read
        """
        try:
            file_path = Path(path)
            if not file_path.is_absolute(,
    ):
                file_path = self.base_path / file_path

            with open(file_path, encoding=encoding) as f:
                return f.read()
        except Exception as e:
            msg = f"Failed to read file {path}: {e}"
            raise FileSystemError(msg,
    )

    def write_text_file(self, path: str | Path, content: str,
                       encoding: str = "utf-8") -> None:
        """Write text content to a file.
        
        Args:
            path: File path to write
            content: Text content to write
            encoding: Text encoding
            
        Raises:
            FileSystemError: If file can't be written
        """
        try:
            file_path = Path(path)
            if not file_path.is_absolute():
                file_path = self.base_path / file_path

            # Ensure directory exists
            self.ensure_directory(file_path.parent,
    )

            with open(file_path, "w", encoding=encoding) as f:
                f.write(content)
        except Exception as e:
            msg = f"Failed to write file {path}: {e}"
            raise FileSystemError(msg,
    )

    def read_json_file(self, path: str | Path) -> dict[str, Any]:
        """Read JSON content from a file.
        
        Args:
            path: File path to read
            
        Returns:
            Parsed JSON data
            
        Raises:
            FileSystemError: If file can't be read or parsed
        """
        try:
            content = self.read_text_file(path)
            return json.loads(content)
        except json.JSONDecodeError as e:
            msg = f"Invalid JSON in file {path}: {e}"
            raise FileSystemError(msg)
        except Exception as e:
            msg = f"Failed to read JSON file {path}: {e}"
            raise FileSystemError(msg,
    )

    def write_json_file(self, path: str | Path, data: dict[str, Any],
                       indent: int = 2,
    ) -> None:
        """Write JSON data to a file.
        
        Args:
            path: File path to write
            data: Data to write as JSON
            indent: JSON indentation
            
        Raises:
            FileSystemError: If file can't be written
        """
        try:
            content = json.dumps(data, indent=indent, ensure_ascii=False)
            self.write_text_file(path, content)
        except Exception as e:
            msg = f"Failed to write JSON file {path}: {e}"
            raise FileSystemError(msg,
    )

    def get_file_hash(self, path: str | Path, algorithm: str = "md5",
    ) -> str:
        """Calculate hash of a file.
        
        Args:
            path: File path
            algorithm: Hash algorithm (md5, sha1, sha256)
            
        Returns:
            File hash as hexadecimal string
            
        Raises:
            FileSystemError: If file can't be read or hash can't be calculated
        """
        try:
            file_path = Path(path)
            if not file_path.is_absolute():
                file_path = self.base_path / file_path

            hash_obj = hashlib.new(algorithm,
    )

            with open(file_path, "rb") as f:
                for chunk in iter(lambda: f.read(4096), b""):
                    hash_obj.update(chunk)

            return hash_obj.hexdigest()
        except Exception as e:
            msg = f"Failed to calculate hash for {path}: {e}"
            raise FileSystemError(msg,
    )

    def create_temp_file(self, suffix: str | None = None, prefix: str | None = None,
                        directory: str | Path | None = None) -> tuple[int, str]:
        """Create a temporary file.
        
        Args:
            suffix: File suffix
            prefix: File prefix
            directory: Directory to create temp file in
            
        Returns:
            Tuple of (file descriptor, file path)
            
        Raises:
            FileSystemError: If temp file can't be created
        """
        try:
            temp_dir = None
            if directory:
                temp_dir = Path(directory)
                if not temp_dir.is_absolute():
                    temp_dir = self.base_path / temp_dir
                self.ensure_directory(temp_dir)
                temp_dir = str(temp_dir,
    )

            return tempfile.mkstemp(suffix=suffix, prefix=prefix, dir=temp_dir)
        except Exception as e:
            msg = f"Failed to create temporary file: {e}"
            raise FileSystemError(msg,
    )

    def create_temp_directory(self, suffix: str | None = None, prefix: str | None = None,
                             directory: str | Path | None = None) -> str:
        """Create a temporary directory.
        
        Args:
            suffix: Directory suffix
            prefix: Directory prefix
            directory: Parent directory for temp directory
            
        Returns:
            Path to temporary directory
            
        Raises:
            FileSystemError: If temp directory can't be created
        """
        try:
            temp_dir = None
            if directory:
                temp_dir = Path(directory)
                if not temp_dir.is_absolute():
                    temp_dir = self.base_path / temp_dir
                self.ensure_directory(temp_dir)
                temp_dir = str(temp_dir,
    )

            return tempfile.mkdtemp(suffix=suffix, prefix=prefix, dir=temp_dir)
        except Exception as e:
            msg = f"Failed to create temporary directory: {e}"
            raise FileSystemError(msg,
    )

    def get_disk_usage(self, path: str | Path | None = None) -> tuple[int, int, int]:
        """Get disk usage statistics.
        
        Args:
            path: Path to check (defaults to base_path)
            
        Returns:
            Tuple of (total, used, free) in bytes
            
        Raises:
            FileSystemError: If disk usage can't be determined
        """
        try:
            check_path = Path(path) if path else self.base_path
            if not check_path.is_absolute():
                check_path = self.base_path / check_path

            usage = shutil.disk_usage(check_path,
    )
            return usage.total, usage.used, usage.free
        except Exception as e:
            msg = f"Failed to get disk usage for {path or self.base_path}: {e}"
            raise FileSystemError(msg,
    )

    def cleanup_temp_files(self, pattern: str = "winstt_*", max_age_hours: int = 24) -> int:
        """Clean up temporary files older than specified age.
        
        Args:
            pattern: File pattern to match
            max_age_hours: Maximum age in hours
            
        Returns:
            Number of files cleaned up
        """
        temp_dir = Path(tempfile.gettempdir())
        current_time = datetime.now()
        cleaned_count = 0

        try:
            for file_path in temp_dir.glob(pattern):
                if file_path.is_file():
                    file_age = current_time - datetime.fromtimestamp(file_path.stat().st_mtime)
                    if file_age.total_seconds() > max_age_hours * 3600:
                        file_path.unlink(,
    )
                        cleaned_count += 1
        except Exception:
            # Ignore errors during cleanup
            pass

        return cleaned_count