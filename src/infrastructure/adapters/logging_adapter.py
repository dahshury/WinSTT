"""Logging Adapter for external logger integration.

Enhanced logging adapter that provides both file-based and console logging
with date-specific directory organization, integrated with the hexagonal architecture.
"""

import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from src.domain.common.ports.logger_port import ILoggerPort
from src.domain.common.ports.logging_port import LoggingPort, LogLevel
from src.domain.common.result import Result


class PythonLoggingAdapter(LoggingPort, ILoggerPort):
    """Enhanced adapter for Python logging with file-based functionality.
    
    Provides both file and console logging with automatic date-specific
    directory organization, maintaining compatibility with domain interfaces.
    """

    def __init__(self, base_log_path: str | Path = "log"):
        """Initialize the logging adapter with enhanced file logging.
        
        Args:
            base_log_path: Base directory path for log files (default: "log")
        """
        self._base_log_path = Path(base_log_path)
        self._logger = logging.getLogger("WinSTT")
        self._is_configured = False

    def _configure_logging_if_needed(self) -> None:
        """Configure logging handlers if not already configured."""
        if self._is_configured or self._logger.handlers:
            return
            
        try:
            # Create date-specific log directory and file path
            log_file_name = f"{datetime.now(tz=UTC).strftime('%m_%d')}.log"
            log_dir_path = self._base_log_path / log_file_name
            log_dir_path.mkdir(parents=True, exist_ok=True)
            log_file_path = log_dir_path / log_file_name
            
            # Set logger level to INFO to capture file logs
            self._logger.setLevel(logging.INFO)
            
            # Configure file handler for INFO and above
            file_handler = logging.FileHandler(str(log_file_path), encoding="utf-8")
            file_handler.setFormatter(
                logging.Formatter("[%(asctime)s] %(levelname)s - %(message)s"),
            )
            file_handler.setLevel(logging.INFO)
            
            # Configure console handler for WARNING and above only
            console_handler = logging.StreamHandler()
            console_handler.setLevel(logging.WARNING)
            console_formatter = logging.Formatter("%(levelname)s - %(message)s")
            console_handler.setFormatter(console_formatter)
            
            # Add handlers to logger
            self._logger.addHandler(file_handler)
            self._logger.addHandler(console_handler)
            
            # Prevent propagation to avoid duplicate logs
            self._logger.propagate = False
            self._is_configured = True
            
        except OSError:
            # Fallback to basic console logging if file logging fails
            if not self._logger.handlers:
                console_handler = logging.StreamHandler()
                console_handler.setLevel(logging.WARNING)
                self._logger.addHandler(console_handler)
                self._logger.setLevel(logging.INFO)
            self._is_configured = True

    # ILoggerPort API
    def setup_logger(self, level: int | None = None) -> ILoggerPort:
        """Setup and configure the logger with enhanced file logging.
        
        Args:
            level: Optional logging level override
            
        Returns:
            Self as configured logger instance
        """
        self._configure_logging_if_needed()
        
        if level is not None:
            self._logger.setLevel(level)
            
        return self

    def info(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log an info message."""
        self._configure_logging_if_needed()
        self._logger.info(message, *args, **kwargs)

    def debug(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log a debug message."""
        self._configure_logging_if_needed()
        self._logger.debug(message, *args, **kwargs)

    def warning(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log a warning message."""
        self._configure_logging_if_needed()
        self._logger.warning(message, *args, **kwargs)

    def error(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log an error message."""
        self._configure_logging_if_needed()
        self._logger.error(message, *args, **kwargs)

    def exception(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log an exception message with traceback."""
        self._configure_logging_if_needed()
        self._logger.exception(message, *args, **kwargs)

    # LoggingPort (Result-returning) API
    def log_info(self, message: str, **kwargs: Any) -> Result[None]:
        """Log an info message with Result return type."""
        try:
            self._configure_logging_if_needed()
            self._logger.info(message, **kwargs)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to log info: {e}")

    def log_debug(self, message: str, **kwargs: Any) -> Result[None]:
        """Log a debug message with Result return type."""
        try:
            self._configure_logging_if_needed()
            self._logger.debug(message, **kwargs)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to log debug: {e}")

    def log_warning(self, message: str, **kwargs: Any) -> Result[None]:
        """Log a warning message with Result return type."""
        try:
            self._configure_logging_if_needed()
            self._logger.warning(message, **kwargs)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to log warning: {e}")

    def log_error(self, message: str, exception: Exception | None = None, **kwargs: Any) -> Result[None]:
        """Log an error message with Result return type."""
        try:
            self._configure_logging_if_needed()
            if exception:
                kwargs["exc_info"] = exception
            self._logger.error(message, **kwargs)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to log error: {e}")

    def log_critical(self, message: str, exception: Exception | None = None, **kwargs: Any) -> Result[None]:
        """Log a critical message with Result return type."""
        try:
            self._configure_logging_if_needed()
            if exception:
                kwargs["exc_info"] = exception
            self._logger.critical(message, **kwargs)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to log critical: {e}")

    def set_log_level(self, level: LogLevel) -> Result[None]:
        """Set the logging level with Result return type."""
        try:
            self._configure_logging_if_needed()
            self._logger.setLevel(level.value)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to set log level: {e}")

    def get_log_level(self) -> Result[LogLevel]:
        """Get the current logging level with Result return type."""
        try:
            self._configure_logging_if_needed()
            level_value = self._logger.level
            for log_level in LogLevel:
                if log_level.value == level_value:
                    return Result.success(log_level)
            return Result.success(LogLevel.INFO)
        except Exception as e:
            return Result.failure(f"Failed to get log level: {e}")

    def is_enabled_for(self, level: LogLevel) -> Result[bool]:
        """Check if logging is enabled for the given level with Result return type."""
        try:
            self._configure_logging_if_needed()
            is_enabled = self._logger.isEnabledFor(level.value)
            return Result.success(is_enabled)
        except Exception as e:
            return Result.failure(f"Failed to check log level: {e}")
