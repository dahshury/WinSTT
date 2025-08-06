"""Concurrency Port for async and threading operations."""

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from typing import Any

from src_refactored.domain.common.result import Result


class IConcurrencyPort(ABC):
    """Port interface for concurrency operations."""
    
    @abstractmethod
    async def create_lock(self, lock_id: str) -> Result[None]:
        """Create an async lock.
        
        Args:
            lock_id: Unique identifier for the lock
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    async def acquire_lock(self, lock_id: str, timeout_ms: int | None = None) -> Result[bool]:
        """Acquire an async lock.
        
        Args:
            lock_id: Lock identifier
            timeout_ms: Optional timeout in milliseconds
            
        Returns:
            Result containing whether lock was acquired
        """
        ...
    
    @abstractmethod
    async def release_lock(self, lock_id: str) -> Result[None]:
        """Release an async lock.
        
        Args:
            lock_id: Lock identifier
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    async def wait_for_completion(self, operation: Awaitable[Any], timeout_ms: int) -> Result[Any]:
        """Wait for an async operation to complete with timeout.
        
        Args:
            operation: Async operation to wait for
            timeout_ms: Timeout in milliseconds
            
        Returns:
            Result containing operation result or timeout
        """
        ...
    
    @abstractmethod
    async def run_in_background(self, task: Callable[[], Any]) -> Result[str]:
        """Run a task in the background.
        
        Args:
            task: Task to run
            
        Returns:
            Result containing task ID
        """
        ...
    
    @abstractmethod
    async def cancel_background_task(self, task_id: str) -> Result[None]:
        """Cancel a background task.
        
        Args:
            task_id: Task identifier
            
        Returns:
            Result indicating success or failure
        """
        ...


class ITimePort(ABC):
    """Port interface for time operations."""
    
    @abstractmethod
    def get_current_time(self) -> Result[float]:
        """Get current time in seconds since epoch.
        
        Returns:
            Result containing current time
        """
        ...
    
    @abstractmethod
    def get_elapsed_time(self, start_time: float) -> Result[float]:
        """Get elapsed time since start time.
        
        Args:
            start_time: Start time in seconds since epoch
            
        Returns:
            Result containing elapsed time in seconds
        """
        ...
    
    @abstractmethod
    def format_time(self, timestamp: float, format_string: str) -> Result[str]:
        """Format timestamp as string.
        
        Args:
            timestamp: Time in seconds since epoch
            format_string: Format string (e.g., '%Y-%m-%d %H:%M:%S')
            
        Returns:
            Result containing formatted time string
        """
        ...
    
    @abstractmethod
    def sleep(self, duration_ms: int) -> Result[None]:
        """Sleep for specified duration.
        
        Args:
            duration_ms: Duration in milliseconds
            
        Returns:
            Result indicating completion
        """
        ...