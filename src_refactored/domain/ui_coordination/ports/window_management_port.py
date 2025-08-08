"""Window management port for abstracting window operations."""

from abc import ABC, abstractmethod

from src_refactored.domain.common.result import Result
from src_refactored.domain.ui_coordination.value_objects.window_position import WindowPosition
from src_refactored.domain.ui_coordination.value_objects.window_size import WindowSize
from src_refactored.domain.ui_coordination.value_objects.window_state import WindowState


class WindowManagementPort(ABC):
    """Port for managing window operations.
    
    This port abstracts window management operations from the presentation layer,
    allowing the application layer to manage windows without direct dependencies
    on UI framework classes.
    """

    @abstractmethod
    def get_window_state(self, window_id: str) -> Result[WindowState]:
        """Get the current state of a window.
        
        Args:
            window_id: Unique identifier of the window
            
        Returns:
            Result containing window state if successful, error otherwise
        """

    @abstractmethod
    def set_window_state(self, window_id: str, state: WindowState) -> Result[None]:
        """Set the state of a window.
        
        Args:
            window_id: Unique identifier of the window
            state: New window state
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def get_window_position(self, window_id: str) -> Result[WindowPosition]:
        """Get the current position of a window.
        
        Args:
            window_id: Unique identifier of the window
            
        Returns:
            Result containing window position if successful, error otherwise
        """

    @abstractmethod
    def set_window_position(self, window_id: str, position: WindowPosition) -> Result[None]:
        """Set the position of a window.
        
        Args:
            window_id: Unique identifier of the window
            position: New window position
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def get_window_size(self, window_id: str) -> Result[WindowSize]:
        """Get the current size of a window.
        
        Args:
            window_id: Unique identifier of the window
            
        Returns:
            Result containing window size if successful, error otherwise
        """

    @abstractmethod
    def set_window_size(self, window_id: str, size: WindowSize) -> Result[None]:
        """Set the size of a window.
        
        Args:
            window_id: Unique identifier of the window
            size: New window size
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def show_window(self, window_id: str) -> Result[None]:
        """Show a window.
        
        Args:
            window_id: Unique identifier of the window
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def hide_window(self, window_id: str) -> Result[None]:
        """Hide a window.
        
        Args:
            window_id: Unique identifier of the window
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def minimize_window(self, window_id: str) -> Result[None]:
        """Minimize a window.
        
        Args:
            window_id: Unique identifier of the window
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def maximize_window(self, window_id: str) -> Result[None]:
        """Maximize a window.
        
        Args:
            window_id: Unique identifier of the window
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def restore_window(self, window_id: str) -> Result[None]:
        """Restore a window to its normal state.
        
        Args:
            window_id: Unique identifier of the window
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def close_window(self, window_id: str) -> Result[None]:
        """Close a window.
        
        Args:
            window_id: Unique identifier of the window
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def set_window_title(self, window_id: str, title: str) -> Result[None]:
        """Set the title of a window.
        
        Args:
            window_id: Unique identifier of the window
            title: New window title
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def get_window_title(self, window_id: str) -> Result[str]:
        """Get the title of a window.
        
        Args:
            window_id: Unique identifier of the window
            
        Returns:
            Result containing window title if successful, error otherwise
        """

    @abstractmethod
    def activate_existing_window(self, window_id: str) -> Result[None]:
        """Activate an existing window (bring to foreground).
        
        Args:
            window_id: Unique identifier of the window
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def create_main_window(self, window_id: str) -> Result[None]:
        """Create the main application window.
        
        Args:
            window_id: Unique identifier for the main window
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def show_main_window(self, window_id: str) -> Result[None]:
        """Show the main application window.
        
        Args:
            window_id: Unique identifier for the main window
            
        Returns:
            Result indicating success or failure
        """
