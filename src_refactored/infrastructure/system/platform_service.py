"""Platform service for platform-specific operations and feature detection.

This module provides infrastructure services for detecting platform capabilities
and handling platform-specific functionality.
"""

import os
import sys
from typing import Any


class PlatformCapabilities:
    """Container for platform capability information."""

    def __init__(self):
        """Initialize platform capabilities."""
        self.has_win32gui = False
        self.has_pywin32 = False
        self.platform_name = sys.platform
        self.os_name = os.name
        self.is_windows = self._detect_windows()
        self.is_linux = self._detect_linux()
        self.is_macos = self._detect_macos()

        # Detect Windows-specific capabilities
        if self.is_windows:
            self._detect_windows_capabilities()

    def _detect_windows(self) -> bool:
        """Detect if running on Windows."""
        return os.name in ("nt", "win32") or sys.platform == "win32"

    def _detect_linux(self) -> bool:
        """Detect if running on Linux."""
        return sys.platform.startswith("linux")

    def _detect_macos(self) -> bool:
        """Detect if running on macOS."""
        return sys.platform == "darwin"

    def _detect_windows_capabilities(self) -> None:
        """Detect Windows-specific capabilities."""
        # Check for win32gui availability
        try:
            import win32gui
            self.has_win32gui = True
            self.has_pywin32 = True
        except ImportError:
            self.has_win32gui = False

        # Check for other pywin32 components
        if not self.has_pywin32:
            try:
                import win32api
                self.has_pywin32 = True
            except ImportError:
                self.has_pywin32 = False

    def to_dict(self) -> dict[str, Any]:
        """Convert capabilities to dictionary.
        
        Returns:
            Dictionary representation of platform capabilities
        """
        return {
            "platform_name": self.platform_name,
            "os_name": self.os_name,
            "is_windows": self.is_windows,
            "is_linux": self.is_linux,
            "is_macos": self.is_macos,
            "has_win32gui": self.has_win32gui,
            "has_pywin32": self.has_pywin32,
        }


class PlatformService:
    """Service for platform-specific operations and feature detection.
    
    This service provides infrastructure-only logic for platform detection
    and platform-specific functionality, without any UI or business logic dependencies.
    """

    def __init__(self):
        """Initialize the platform service."""
        self.capabilities = PlatformCapabilities()
        self._win32gui_module = None
        self._win32api_module = None

        # Load Windows modules if available
        if self.capabilities.has_win32gui:
            self._load_win32_modules()

    def get_capabilities(self) -> PlatformCapabilities:
        """Get platform capabilities.
        
        Returns:
            PlatformCapabilities object with detected capabilities
        """
        return self.capabilities

    def is_windows(self) -> bool:
        """Check if running on Windows.
        
        Returns:
            True if running on Windows, False otherwise
        """
        return self.capabilities.is_windows

    def is_linux(self) -> bool:
        """Check if running on Linux.
        
        Returns:
            True if running on Linux, False otherwise
        """
        return self.capabilities.is_linux

    def is_macos(self) -> bool:
        """Check if running on macOS.
        
        Returns:
            True if running on macOS, False otherwise
        """
        return self.capabilities.is_macos

    def has_win32gui(self) -> bool:
        """Check if win32gui module is available.
        
        Returns:
            True if win32gui is available, False otherwise
        """
        return self.capabilities.has_win32gui

    def has_pywin32(self) -> bool:
        """Check if pywin32 package is available.
        
        Returns:
            True if pywin32 is available, False otherwise
        """
        return self.capabilities.has_pywin32

    def get_platform_name(self) -> str:
        """Get the platform name.
        
        Returns:
            Platform name (e.g., 'win32', 'linux', 'darwin')
        """
        return self.capabilities.platform_name

    def get_os_name(self) -> str:
        """Get the OS name.
        
        Returns:
            OS name (e.g., 'nt', 'posix')
        """
        return self.capabilities.os_name

    def get_win32gui_module(self):
        """Get the win32gui module if available.
        
        Returns:
            win32gui module or None if not available
        """
        return self._win32gui_module

    def get_win32api_module(self):
        """Get the win32api module if available.
        
        Returns:
            win32api module or None if not available
        """
        return self._win32api_module

    def get_platform_specific_temp_dir(self) -> str:
        """Get platform-specific temporary directory.
        
        Returns:
            Path to platform-specific temporary directory
        """
        import tempfile

        if self.is_windows():
            # On Windows, prefer TEMP over TMP
            return os.environ.get("TEMP", tempfile.gettempdir())
        # On Unix-like systems, use standard temp dir
        return tempfile.gettempdir()

    def get_platform_specific_config_dir(self, app_name: str,
    ) -> str:
        """Get platform-specific configuration directory.
        
        Args:
            app_name: Name of the application
            
        Returns:
            Path to platform-specific configuration directory
        """
        if self.is_windows():
            # Windows: Use APPDATA
            appdata = os.environ.get("APPDATA", os.path.expanduser("~"))
            return os.path.join(appdata, app_name)
        if self.is_macos():
            # macOS: Use ~/Library/Application Support
            return os.path.join(os.path.expanduser("~"), "Library", "Application Support", app_name)
        # Linux: Use XDG_CONFIG_HOME or ~/.config
config_home = (
    os.environ.get("XDG_CONFIG_HOME", os.path.join(os.path.expanduser("~"), ".config")))
        return os.path.join(config_home, app_name.lower())

    def get_platform_specific_data_dir(self, app_name: str,
    ) -> str:
        """Get platform-specific data directory.

        Args:
            app_name: Name of the application

        Returns:
            Path to platform-specific data directory
        """
        if self.is_windows():
            # Windows: Use LOCALAPPDATA
            localappdata = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
            return os.path.join(localappdata, app_name)
        if self.is_macos():
            # macOS: Use ~/Library/Application Support
            return os.path.join(os.path.expanduser("~"), "Library", "Application Support", app_name)
        # Linux: Use XDG_DATA_HOME or ~/.local/share
data_home = (
    os.environ.get("XDG_DATA_HOME", os.path.join(os.path.expanduser("~"), ".local", "share")))
        return os.path.join(data_home, app_name.lower())

    def get_platform_specific_cache_dir(self, app_name: str,
    ) -> str:
        """Get platform-specific cache directory.

        Args:
            app_name: Name of the application

        Returns:
            Path to platform-specific cache directory
        """
        if self.is_windows():
            # Windows: Use LOCALAPPDATA\Temp
            localappdata = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
            return os.path.join(localappdata, "Temp", app_name)
        if self.is_macos():
            # macOS: Use ~/Library/Caches
            return os.path.join(os.path.expanduser("~"), "Library", "Caches", app_name)
        # Linux: Use XDG_CACHE_HOME or ~/.cache
cache_home = (
    os.environ.get("XDG_CACHE_HOME", os.path.join(os.path.expanduser("~"), ".cache")))
        return os.path.join(cache_home, app_name.lower())

    def get_executable_extension(self) -> str:
        """Get platform-specific executable extension.

        Returns:
            Executable extension for the current platform
        """
        if self.is_windows():
            return ".exe"
        return ""

    def get_library_extension(self) -> str:
        """Get platform-specific library extension.

        Returns:
            Library extension for the current platform
        """
        if self.is_windows():
            return ".dll"
        if self.is_macos():
            return ".dylib"
        return ".so"

    def get_path_separator(self) -> str:
        """Get platform-specific path separator.

        Returns:
            Path separator for the current platform
        """
        return os.path.sep

    def get_path_list_separator(self) -> str:
        """Get platform-specific path list separator (for PATH environment variable).

        Returns:
            Path list separator for the current platform
        """
        return os.path.pathsep

    def normalize_path(self, path: str,
    ) -> str:
        """Normalize a path for the current platform.

        Args:
            path: Path to normalize

        Returns:
            Normalized path for the current platform
        """
        return os.path.normpath(path)

    def _load_win32_modules(self) -> None:
        """Load Windows-specific modules if available."""
        try:
            import win32gui
            self._win32gui_module = win32gui
        except ImportError:
            pass

        try:
            import win32api
            self._win32api_module = win32api
        except ImportError:
            pass

    def get_missing_dependencies(self) -> dict[str, str]:
        """Get information about missing platform-specific dependencies.

        Returns:
            Dictionary with missing dependencies and installation instructions
        """
        missing = {}

        if self.is_windows():
            if not self.has_pywin32():
                missing["pywin32"] = "pip install pywin32"
            if not self.has_win32gui():
                missing["win32gui"] = "pip install pywin32 (includes win32gui)"

        return missing

    def validate_platform_requirements(self) -> dict[str, bool]:
        """Validate that platform-specific requirements are met.

        Returns:
            Dictionary with requirement validation results
        """
        requirements = {
            "platform_supported": self.is_windows() or self.is_linux() or self.is_macos()
            "python_version_supported": sys.version_info >= (3, 8),
        }

        if self.is_windows():
            requirements["windows_modules_available"] = self.has_pywin32()

        return requirements