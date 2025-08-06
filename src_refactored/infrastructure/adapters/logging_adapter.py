"""Logging Adapter for external logger integration."""

from typing import Any

from logger import setup_logger
from src_refactored.domain.common.ports.logging_port import LoggingPort


class PythonLoggingAdapter(LoggingPort):
    """Adapter for Python logging using external logger module."""
    
    def __init__(self):
        """Initialize the logging adapter."""
        self._logger = setup_logger()
    
    def info(self, message: str, **kwargs: Any) -> None:
        """Log info message.
        
        Args:
            message: Log message
            **kwargs: Additional context data
        """
        self._logger.info(message, **kwargs)
    
    def debug(self, message: str, **kwargs: Any) -> None:
        """Log debug message.
        
        Args:
            message: Log message
            **kwargs: Additional context data
        """
        self._logger.debug(message, **kwargs)
    
    def warning(self, message: str, **kwargs: Any) -> None:
        """Log warning message.
        
        Args:
            message: Log message
            **kwargs: Additional context data
        """
        self._logger.warning(message, **kwargs)
    
    def error(self, message: str, **kwargs: Any) -> None:
        """Log error message.
        
        Args:
            message: Log message
            **kwargs: Additional context data
        """
        self._logger.error(message, **kwargs)
    
    def exception(self, message: str, **kwargs: Any) -> None:
        """Log exception message.
        
        Args:
            message: Log message
            **kwargs: Additional context data
        """
        self._logger.exception(message, **kwargs)
