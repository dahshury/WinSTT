"""Logging Port for domain layer logging abstraction."""

from abc import ABC, abstractmethod
from typing import Any


class LoggingPort(ABC):
    """Port interface for logging service."""
    
    @abstractmethod
    def info(self, message: str, **kwargs: Any) -> None:
        """Log info message.
        
        Args:
            message: Log message
            **kwargs: Additional context data
        """
        ...
    
    @abstractmethod
    def debug(self, message: str, **kwargs: Any) -> None:
        """Log debug message.
        
        Args:
            message: Log message
            **kwargs: Additional context data
        """
        ...
    
    @abstractmethod
    def warning(self, message: str, **kwargs: Any) -> None:
        """Log warning message.
        
        Args:
            message: Log message
            **kwargs: Additional context data
        """
        ...
    
    @abstractmethod
    def error(self, message: str, **kwargs: Any) -> None:
        """Log error message.
        
        Args:
            message: Log message
            **kwargs: Additional context data
        """
        ...
    
    @abstractmethod
    def exception(self, message: str, **kwargs: Any) -> None:
        """Log exception message.
        
        Args:
            message: Log message
            **kwargs: Additional context data
        """
        ...
