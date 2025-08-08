"""Logging Adapter for external logger integration."""

import logging
from typing import Any

from src_refactored.domain.common.ports.logging_port import LoggingPort, LogLevel
from src_refactored.domain.common.result import Result


class PythonLoggingAdapter(LoggingPort):
    """Adapter for Python logging using external logger module."""
    
    def __init__(self):
        """Initialize the logging adapter."""
        # Use standard Python logging to avoid direct dependency on app logger module
        self._logger = logging.getLogger("WinSTT")
    
    def info(self, message: str, **kwargs: Any) -> None:
        """Log info message.
        
        Args:
            message: Log message
            **kwargs: Additional context data
        """
        self._logger.info(message, **kwargs)
    
    def log_info(self, message: str, **kwargs: Any) -> Result[None]:
        """Log an info message.
        
        Args:
            message: The message to log
            **kwargs: Additional context data
            
        Returns:
            Result of operation
        """
        try:
            self._logger.info(message, **kwargs)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to log info: {e}")
    
    def debug(self, message: str, **kwargs: Any) -> None:
        """Log debug message.
        
        Args:
            message: Log message
            **kwargs: Additional context data
        """
        self._logger.debug(message, **kwargs)
    
    def log_debug(self, message: str, **kwargs: Any) -> Result[None]:
        """Log a debug message.
        
        Args:
            message: The message to log
            **kwargs: Additional context data
            
        Returns:
            Result of operation
        """
        try:
            self._logger.debug(message, **kwargs)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to log debug: {e}")
    
    def warning(self, message: str, **kwargs: Any) -> None:
        """Log warning message.
        
        Args:
            message: Log message
            **kwargs: Additional context data
        """
        self._logger.warning(message, **kwargs)
    
    def log_warning(self, message: str, **kwargs: Any) -> Result[None]:
        """Log a warning message.
        
        Args:
            message: The message to log
            **kwargs: Additional context data
            
        Returns:
            Result of operation
        """
        try:
            self._logger.warning(message, **kwargs)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to log warning: {e}")
    
    def error(self, message: str, **kwargs: Any) -> None:
        """Log error message.
        
        Args:
            message: Log message
            **kwargs: Additional context data
        """
        self._logger.error(message, **kwargs)
    
    def log_error(self, message: str, exception: Exception | None = None, **kwargs: Any) -> Result[None]:
        """Log an error message.
        
        Args:
            message: The message to log
            exception: Optional exception details
            **kwargs: Additional context data
            
        Returns:
            Result of operation
        """
        try:
            if exception:
                kwargs["exc_info"] = exception
            self._logger.error(message, **kwargs)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to log error: {e}")
    
    def exception(self, message: str, **kwargs: Any) -> None:
        """Log exception message.
        
        Args:
            message: Log message
            **kwargs: Additional context data
        """
        self._logger.exception(message, **kwargs)
    
    def log_critical(self, message: str, exception: Exception | None = None, **kwargs: Any) -> Result[None]:
        """Log a critical message.
        
        Args:
            message: The message to log
            exception: Optional exception details
            **kwargs: Additional context data
            
        Returns:
            Result of operation
        """
        try:
            if exception:
                kwargs["exc_info"] = exception
            self._logger.critical(message, **kwargs)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to log critical: {e}")
    
    def set_log_level(self, level: LogLevel) -> Result[None]:
        """Set the logging level.
        
        Args:
            level: The log level to set
            
        Returns:
            Result of operation
        """
        try:
            self._logger.setLevel(level.value)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to set log level: {e}")
    
    def get_log_level(self) -> Result[LogLevel]:
        """Get the current logging level.
        
        Returns:
            Result with current log level
        """
        try:
            level_value = self._logger.level
            for log_level in LogLevel:
                if log_level.value == level_value:
                    return Result.success(log_level)
            return Result.success(LogLevel.INFO)  # Default fallback
        except Exception as e:
            return Result.failure(f"Failed to get log level: {e}")
    
    def is_enabled_for(self, level: LogLevel) -> Result[bool]:
        """Check if logging is enabled for the given level.
        
        Args:
            level: The log level to check
            
        Returns:
            Result with boolean indicating if enabled
        """
        try:
            is_enabled = self._logger.isEnabledFor(level.value)
            return Result.success(is_enabled)
        except Exception as e:
            return Result.failure(f"Failed to check log level: {e}")
