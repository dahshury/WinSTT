"""Concurrency Port for async and threading operations."""

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from src.domain.common.result import Result

T = TypeVar("T")


class AsyncLock:
    """Async lock interface."""
    async def __aenter__(self) -> None: ...
    async def __aexit__(self, exc_type: type | None, exc_val: Exception | None, exc_tb: Any) -> None: ...


class AsyncSemaphore:
    """Async semaphore interface."""
    async def __aenter__(self) -> None: ...
    async def __aexit__(self, exc_type: type | None, exc_val: Exception | None, exc_tb: Any) -> None: ...


class IConcurrencyPort(ABC):
    """Port interface for concurrency operations."""
    
    @abstractmethod
    def create_lock(self, lock_id: str | None = None) -> AsyncLock:
        """Create an async lock.
        
        Args:
            lock_id: Optional unique identifier for the lock
            
        Returns:
            Async lock object
        """
        ...
    
    @abstractmethod
    def create_semaphore(self, value: int) -> AsyncSemaphore:
        """Create an async semaphore.
        
        Args:
            value: Maximum number of permits
            
        Returns:
            Async semaphore object
        """
        ...
    
    @abstractmethod
    async def to_thread(self, func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        """Run a function in a thread pool.
        
        Args:
            func: Function to run
            *args: Positional arguments
            **kwargs: Keyword arguments
            
        Returns:
            Function result
        """
        ...
    
    @abstractmethod
    async def gather(self, *awaitables: Awaitable[T], return_exceptions: bool = False) -> list[T]:
        """Gather multiple awaitables.
        
        Args:
            *awaitables: Awaitables to gather
            return_exceptions: Whether to return exceptions
            
        Returns:
            List of results
        """
        ...
    
    @abstractmethod
    async def wait_for(self, awaitable: Awaitable[T], timeout: float) -> T:
        """Wait for an awaitable with timeout.
        
        Args:
            awaitable: Awaitable to wait for
            timeout: Timeout in seconds
            
        Returns:
            Awaitable result
        """
        ...
    
    @abstractmethod
    async def sleep(self, duration: float) -> None:
        """Sleep for specified duration.
        
        Args:
            duration: Sleep duration in seconds
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