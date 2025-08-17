"""Logging Port.

This module defines the port for logging operations
without direct dependency on logging implementations.
"""

from abc import ABC, abstractmethod
from enum import Enum
from typing import Any

from src.domain.common.result import Result


class LogLevel(Enum):
    """Log level enumeration."""
    DEBUG = 10
    INFO = 20
    WARNING = 30
    ERROR = 40
    CRITICAL = 50


class LoggingPort(ABC):
    """Port for logging operations."""

    @abstractmethod
    def log_debug(self, message: str, **kwargs: Any) -> Result[None]:
        """Log a debug message.
        
        Args:
            message: The message to log
            **kwargs: Additional context data
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def log_info(self, message: str, **kwargs: Any) -> Result[None]:
        """Log an info message.
        
        Args:
            message: The message to log
            **kwargs: Additional context data
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def log_warning(self, message: str, **kwargs: Any) -> Result[None]:
        """Log a warning message.
        
        Args:
            message: The message to log
            **kwargs: Additional context data
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def log_error(self, message: str, exception: Exception | None = None, **kwargs: Any) -> Result[None]:
        """Log an error message.
        
        Args:
            message: The message to log
            exception: Optional exception details
            **kwargs: Additional context data
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def log_critical(self, message: str, exception: Exception | None = None, **kwargs: Any) -> Result[None]:
        """Log a critical message.
        
        Args:
            message: The message to log
            exception: Optional exception details
            **kwargs: Additional context data
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def set_log_level(self, level: LogLevel) -> Result[None]:
        """Set the logging level.
        
        Args:
            level: The log level to set
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def get_log_level(self) -> Result[LogLevel]:
        """Get the current logging level.
        
        Returns:
            Result with current log level
        """

    @abstractmethod
    def is_enabled_for(self, level: LogLevel) -> Result[bool]:
        """Check if logging is enabled for the given level.
        
        Args:
            level: The log level to check
            
        Returns:
            Result with boolean indicating if enabled
        """