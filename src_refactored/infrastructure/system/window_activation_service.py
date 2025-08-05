"""Window activation service for managing window enumeration and activation.

This module provides infrastructure services for finding and activating
existing application windows, particularly on Windows platforms.
"""

import sys
from collections.abc import Callable

try:
    if sys.platform == "win32":
        import win32con
        import win32gui
        WIN32_AVAILABLE = True
    else:
        WIN32_AVAILABLE = False
except ImportError:
    WIN32_AVAILABLE = False


class WindowInfo:
    """Container for window information."""

    def __init__(self, hwnd: int, title: str, class_name: str = "", visible: bool = True):
        """Initialize window information.
        
        Args:
            hwnd: Window handle
            title: Window title
            class_name: Window class name
            visible: Whether window is visible
        """
        self.hwnd = hwnd
        self.title = title
        self.class_name = class_name
        self.visible = visible

    def __repr__(self) -> str:
        return f"WindowInfo(hwnd={self.hwnd}, title='{self.title}', class_name='{self.class_name}', visible={self.visible})"


class WindowActivationService:
    """Service for managing window enumeration and activation.
    
    This service provides infrastructure-only logic for finding and activating
    application windows, without any UI or business logic dependencies.
    """

    def __init__(self):
        """Initialize the window activation service."""
        self.win32_available = WIN32_AVAILABLE

    def is_win32_available(self) -> bool:
        """Check if win32gui is available for window operations.
        
        Returns:
            True if win32gui is available, False otherwise
        """
        return self.win32_available

    def enumerate_windows(
    self,
    filter_func: Callable[[int],
    bool] | None = None) -> list[WindowInfo]:
        """Enumerate all windows with optional filtering.
        
        Args:
            filter_func: Optional function to filter windows by hwnd
            
        Returns:
            List of WindowInfo objects for matching windows
        """
        if not self.win32_available:
            return []

        windows = []

        def enum_callback(hwnd: int, result_list: list[WindowInfo]) -> bool:
            try:
                if filter_func and not filter_func(hwnd):
                    return True

                title = win32gui.GetWindowText(hwnd)
                class_name = win32gui.GetClassName(hwnd)
                visible = win32gui.IsWindowVisible(hwnd)

                window_info = WindowInfo(hwnd, title, class_name, visible)
                result_list.append(window_info)
            except Exception:
                # Ignore errors for individual windows
                pass
            return True

        try:
            win32gui.EnumWindows(enum_callback, windows)
        except Exception:
            # Return empty list if enumeration fails
            pass

        return windows

    def find_windows_by_title(self, title: str, exact_match: bool = True) -> list[WindowInfo]:
        """Find windows by title.
        
        Args:
            title: Window title to search for
            exact_match: Whether to use exact match or substring match
            
        Returns:
            List of WindowInfo objects for matching windows
        """
        def title_filter(hwnd: int) -> bool:
            try:
                window_title = win32gui.GetWindowText(hwnd)
                if exact_match:
                    return window_title == title
                return title.lower() in window_title.lower()
            except Exception:
                return False

        return self.enumerate_windows(title_filter,
    )

    def find_windows_by_class(self, class_name: str,
    ) -> list[WindowInfo]:
        """Find windows by class name.
        
        Args:
            class_name: Window class name to search for
            
        Returns:
            List of WindowInfo objects for matching windows
        """
        def class_filter(hwnd: int,
    ) -> bool:
            try:
                window_class = win32gui.GetClassName(hwnd)
                return window_class == class_name
            except Exception:
                return False

        return self.enumerate_windows(class_filter,
    )

    def find_visible_windows_by_title(
    self,
    title: str,
    exact_match: bool = True) -> list[WindowInfo]:
        """Find visible windows by title.
        
        Args:
            title: Window title to search for
            exact_match: Whether to use exact match or substring match
            
        Returns:
            List of WindowInfo objects for matching visible windows
        """
        def visible_title_filter(hwnd: int) -> bool:
            try:
                if not win32gui.IsWindowVisible(hwnd):
                    return False

                window_title = win32gui.GetWindowText(hwnd)
                if exact_match:
                    return window_title == title
                return title.lower() in window_title.lower()
            except Exception:
                return False

        return self.enumerate_windows(visible_title_filter,
    )

    def activate_window(self, hwnd: int,
    ) -> bool:
        """Activate a window by handle.
        
        Args:
            hwnd: Window handle to activate
            
        Returns:
            True if window was activated successfully, False otherwise
        """
        if not self.win32_available or not hwnd:
            return False

        try:
            # Restore window if minimized
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            # Bring window to foreground
            win32gui.SetForegroundWindow(hwnd)
            return True
        except Exception:
            return False

    def activate_window_by_title(self, title: str, exact_match: bool = True,
    ) -> bool:
        """Activate the first window found with the specified title.
        
        Args:
            title: Window title to search for
            exact_match: Whether to use exact match or substring match
            
        Returns:
            True if a window was found and activated, False otherwise
        """
        windows = self.find_visible_windows_by_title(title, exact_match)
        if windows:
            return self.activate_window(windows[0].hwnd)
        return False

    def activate_window_by_class(self, class_name: str,
    ) -> bool:
        """Activate the first window found with the specified class name.
        
        Args:
            class_name: Window class name to search for
            
        Returns:
            True if a window was found and activated, False otherwise
        """
        windows = self.find_windows_by_class(class_name)
        visible_windows = [w for w in windows if w.visible]
        if visible_windows:
            return self.activate_window(visible_windows[0].hwnd)
        return False

    def show_window(self, hwnd: int, show_cmd: int | None = None) -> bool:
        """Show a window with the specified command.
        
        Args:
            hwnd: Window handle
            show_cmd: Show command (defaults to SW_RESTORE)
            
        Returns:
            True if successful, False otherwise
        """
        if not self.win32_available or not hwnd:
            return False

        if show_cmd is None:
            show_cmd = win32con.SW_RESTORE

        try:
            win32gui.ShowWindow(hwnd, show_cmd)
            return True
        except Exception:
            return False

    def minimize_window(self, hwnd: int,
    ) -> bool:
        """Minimize a window.
        
        Args:
            hwnd: Window handle
            
        Returns:
            True if successful, False otherwise
        """
        return self.show_window(hwnd, win32con.SW_MINIMIZE)

    def maximize_window(self, hwnd: int,
    ) -> bool:
        """Maximize a window.
        
        Args:
            hwnd: Window handle
            
        Returns:
            True if successful, False otherwise
        """
        return self.show_window(hwnd, win32con.SW_MAXIMIZE)

    def restore_window(self, hwnd: int,
    ) -> bool:
        """Restore a window.
        
        Args:
            hwnd: Window handle
            
        Returns:
            True if successful, False otherwise
        """
        return self.show_window(hwnd, win32con.SW_RESTORE)

    def hide_window(self, hwnd: int,
    ) -> bool:
        """Hide a window.
        
        Args:
            hwnd: Window handle
            
        Returns:
            True if successful, False otherwise
        """
        return self.show_window(hwnd, win32con.SW_HIDE)

    def is_window_visible(self, hwnd: int,
    ) -> bool:
        """Check if a window is visible.
        
        Args:
            hwnd: Window handle
            
        Returns:
            True if window is visible, False otherwise
        """
        if not self.win32_available or not hwnd:
            return False

        try:
            return win32gui.IsWindowVisible(hwnd)
        except Exception:
            return False

    def get_window_title(self, hwnd: int,
    ) -> str:
        """Get the title of a window.
        
        Args:
            hwnd: Window handle
            
        Returns:
            Window title or empty string if not available
        """
        if not self.win32_available or not hwnd:
            return ""

        try:
            return win32gui.GetWindowText(hwnd)
        except Exception:
            return ""

    def get_window_class_name(self, hwnd: int,
    ) -> str:
        """Get the class name of a window.
        
        Args:
            hwnd: Window handle
            
        Returns:
            Window class name or empty string if not available
        """
        if not self.win32_available or not hwnd:
            return ""

        try:
            return win32gui.GetClassName(hwnd)
        except Exception:
            return ""

    def get_window_info(self, hwnd: int,
    ) -> WindowInfo | None:
        """Get detailed information about a window.
        
        Args:
            hwnd: Window handle
            
        Returns:
            WindowInfo object or None if not available
        """
        if not self.win32_available or not hwnd:
            return None

        try:
            title = self.get_window_title(hwnd)
            class_name = self.get_window_class_name(hwnd)
            visible = self.is_window_visible(hwnd,
    )
            return WindowInfo(hwnd, title, class_name, visible)
        except Exception:
            return None

    def activate_application_window(self, app_title: str,
    ) -> bool:
        """Activate an application window using the WinSTT-specific logic.
        
        This method replicates the window activation logic from main.py
        for finding and activating the WinSTT application window.
        
        Args:
            app_title: Application window title to search for
            
        Returns:
            True if window was found and activated, False otherwise
        """
        if not self.win32_available:
            return False

        try:
            # Find window by title using enumeration
            hwnd_list = []

            def enum_windows_callback(hwnd: int, result_list: list[int]) -> bool:
                try:
                    if win32gui.IsWindowVisible(hwnd):
                        window_title = win32gui.GetWindowText(hwnd)
                        if window_title == app_title:
                            result_list.append(hwnd)
                except Exception:
                    pass
                return True

            win32gui.EnumWindows(enum_windows_callback, hwnd_list)

            if hwnd_list:
                # Bring window to foreground using the same constants as main.py
                win32gui.ShowWindow(hwnd_list[0], 9)  # SW_RESTORE (9)
                win32gui.SetForegroundWindow(hwnd_list[0])
                return True
        except Exception:
            pass

        return False

    def get_missing_dependencies(self) -> list[str]:
        """Get information about missing dependencies.
        
        Returns:
            List of missing dependency names
        """
        missing = []

        if sys.platform == "win32" and not self.win32_available:
            missing.append("pywin32")

        return missing

    def get_installation_instructions(self) -> dict[str, str]:
        """Get installation instructions for missing dependencies.
        
        Returns:
            Dictionary mapping dependency names to installation instructions
        """
        instructions = {}

        if sys.platform == "win32" and not self.win32_available:
            instructions["pywin32"] = "pip install pywin32"

        return instructions