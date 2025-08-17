"""Worker and Thread Management Ports."""

from abc import ABC, abstractmethod
from collections.abc import Callable
from enum import Enum
from typing import Any

from src.domain.common.result import Result


class WorkerState(Enum):
    """Worker state enumeration."""
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    STOPPING = "stopping"
    STOPPED = "stopped"
    ERROR = "error"


class ThreadPriority(Enum):
    """Thread priority enumeration."""
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"


class IWorkerPort(ABC):
    """Port interface for worker operations."""
    
    @abstractmethod
    def create_worker(self, worker_type: str, config: dict[str, Any]) -> Result[str]:
        """Create a new worker.
        
        Args:
            worker_type: Type of worker to create
            config: Worker configuration
            
        Returns:
            Result containing worker ID
        """
        ...
    
    @abstractmethod
    def start_worker(self, worker_id: str) -> Result[None]:
        """Start a worker.
        
        Args:
            worker_id: Worker identifier
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def stop_worker(self, worker_id: str, timeout_ms: int = 5000) -> Result[None]:
        """Stop a worker.
        
        Args:
            worker_id: Worker identifier
            timeout_ms: Timeout in milliseconds
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def get_worker_state(self, worker_id: str) -> Result[WorkerState]:
        """Get worker state.
        
        Args:
            worker_id: Worker identifier
            
        Returns:
            Result containing worker state
        """
        ...
    
    @abstractmethod
    def send_message_to_worker(self, worker_id: str, message: dict[str, Any]) -> Result[None]:
        """Send message to worker.
        
        Args:
            worker_id: Worker identifier
            message: Message to send
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def register_worker_callback(self, worker_id: str, callback: Callable[[dict[str, Any]], None]) -> Result[None]:
        """Register callback for worker events.
        
        Args:
            worker_id: Worker identifier
            callback: Callback function
            
        Returns:
            Result indicating success or failure
        """
        ...


class IThreadManagementPort(ABC):
    """Port interface for thread management operations."""
    
    @abstractmethod
    def create_thread(self, thread_name: str, target: Callable[..., object], args: tuple[object, ...] = ()) -> Result[str]:
        """Create a new thread.
        
        Args:
            thread_name: Name for the thread
            target: Function to run in thread
            args: Arguments for target function
            
        Returns:
            Result containing thread ID
        """
        ...
    
    @abstractmethod
    def start_thread(self, thread_id: str) -> Result[None]:
        """Start a thread.
        
        Args:
            thread_id: Thread identifier
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def join_thread(self, thread_id: str, timeout_ms: int | None = None) -> Result[bool]:
        """Join a thread.
        
        Args:
            thread_id: Thread identifier
            timeout_ms: Optional timeout in milliseconds
            
        Returns:
            Result containing whether thread finished within timeout
        """
        ...
    
    @abstractmethod
    def set_thread_priority(self, thread_id: str, priority: ThreadPriority) -> Result[None]:
        """Set thread priority.
        
        Args:
            thread_id: Thread identifier
            priority: Thread priority level
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def is_thread_alive(self, thread_id: str) -> Result[bool]:
        """Check if thread is alive.
        
        Args:
            thread_id: Thread identifier
            
        Returns:
            Result containing thread alive status
        """
        ...
    
    @abstractmethod
    def terminate_thread(self, thread_id: str) -> Result[None]:
        """Terminate a thread forcefully.
        
        Args:
            thread_id: Thread identifier
            
        Returns:
            Result indicating success or failure
        """
        ...
