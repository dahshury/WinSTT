"""Subprocess service for managing subprocess operations with console suppression.

This module provides infrastructure services for subprocess management,
including console window suppression on Windows platforms.
"""

import subprocess
import sys
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch


class SubprocessService:
    """Service for managing subprocess operations with platform-specific optimizations.
    
    This service provides infrastructure-only logic for subprocess management,
    without any UI or business logic dependencies.
    """

    def __init__(self):
        """Initialize the subprocess service."""
        self._original_popen = subprocess.Popen
        self._is_patched = False
        self._patch_context = None

    def create_suppressed_subprocess(self, *args, **kwargs) -> subprocess.Popen:
        """Create a subprocess with console window suppression on Windows.
        
        Args:
            *args: Arguments to pass to subprocess.Popen
            **kwargs: Keyword arguments to pass to subprocess.Popen
            
        Returns:
            subprocess.Popen instance with console suppression applied
        """
        if sys.platform == "win32":
            # Suppress the console window on Windows
            CREATE_NO_WINDOW = 0x08000000
            kwargs["creationflags"] = kwargs.get("creationflags", 0) | CREATE_NO_WINDOW

        return self._original_popen(*args, **kwargs)

    def run_suppressed(self, *args, **kwargs) -> subprocess.CompletedProcess:
        """Run a subprocess with console suppression.
        
        Args:
            *args: Arguments to pass to subprocess.run
            **kwargs: Keyword arguments to pass to subprocess.run
            
        Returns:
            subprocess.CompletedProcess with console suppression applied
        """
        if sys.platform == "win32":
            # Suppress the console window on Windows
            CREATE_NO_WINDOW = 0x08000000
            kwargs["creationflags"] = kwargs.get("creationflags", 0) | CREATE_NO_WINDOW

        return subprocess.run(*args, **kwargs, check=False)

    def check_output_suppressed(self, *args, **kwargs) -> bytes:
        """Run subprocess.check_output with console suppression.
        
        Args:
            *args: Arguments to pass to subprocess.check_output
            **kwargs: Keyword arguments to pass to subprocess.check_output
            
        Returns:
            Output bytes with console suppression applied
        """
        if sys.platform == "win32":
            # Suppress the console window on Windows
            CREATE_NO_WINDOW = 0x08000000
            kwargs["creationflags"] = kwargs.get("creationflags", 0) | CREATE_NO_WINDOW

        return subprocess.check_output(*args, **kwargs)

    def call_suppressed(self, *args, **kwargs) -> int:
        """Run subprocess.call with console suppression.
        
        Args:
            *args: Arguments to pass to subprocess.call
            **kwargs: Keyword arguments to pass to subprocess.call
            
        Returns:
            Return code with console suppression applied
        """
        if sys.platform == "win32":
            # Suppress the console window on Windows
            CREATE_NO_WINDOW = 0x08000000
            kwargs["creationflags"] = kwargs.get("creationflags", 0) | CREATE_NO_WINDOW

        return subprocess.call(*args, **kwargs)

    @contextmanager
    def patch_subprocess_globally(self):
        """Context manager to globally patch subprocess.Popen with console suppression.
        
        This patches subprocess.Popen globally for the duration of the context.
        Use this when you need to suppress console windows for all subprocess calls
        within a specific scope.
        
        Example:
            with subprocess_service.patch_subprocess_globally():
                # All subprocess calls within this block will have console suppression
                import some_module_that_uses_subprocess
                some_module_that_uses_subprocess.do_something()
        """
        def suppress_subprocess_call(*args, **kwargs):
            return self.create_suppressed_subprocess(*args, **kwargs)

        with patch("subprocess.Popen", side_effect=suppress_subprocess_call):
            yield

    def apply_global_patch(self) -> None:
        """Apply global patch to subprocess.Popen.
        
        This permanently patches subprocess.Popen until remove_global_patch is called.
        Use with caution as this affects all subprocess calls in the application.
        """
        if self._is_patched:
            return

        def suppress_subprocess_call(*args, **kwargs):
            return self.create_suppressed_subprocess(*args, **kwargs)

        self._patch_context = patch("subprocess.Popen", side_effect=suppress_subprocess_call)
        self._patch_context.start()
        self._is_patched = True

    def remove_global_patch(self) -> None:
        """Remove global patch from subprocess.Popen."""
        if not self._is_patched or not self._patch_context:
            return

        self._patch_context.stop()
        self._patch_context = None
        self._is_patched = False

    def is_globally_patched(self) -> bool:
        """Check if subprocess.Popen is currently globally patched.
        
        Returns:
            True if globally patched, False otherwise
        """
        return self._is_patched

    def get_creation_flags(self, suppress_console: bool = True,
    ) -> int:
        """Get appropriate creation flags for subprocess on Windows.
        
        Args:
            suppress_console: Whether to suppress console window
            
        Returns:
            Creation flags for subprocess on Windows, 0 on other platforms
        """
        if sys.platform != "win32":
            return 0

        flags = 0
        if suppress_console:
            CREATE_NO_WINDOW = 0x08000000
            flags |= CREATE_NO_WINDOW

        return flags

    def prepare_subprocess_kwargs(self, kwargs: dict[str, Any], suppress_console: bool = True,
    ) -> dict[str, Any]:
        """Prepare subprocess keyword arguments with platform-specific optimizations.
        
        Args:
            kwargs: Original keyword arguments
            suppress_console: Whether to suppress console window on Windows
            
        Returns:
            Modified keyword arguments with platform-specific settings
        """
        modified_kwargs = kwargs.copy()

        if sys.platform == "win32" and suppress_console:
            creation_flags = self.get_creation_flags(suppress_console=True,
    )
            existing_flags = modified_kwargs.get("creationflags", 0)
            modified_kwargs["creationflags"] = existing_flags | creation_flags

        return modified_kwargs

    def run_command(self, command: str | list[str],
                   capture_output: bool = True,
                   text: bool = True,
                   suppress_console: bool = True,
                   timeout: float | None = None,
                   **kwargs) -> subprocess.CompletedProcess:
        """Run a command with sensible defaults and console suppression.
        
        Args:
            command: Command to run (string or list of arguments)
            capture_output: Whether to capture stdout and stderr
            text: Whether to return text instead of bytes
            suppress_console: Whether to suppress console window on Windows
            timeout: Timeout in seconds
            **kwargs: Additional keyword arguments for subprocess.run
            
        Returns:
            subprocess.CompletedProcess with the command result
        """
        run_kwargs = {
            "capture_output": capture_output,
            "text": text,
            "timeout": timeout,
            **kwargs,
        }

        run_kwargs = self.prepare_subprocess_kwargs(run_kwargs, suppress_console)

        return subprocess.run(command, **run_kwargs, check=False)

    def check_command_exists(self, command: str,
    ) -> bool:
        """Check if a command exists in the system PATH.
        
        Args:
            command: Command name to check
            
        Returns:
            True if command exists, False otherwise
        """
        try:
            result = self.run_command(
                ["where" if sys.platform == "win32" else "which", command],
                capture_output=True,
                suppress_console=True,
            )
            return result.returncode == 0
        except (subprocess.SubprocessError, FileNotFoundError):
            return False

    def get_command_path(self, command: str,
    ) -> str | None:
        """Get the full path to a command if it exists.
        
        Args:
            command: Command name to find
            
        Returns:
            Full path to command or None if not found
        """
        try:
            result = self.run_command(
                ["where" if sys.platform == "win32" else "which", command],
                capture_output=True,
                suppress_console=True,
            )
            if result.returncode == 0 and result.stdout:
                return result.stdout.strip().split("\n")[0]
        except (subprocess.SubprocessError, FileNotFoundError):
            pass
        return None

    def cleanup(self) -> None:
        """Clean up subprocess service resources."""
        if self._is_patched:
            self.remove_global_patch()

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        self.cleanup()