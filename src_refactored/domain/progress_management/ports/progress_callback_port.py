"""Progress Callback Port Interface.

This module defines the port interface for progress callback operations in the domain layer.
"""

from abc import ABC, abstractmethod
from collections.abc import Callable

from src_refactored.domain.progress_management.value_objects.progress_info import (
    ProgressInfo,
)


class IProgressCallback(ABC):
    """Port interface for progress callback operations."""

    @abstractmethod
    def on_progress_updated(self, progress_info: ProgressInfo) -> None:
        """Called when progress is updated.
        
        Args:
            progress_info: Current progress information
        """
        ...

    @abstractmethod
    def on_progress_started(self, operation_id: str, message: str | None = None) -> None:
        """Called when progress tracking starts.
        
        Args:
            operation_id: Unique identifier for the operation
            message: Optional start message
        """
        ...

    @abstractmethod
    def on_progress_completed(self, operation_id: str, message: str | None = None) -> None:
        """Called when progress tracking completes.
        
        Args:
            operation_id: Unique identifier for the operation
            message: Optional completion message
        """
        ...

    @abstractmethod
    def on_progress_failed(self, operation_id: str, error_message: str) -> None:
        """Called when progress tracking fails.
        
        Args:
            operation_id: Unique identifier for the operation
            error_message: Error description
        """
        ...

    @abstractmethod
    def on_progress_cancelled(self, operation_id: str, reason: str | None = None) -> None:
        """Called when progress tracking is cancelled.
        
        Args:
            operation_id: Unique identifier for the operation
            reason: Optional cancellation reason
        """
        ...

    @abstractmethod
    def set_progress_callback(
        self, 
        callback: Callable[[ProgressInfo], None],
    ) -> str:
        """Set a progress callback function.
        
        Args:
            callback: Function to call on progress updates
            
        Returns:
            Callback registration ID for removal
        """
        ...

    @abstractmethod
    def remove_progress_callback(self, callback_id: str) -> bool:
        """Remove a progress callback.
        
        Args:
            callback_id: Callback registration ID
            
        Returns:
            True if callback was removed successfully
        """
        ...

    @abstractmethod
    def notify_progress(self, progress_info: ProgressInfo) -> None:
        """Notify all registered callbacks of progress update.
        
        Args:
            progress_info: Current progress information
        """
        ...

    @abstractmethod
    def get_active_operations(self) -> list[str]:
        """Get list of active operation IDs.
        
        Returns:
            List of operation IDs that are currently being tracked
        """
        ...

    @abstractmethod
    def get_progress_info(self, operation_id: str) -> ProgressInfo | None:
        """Get current progress info for an operation.
        
        Args:
            operation_id: Operation identifier
            
        Returns:
            Current progress info or None if not found
        """
        ...

    @abstractmethod
    def clear_completed_operations(self) -> int:
        """Clear all completed operations from tracking.
        
        Returns:
            Number of operations cleared
        """
        ...
