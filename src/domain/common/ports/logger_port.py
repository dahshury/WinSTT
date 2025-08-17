"""Logger Port Interface.

This module defines the port interface for logging operations in the domain layer.
"""

from abc import ABC, abstractmethod
from typing import Any


class ILoggerPort(ABC):
    """Port interface for logging operations."""

    @abstractmethod
    def setup_logger(self, level: int | None = None) -> "ILoggerPort":
        """Setup and configure the logger.
        
        Args:
            level: Optional logging level
            
        Returns:
            Configured logger instance
        """
        ...

    @abstractmethod
    def info(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log an info message.
        
        Args:
            message: The message to log
            **kwargs: Additional context data
        """
        ...

    @abstractmethod
    def warning(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log a warning message.
        
        Args:
            message: The message to log
            **kwargs: Additional context data
        """
        ...

    @abstractmethod
    def error(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log an error message.
        
        Args:
            message: The message to log
            **kwargs: Additional context data
        """
        ...

    @abstractmethod
    def exception(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log an exception with stack trace.
        
        Args:
            message: The message to log
            **kwargs: Additional context data
        """
        ...

    @abstractmethod
    def debug(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log a debug message.
        
        Args:
            message: The message to log
            **kwargs: Additional context data
        """
        ...
