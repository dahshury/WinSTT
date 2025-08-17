"""Error Callback Port Interface.

This module defines the port interface for error callback operations in the domain layer.
"""

from abc import ABC, abstractmethod
from collections.abc import Callable
from datetime import datetime
from enum import Enum
from typing import Any


class ErrorSeverity(Enum):
    """Error severity levels."""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ErrorCategory(Enum):
    """Error categories."""
    AUDIO = "audio"
    TRANSCRIPTION = "transcription"
    FILE_OPERATION = "file_operation"
    NETWORK = "network"
    CONFIGURATION = "configuration"
    WORKER = "worker"
    UI = "ui"
    SYSTEM = "system"
    UNKNOWN = "unknown"


class IErrorCallbackPort(ABC):
    """Port interface for error callback operations."""

    @abstractmethod
    def register_error_callback(
        self, 
        callback: Callable[[str, ErrorSeverity, ErrorCategory, dict[str, Any]], None],
        error_category: ErrorCategory | None = None,
    ) -> str:
        """Register an error callback function.
        
        Args:
            callback: Function to call when error occurs
            error_category: Optional filter by error category
            
        Returns:
            Callback registration ID for unregistering
        """
        ...

    @abstractmethod
    def unregister_error_callback(self, callback_id: str) -> bool:
        """Unregister an error callback.
        
        Args:
            callback_id: Callback registration ID
            
        Returns:
            True if callback was unregistered successfully
        """
        ...

    @abstractmethod
    def notify_error(
        self, 
        message: str,
        severity: ErrorSeverity = ErrorSeverity.MEDIUM,
        category: ErrorCategory = ErrorCategory.UNKNOWN,
        context: dict[str, Any] | None = None,
        exception: Exception | None = None,
    ) -> None:
        """Notify registered callbacks of an error.
        
        Args:
            message: Error message
            severity: Error severity level
            category: Error category
            context: Additional context information
            exception: Optional exception object
        """
        ...

    @abstractmethod
    def notify_warning(
        self, 
        message: str,
        category: ErrorCategory = ErrorCategory.UNKNOWN,
        context: dict[str, Any] | None = None,
    ) -> None:
        """Notify registered callbacks of a warning.
        
        Args:
            message: Warning message
            category: Warning category
            context: Additional context information
        """
        ...

    @abstractmethod
    def notify_info(
        self, 
        message: str,
        category: ErrorCategory = ErrorCategory.UNKNOWN,
        context: dict[str, Any] | None = None,
    ) -> None:
        """Notify registered callbacks of an info message.
        
        Args:
            message: Info message
            category: Message category
            context: Additional context information
        """
        ...

    @abstractmethod
    def set_error_threshold(self, threshold: ErrorSeverity) -> None:
        """Set minimum error severity threshold for notifications.
        
        Args:
            threshold: Minimum severity level to trigger notifications
        """
        ...

    @abstractmethod
    def get_error_history(
        self, 
        category: ErrorCategory | None = None,
        since: datetime | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Get error history.
        
        Args:
            category: Optional filter by category
            since: Optional filter by time
            limit: Maximum number of errors to return
            
        Returns:
            List of error records
        """
        ...

    @abstractmethod
    def clear_error_history(self, category: ErrorCategory | None = None) -> bool:
        """Clear error history.
        
        Args:
            category: Optional filter by category
            
        Returns:
            True if history was cleared successfully
        """
        ...

    @abstractmethod
    def get_callback_count(self, category: ErrorCategory | None = None) -> int:
        """Get number of registered callbacks.
        
        Args:
            category: Optional filter by category
            
        Returns:
            Number of registered callbacks
        """
        ...
