"""Window activation port for abstracting platform-specific window operations."""

from abc import ABC, abstractmethod

from src.domain.application_lifecycle.entities.activation_configuration import (
    ActivationConfiguration,
)
from src.domain.application_lifecycle.entities.window_info import WindowInfo


class WindowActivationPort(ABC):
    """Port for managing window activation and enumeration.
    
    This port abstracts platform-specific window management operations,
    removing direct dependencies on system APIs like win32gui.
    """

    @abstractmethod
    def find_application_windows(self, process_name: str) -> list[WindowInfo]:
        """Find all windows belonging to the specified process.
        
        Args:
            process_name: Name of the process to search for
            
        Returns:
            List of window information for matching windows
        """

    @abstractmethod
    def activate_window(self, window_info: WindowInfo, config: ActivationConfiguration) -> bool:
        """Activate the specified window.
        
        Args:
            window_info: Information about the window to activate
            config: Configuration for window activation
            
        Returns:
            True if window was activated successfully, False otherwise
        """

    @abstractmethod
    def bring_window_to_front(self, window_info: WindowInfo) -> bool:
        """Bring the specified window to the front.
        
        Args:
            window_info: Information about the window to bring forward
            
        Returns:
            True if window was brought to front successfully, False otherwise
        """

    @abstractmethod
    def restore_window(self, window_info: WindowInfo) -> bool:
        """Restore a minimized window.
        
        Args:
            window_info: Information about the window to restore
            
        Returns:
            True if window was restored successfully, False otherwise
        """

    @abstractmethod
    def is_window_visible(self, window_info: WindowInfo) -> bool:
        """Check if the specified window is visible.
        
        Args:
            window_info: Information about the window to check
            
        Returns:
            True if window is visible, False otherwise
        """

    @abstractmethod
    def get_window_title(self, window_info: WindowInfo) -> str | None:
        """Get the title of the specified window.
        
        Args:
            window_info: Information about the window
            
        Returns:
            Window title if available, None otherwise
        """

    @abstractmethod
    def show_notification(self, title: str, message: str, duration_ms: int = 3000) -> None:
        """Show a system notification to the user.
        
        Args:
            title: Notification title
            message: Notification message
            duration_ms: Duration to show notification in milliseconds
        """
