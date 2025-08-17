"""Worker communication port for abstracting worker communication dependencies."""

from abc import ABC, abstractmethod
from collections.abc import Callable
from typing import Any

from src.domain.common.result import Result
from src.domain.worker_management.value_objects.communication_channel import (
    CommunicationChannel,
)
from src.domain.worker_management.value_objects.message import Message
from src.domain.worker_management.value_objects.worker_id import WorkerId


class WorkerCommunicationPort(ABC):
    """Port for managing worker communication operations.
    
    This port abstracts worker communication operations from the infrastructure layer,
    allowing the application layer to communicate with workers without direct dependencies
    on specific communication mechanisms like queues or signals.
    """

    @abstractmethod
    def send_message(self, worker_id: WorkerId, message: Message) -> Result[None]:
        """Send a message to a worker.
        
        Args:
            worker_id: Unique identifier for the target worker
            message: Message to send
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def receive_message(self, worker_id: WorkerId, timeout_ms: int | None = None) -> Result[Message | None]:
        """Receive a message from a worker.
        
        Args:
            worker_id: Unique identifier for the source worker
            timeout_ms: Optional timeout in milliseconds
            
        Returns:
            Result containing message if available, None if timeout, error otherwise
        """

    @abstractmethod
    def broadcast_message(self, message: Message, worker_filter: Callable[[WorkerId], bool] | None = None) -> Result[None]:
        """Broadcast a message to multiple workers.
        
        Args:
            message: Message to broadcast
            worker_filter: Optional filter function to select target workers
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def create_communication_channel(self, channel_id: str, config: dict[str, Any]) -> Result[CommunicationChannel]:
        """Create a new communication channel.
        
        Args:
            channel_id: Unique identifier for the channel
            config: Configuration for the channel
            
        Returns:
            Result containing communication channel if successful, error otherwise
        """

    @abstractmethod
    def destroy_communication_channel(self, channel_id: str) -> Result[None]:
        """Destroy a communication channel and clean up resources.
        
        Args:
            channel_id: Unique identifier for the channel
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def register_message_handler(self, worker_id: WorkerId, message_type: str, handler: Callable[[Message], None]) -> Result[None]:
        """Register a message handler for a specific message type.
        
        Args:
            worker_id: Unique identifier for the worker
            message_type: Type of message to handle
            handler: Handler function for the message
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def unregister_message_handler(self, worker_id: WorkerId, message_type: str) -> Result[None]:
        """Unregister a message handler for a specific message type.
        
        Args:
            worker_id: Unique identifier for the worker
            message_type: Type of message to stop handling
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def get_message_queue_size(self, worker_id: WorkerId) -> Result[int]:
        """Get the current size of a worker's message queue.
        
        Args:
            worker_id: Unique identifier for the worker
            
        Returns:
            Result containing queue size if successful, error otherwise
        """

    @abstractmethod
    def clear_message_queue(self, worker_id: WorkerId) -> Result[None]:
        """Clear all pending messages in a worker's queue.
        
        Args:
            worker_id: Unique identifier for the worker
            
        Returns:
            Result indicating success or failure
        """

    @abstractmethod
    def set_message_timeout(self, worker_id: WorkerId, timeout_ms: int) -> Result[None]:
        """Set the default message timeout for a worker.
        
        Args:
            worker_id: Unique identifier for the worker
            timeout_ms: Timeout in milliseconds
            
        Returns:
            Result indicating success or failure
        """
