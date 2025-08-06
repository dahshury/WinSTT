"""Progress Notification Port for progress updates."""

from abc import ABC, abstractmethod


class IProgressNotificationService(ABC):
    """Port interface for progress notification service."""
    
    @abstractmethod
    def notify_progress(self, message: str, percentage: int | None = None) -> None:
        """Notify progress update.
        
        Args:
            message: Progress message
            percentage: Optional percentage complete (0-100)
        """
        ...
    
    @abstractmethod
    def notify_error(self, error_message: str) -> None:
        """Notify error.
        
        Args:
            error_message: Error message to display
        """
        ...
    
    @abstractmethod
    def notify_completion(self, message: str) -> None:
        """Notify completion.
        
        Args:
            message: Completion message
        """
        ...
