"""Threading Port Interface.

This module defines the port interface for threading operations in the domain layer.
"""

from abc import ABC, abstractmethod
from collections.abc import Callable


class IThreadingPort(ABC):
    """Port interface for threading operations."""

    @abstractmethod
    def create_daemon_thread(
        self, 
        target: Callable[[], None], 
        name: str | None = None,
    ) -> "IThreadHandle":
        """Create a daemon thread.
        
        Args:
            target: The function to execute in the thread
            name: Optional name for the thread
            
        Returns:
            Handle to the created thread
        """
        ...

    @abstractmethod
    def start_thread(self, thread_handle: "IThreadHandle") -> bool:
        """Start a thread.
        
        Args:
            thread_handle: Handle to the thread to start
            
        Returns:
            True if thread started successfully
        """
        ...

    @abstractmethod
    def is_thread_alive(self, thread_handle: "IThreadHandle") -> bool:
        """Check if a thread is alive.
        
        Args:
            thread_handle: Handle to the thread to check
            
        Returns:
            True if thread is alive
        """
        ...

    @abstractmethod
    def join_thread(self, thread_handle: "IThreadHandle", timeout: float | None = None) -> bool:
        """Join a thread.
        
        Args:
            thread_handle: Handle to the thread to join
            timeout: Optional timeout in seconds
            
        Returns:
            True if thread joined successfully
        """
        ...


class IThreadHandle(ABC):
    """Interface for thread handles."""

    @abstractmethod
    def get_thread_id(self) -> str:
        """Get the thread ID.
        
        Returns:
            Thread identifier as string
        """
        ...

    @abstractmethod
    def get_thread_name(self) -> str | None:
        """Get the thread name.
        
        Returns:
            Thread name if set, None otherwise
        """
        ...
