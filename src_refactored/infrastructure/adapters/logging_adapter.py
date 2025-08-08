"""Logging Adapter for external logger integration."""

import logging
from typing import Any

from src_refactored.domain.common.ports.logger_port import ILoggerPort
from src_refactored.domain.common.ports.logging_port import LoggingPort, LogLevel
from src_refactored.domain.common.result import Result


class PythonLoggingAdapter(LoggingPort, ILoggerPort):
    """Adapter for Python logging using external logger module."""

    def __init__(self):
        """Initialize the logging adapter."""
        self._logger = logging.getLogger("WinSTT")

    # ILoggerPort API
    def setup_logger(self, level: int | None = None) -> ILoggerPort:
        """Setup and configure the logger and return self."""
        if level is not None:
            self._logger.setLevel(level)
        return self

    def info(self, message: str, **kwargs: Any) -> None:
        self._logger.info(message, **kwargs)

    def debug(self, message: str, **kwargs: Any) -> None:
        self._logger.debug(message, **kwargs)

    def warning(self, message: str, **kwargs: Any) -> None:
        self._logger.warning(message, **kwargs)

    def error(self, message: str, **kwargs: Any) -> None:
        self._logger.error(message, **kwargs)

    def exception(self, message: str, **kwargs: Any) -> None:
        self._logger.exception(message, **kwargs)

    # LoggingPort (Result-returning) API
    def log_info(self, message: str, **kwargs: Any) -> Result[None]:
        try:
            self._logger.info(message, **kwargs)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to log info: {e}")

    def log_debug(self, message: str, **kwargs: Any) -> Result[None]:
        try:
            self._logger.debug(message, **kwargs)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to log debug: {e}")

    def log_warning(self, message: str, **kwargs: Any) -> Result[None]:
        try:
            self._logger.warning(message, **kwargs)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to log warning: {e}")

    def log_error(self, message: str, exception: Exception | None = None, **kwargs: Any) -> Result[None]:
        try:
            if exception:
                kwargs["exc_info"] = exception
            self._logger.error(message, **kwargs)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to log error: {e}")

    def log_critical(self, message: str, exception: Exception | None = None, **kwargs: Any) -> Result[None]:
        try:
            if exception:
                kwargs["exc_info"] = exception
            self._logger.critical(message, **kwargs)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to log critical: {e}")

    def set_log_level(self, level: LogLevel) -> Result[None]:
        try:
            self._logger.setLevel(level.value)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to set log level: {e}")

    def get_log_level(self) -> Result[LogLevel]:
        try:
            level_value = self._logger.level
            for log_level in LogLevel:
                if log_level.value == level_value:
                    return Result.success(log_level)
            return Result.success(LogLevel.INFO)
        except Exception as e:
            return Result.failure(f"Failed to get log level: {e}")

    def is_enabled_for(self, level: LogLevel) -> Result[bool]:
        try:
            is_enabled = self._logger.isEnabledFor(level.value)
            return Result.success(is_enabled)
        except Exception as e:
            return Result.failure(f"Failed to check log level: {e}")
