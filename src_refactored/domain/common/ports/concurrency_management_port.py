"""Concurrency Management Port.

This module defines the port for managing concurrency operations
without direct dependency on threading implementations.
"""

from abc import ABC, abstractmethod
from collections.abc import Callable
from enum import Enum

from src_refactored.domain.common.result import Result


class ThreadState(Enum):
    """Thread state enumeration."""
    NOT_STARTED = "not_started"
    RUNNING = "running"
    STOPPED = "stopped"
    ERROR = "error"


class ConcurrencyManagementPort(ABC):
    """Port for concurrency management operations."""

    @abstractmethod
    def create_thread_context(self, thread_id: str) -> Result[str]:
        """Create a new thread context.
        
        Args:
            thread_id: Unique identifier for the thread
            
        Returns:
            Result with thread context ID
        """

    @abstractmethod
    def start_background_task(
        self, 
        context_id: str, 
        task: Callable[[], None],
        daemon: bool = True,
    ) -> Result[None]:
        """Start a background task.
        
        Args:
            context_id: Thread context identifier
            task: Function to execute in background
            daemon: Whether thread should be daemon
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def stop_background_task(self, context_id: str, timeout_seconds: float = 2.0) -> Result[None]:
        """Stop a background task.
        
        Args:
            context_id: Thread context identifier
            timeout_seconds: Maximum time to wait for stop
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def join_background_task(self, context_id: str, timeout_seconds: float | None = None) -> Result[bool]:
        """Join a background task and wait for completion.
        
        Args:
            context_id: Thread context identifier
            timeout_seconds: Maximum time to wait for completion
            
        Returns:
            Result with whether task completed within timeout
        """

    @abstractmethod
    def create_synchronization_event(self, event_id: str) -> Result[str]:
        """Create a synchronization event.
        
        Args:
            event_id: Unique identifier for the event
            
        Returns:
            Result with event ID
        """

    @abstractmethod
    def set_event(self, event_id: str) -> Result[None]:
        """Set a synchronization event.
        
        Args:
            event_id: Event identifier
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def clear_event(self, event_id: str) -> Result[None]:
        """Clear a synchronization event.
        
        Args:
            event_id: Event identifier
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def wait_for_event(self, event_id: str, timeout_seconds: float | None = None) -> Result[bool]:
        """Wait for a synchronization event.
        
        Args:
            event_id: Event identifier
            timeout_seconds: Maximum time to wait
            
        Returns:
            Result with whether event was set
        """

    @abstractmethod
    def is_event_set(self, event_id: str) -> Result[bool]:
        """Check if a synchronization event is set.
        
        Args:
            event_id: Event identifier
            
        Returns:
            Result with whether event is currently set
        """

    @abstractmethod
    def create_lock(self, lock_id: str) -> Result[str]:
        """Create a synchronization lock.
        
        Args:
            lock_id: Unique identifier for the lock
            
        Returns:
            Result with lock ID
        """

    @abstractmethod
    def acquire_lock(self, lock_id: str, timeout_seconds: float | None = None) -> Result[bool]:
        """Acquire a synchronization lock.
        
        Args:
            lock_id: Lock identifier
            timeout_seconds: Maximum time to wait
            
        Returns:
            Result with whether lock was acquired
        """

    @abstractmethod
    def release_lock(self, lock_id: str) -> Result[None]:
        """Release a synchronization lock.
        
        Args:
            lock_id: Lock identifier
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def get_thread_state(self, context_id: str) -> Result[ThreadState]:
        """Get the state of a thread context.
        
        Args:
            context_id: Thread context identifier
            
        Returns:
            Result with thread state
        """

    @abstractmethod
    def cleanup_thread_context(self, context_id: str) -> Result[None]:
        """Clean up a thread context and associated resources.
        
        Args:
            context_id: Thread context identifier
            
        Returns:
            Result of operation
        """

