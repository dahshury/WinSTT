"""Worker lifecycle port for abstracting worker management dependencies."""

from abc import ABC, abstractmethod
from typing import Any

from src_refactored.domain.common.result import Result
from src_refactored.domain.worker_management.value_objects.worker_configuration import (
    WorkerConfiguration,
)
from src_refactored.domain.worker_management.value_objects.worker_id import WorkerId
from src_refactored.domain.worker_management.value_objects.worker_status import WorkerStatus


class WorkerLifecyclePort(ABC):
    """Port for managing worker lifecycle operations.
    
    This port abstracts worker management operations from the infrastructure layer,
    allowing the application layer to manage workers without direct dependencies
    on threading or process management frameworks.
    """

    @abstractmethod
    def initialize_worker(self, worker_id: WorkerId, config: WorkerConfiguration) -> Result[None]:
        """Initialize a new worker with the specified configuration.
        
        Args:
            worker_id: Unique identifier for the worker
            config: Configuration for worker initialization
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def start_worker(self, worker_id: WorkerId) -> Result[None]:
        """Start a previously initialized worker.
        
        Args:
            worker_id: Unique identifier for the worker
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def stop_worker(self, worker_id: WorkerId, timeout_ms: int | None = None) -> Result[None]:
        """Stop a running worker.
        
        Args:
            worker_id: Unique identifier for the worker
            timeout_ms: Optional timeout in milliseconds for graceful shutdown
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def cleanup_worker(self, worker_id: WorkerId) -> Result[None]:
        """Clean up resources associated with a worker.
        
        Args:
            worker_id: Unique identifier for the worker
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def get_worker_status(self, worker_id: WorkerId) -> Result[WorkerStatus]:
        """Get the current status of a worker.
        
        Args:
            worker_id: Unique identifier for the worker
            
        Returns:
            Result containing worker status if successful, error otherwise
        """

    @abstractmethod
    def is_worker_alive(self, worker_id: WorkerId) -> Result[bool]:
        """Check if a worker is currently alive and responsive.
        
        Args:
            worker_id: Unique identifier for the worker
            
        Returns:
            Result containing alive status if successful, error otherwise
        """

    @abstractmethod
    def restart_worker(self, worker_id: WorkerId, config: WorkerConfiguration | None = None) -> Result[None]:
        """Restart a worker with optional new configuration.
        
        Args:
            worker_id: Unique identifier for the worker
            config: Optional new configuration for the worker
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def get_worker_metrics(self, worker_id: WorkerId) -> Result[dict[str, Any]]:
        """Get performance metrics for a worker.
        
        Args:
            worker_id: Unique identifier for the worker
            
        Returns:
            Result containing worker metrics if successful, error otherwise
        """

    @abstractmethod
    def set_worker_priority(self, worker_id: WorkerId, priority: int) -> Result[None]:
        """Set the execution priority for a worker.
        
        Args:
            worker_id: Unique identifier for the worker
            priority: Priority level for the worker
            
        Returns:
            Result indicating success or failure
        """
