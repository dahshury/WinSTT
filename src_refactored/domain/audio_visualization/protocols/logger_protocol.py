"""Logger Service Protocol.

This module defines the protocol for logger services.
"""

from typing import Protocol


class LoggerServiceProtocol(Protocol):
    """Protocol for logger service."""

    def log_info(self, message: str, **kwargs) -> None:
        """Log an info message.
        
        Args:
            message: Log message
            **kwargs: Additional logging parameters
        """
        ...

    def log_warning(self, message: str, **kwargs) -> None:
        """Log a warning message.
        
        Args:
            message: Log message
            **kwargs: Additional logging parameters
        """
        ...

    def log_error(self, message: str, **kwargs) -> None:
        """Log an error message.
        
        Args:
            message: Log message
            **kwargs: Additional logging parameters
        """
        ...

    def log_debug(self, message: str, **kwargs) -> None:
        """Log a debug message.
        
        Args:
            message: Log message
            **kwargs: Additional logging parameters
        """
        ...