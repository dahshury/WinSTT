"""Single instance service for ensuring only one application instance runs.

This module provides infrastructure services for single instance management,
using socket-based detection and platform-specific window activation.
"""

import socket
import sys

try:
    if sys.platform == "win32":
        import win32con
        import win32gui
        WIN32_AVAILABLE = True
    else:
        WIN32_AVAILABLE = False
except ImportError:
    WIN32_AVAILABLE = False


class SingleInstanceService:
    """Service for managing single application instance enforcement.
    
    This service provides infrastructure-only logic for ensuring only one
    instance of the application runs at a time, without any UI dependencies.
    """

    def __init__(self, app_name: str, port: int = 65432):
        """Initialize the single instance service.
        
        Args:
            app_name: Name of the application for window detection
            port: Port number to use for socket-based detection
        """
        self.app_name = app_name
        self.port = port
        self._socket: socket.socket | None = None
        self._is_bound = False

    def is_already_running(self,
    ) -> bool:
        """Check if another instance of the application is already running.
        
        Uses socket binding to detect if another instance is running.
        If another instance is detected and we're on Windows with win32gui available,
        attempts to bring the existing window to the foreground.
        
        Returns:
            True if another instance is running, False otherwise
        """
        try:
            # Create a socket and try to bind to the port
            self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._socket.bind(("localhost", self.port))
            self._socket.listen(1)
            self._is_bound = True
            return False  # No other instance running
        except OSError:
            # Port is already in use, another instance is running
            if self._socket:
                self._socket.close()
                self._socket = None

            # Try to bring the existing window to the foreground
            self._activate_existing_window()
            return True

    def _activate_existing_window(self) -> bool:
        """Attempt to activate the existing application window.
        
        Returns:
            True if window was found and activated, False otherwise
        """
        if not WIN32_AVAILABLE:
            return False

        try:
            # Find the window by class name or title
            hwnd = win32gui.FindWindow(None, self.app_name)
            if hwnd:
                # Bring the window to the foreground
                win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                win32gui.SetForegroundWindow(hwnd)
                return True
        except Exception:
            # Ignore errors in window activation
            pass

        return False

    def acquire_lock(self) -> bool:
        """Acquire the single instance lock.
        
        Returns:
            True if lock was acquired successfully, False if another instance is running
        """
        return not self.is_already_running()

    def release_lock(self) -> None:
        """Release the single instance lock."""
        if self._socket and self._is_bound:
            try:
                self._socket.close()
            except Exception:
                pass
            finally:
                self._socket = None
                self._is_bound = False

    def is_locked(self) -> bool:
        """Check if this instance holds the lock.
        
        Returns:
            True if this instance holds the lock, False otherwise
        """
        return self._is_bound and self._socket is not None

    def get_port(self) -> int:
        """Get the port number used for single instance detection.
        
        Returns:
            Port number
        """
        return self.port

    def get_app_name(self) -> str:
        """Get the application name used for window detection.
        
        Returns:
            Application name
        """
        return self.app_name

    def set_app_name(self, app_name: str,
    ) -> None:
        """Set the application name for window detection.
        
        Args:
            app_name: New application name
        """
        self.app_name = app_name

    def check_win32_availability(self) -> bool:
        """Check if win32gui is available for window management.
        
        Returns:
            True if win32gui is available, False otherwise
        """
        return WIN32_AVAILABLE

    def find_existing_window(self, window_title: str | None = None) -> int | None:
        """Find an existing application window.
        
        Args:
            window_title: Specific window title to search for, defaults to app_name
            
        Returns:
            Window handle (HWND) if found, None otherwise
        """
        if not WIN32_AVAILABLE:
            return None

        title = window_title or self.app_name
        try:
            hwnd = win32gui.FindWindow(None, title)
            return hwnd if hwnd else None
        except Exception:
            return None

    def activate_window(self, hwnd: int,
    ) -> bool:
        """Activate a specific window by handle.
        
        Args:
            hwnd: Window handle to activate
            
        Returns:
            True if window was activated successfully, False otherwise
        """
        if not WIN32_AVAILABLE or not hwnd:
            return False

        try:
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            win32gui.SetForegroundWindow(hwnd)
            return True
        except Exception:
            return False

    def cleanup(self) -> None:
        """Clean up single instance service resources."""
        self.release_lock()

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        self.cleanup()

    def __del__(self):
        """Destructor to ensure cleanup."""
        self.cleanup()


class SingleInstanceManager:
    """High-level manager for single instance functionality.
    
    Provides a simplified interface for common single instance patterns.
    """

    def __init__(self, app_name: str, port: int = 65432,
    ):
        """Initialize the single instance manager.
        
        Args:
            app_name: Name of the application
            port: Port number for instance detection
        """
        self.service = SingleInstanceService(app_name, port)

    def ensure_single_instance(self) -> bool:
        """Ensure only one instance of the application is running.
        
        If another instance is detected, attempts to activate it and returns False.
        If no other instance is detected, acquires the lock and returns True.
        
        Returns:
            True if this should be the running instance, False if should exit
        """
        return not self.service.is_already_running()

    def cleanup(self) -> None:
        """Clean up manager resources."""
        self.service.cleanup()

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        self.cleanup()