"""Worker Management Port Interface.

This module defines the port interface for worker management operations in the domain layer.
"""

from abc import ABC, abstractmethod
from enum import Enum
from typing import Any

from src_refactored.domain.common.result import Result
from src_refactored.domain.worker_management.entities.thread_instance import ThreadInstance
from src_refactored.domain.worker_management.entities.worker_instance import WorkerInstance
from src_refactored.domain.worker_management.value_objects.worker_operations import WorkerType


class WorkerPriority(Enum):
    """Worker priority levels."""
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"


class IWorkerManagementPort(ABC):
    """Port interface for worker management operations."""

    @abstractmethod
    def create_worker(
        self, 
        worker_type: WorkerType,
        name: str,
        priority: WorkerPriority = WorkerPriority.NORMAL,
        configuration: dict[str, Any] | None = None,
    ) -> Result[WorkerInstance]:
        """Create a new worker instance.
        
        Args:
            worker_type: Type of worker to create
            name: Worker name
            priority: Worker priority level
            configuration: Worker configuration parameters
            
        Returns:
            Result containing the created worker instance
        """
        ...

    @abstractmethod
    def start_worker(self, worker: WorkerInstance) -> Result[None]:
        """Start a worker.
        
        Args:
            worker: Worker instance to start
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def stop_worker(self, worker: WorkerInstance, timeout_ms: int = 5000) -> Result[None]:
        """Stop a worker gracefully.
        
        Args:
            worker: Worker instance to stop
            timeout_ms: Timeout in milliseconds
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def force_stop_worker(self, worker: WorkerInstance, timeout_ms: int = 2000) -> Result[None]:
        """Force stop a worker.
        
        Args:
            worker: Worker instance to stop
            timeout_ms: Timeout in milliseconds
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def get_worker_status(self, worker: WorkerInstance) -> Result[dict[str, Any]]:
        """Get worker status information.
        
        Args:
            worker: Worker instance
            
        Returns:
            Result containing worker status information
        """
        ...

    @abstractmethod
    def configure_worker(self, worker: WorkerInstance, configuration: dict[str, Any]) -> Result[None]:
        """Configure worker parameters.
        
        Args:
            worker: Worker instance
            configuration: Configuration parameters
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def send_signal_to_worker(self, worker: WorkerInstance, signal_name: str, data: Any = None) -> Result[None]:
        """Send signal to worker.
        
        Args:
            worker: Worker instance
            signal_name: Name of signal to send
            data: Optional signal data
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def get_worker_metrics(self, worker: WorkerInstance) -> Result[dict[str, Any]]:
        """Get worker performance metrics.
        
        Args:
            worker: Worker instance
            
        Returns:
            Result containing worker metrics
        """
        ...


class IThreadManagementPort(ABC):
    """Port interface for thread management operations."""

    @abstractmethod
    def create_thread(
        self, 
        name: str,
        is_daemon: bool = False,
        configuration: dict[str, Any] | None = None,
    ) -> Result[ThreadInstance]:
        """Create a new thread instance.
        
        Args:
            name: Thread name
            is_daemon: Whether thread should be daemon
            configuration: Thread configuration parameters
            
        Returns:
            Result containing the created thread instance
        """
        ...

    @abstractmethod
    def start_thread(self, thread: ThreadInstance, target_function: Any) -> Result[None]:
        """Start a thread with target function.
        
        Args:
            thread: Thread instance to start
            target_function: Function to execute in thread
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def stop_thread(self, thread: ThreadInstance, timeout_ms: int = 5000) -> Result[None]:
        """Stop a thread gracefully.
        
        Args:
            thread: Thread instance to stop
            timeout_ms: Timeout in milliseconds
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def force_stop_thread(self, thread: ThreadInstance, timeout_ms: int = 2000) -> Result[None]:
        """Force stop a thread.
        
        Args:
            thread: Thread instance to stop
            timeout_ms: Timeout in milliseconds
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def join_thread(self, thread: ThreadInstance, timeout_ms: int | None = None) -> Result[bool]:
        """Join a thread.
        
        Args:
            thread: Thread instance to join
            timeout_ms: Optional timeout in milliseconds
            
        Returns:
            Result containing True if thread joined successfully
        """
        ...

    @abstractmethod
    def move_worker_to_thread(self, worker: WorkerInstance, thread: ThreadInstance) -> Result[None]:
        """Move worker to specified thread.
        
        Args:
            worker: Worker instance to move
            thread: Target thread instance
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def get_thread_info(self, thread: ThreadInstance) -> Result[dict[str, Any]]:
        """Get thread information.
        
        Args:
            thread: Thread instance
            
        Returns:
            Result containing thread information
        """
        ...

    @abstractmethod
    def cleanup_thread_resources(self, thread: ThreadInstance) -> Result[None]:
        """Clean up thread resources.
        
        Args:
            thread: Thread instance
            
        Returns:
            Result indicating success or failure
        """
        ...
