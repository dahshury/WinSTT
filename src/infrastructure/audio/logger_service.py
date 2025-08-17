"""Logger Service.

This module implements the LoggerService for logging
audio processing events according to the protocol requirements.
"""

import logging

from src.domain.audio_visualization.protocols import (
    LoggerServiceProtocol,
)


class LoggerService(LoggerServiceProtocol):
    """Service for logging audio processing events."""

    def __init__(self, logger_name: str = "audio_processor"):
        """Initialize the logger service.
        
        Args:
            logger_name: Name for the logger
        """
        self._logger = logging.getLogger(logger_name)
        
        # Set up basic logging if not already configured
        if not self._logger.handlers:
            handler = logging.StreamHandler()
            formatter = logging.Formatter(
                "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
            )
            handler.setFormatter(formatter)
            self._logger.addHandler(handler)
            self._logger.setLevel(logging.INFO)

    def log_info(self, message: str, **kwargs) -> None:
        """Log an info message.
        
        Args:
            message: Message to log
            **kwargs: Additional context
        """
        try:
            if kwargs:
                context = " ".join([f"{k}={v}" for k, v in kwargs.items()])
                self._logger.info(f"{message} - {context}")
            else:
                self._logger.info(message)
        except Exception:
            # Don't let logging errors break the application
            pass

    def log_warning(self, message: str, **kwargs) -> None:
        """Log a warning message.
        
        Args:
            message: Message to log
            **kwargs: Additional context
        """
        try:
            if kwargs:
                context = " ".join([f"{k}={v}" for k, v in kwargs.items()])
                self._logger.warning(f"{message} - {context}")
            else:
                self._logger.warning(message)
        except Exception:
            # Don't let logging errors break the application
            pass

    def log_error(self, message: str, **kwargs) -> None:
        """Log an error message.
        
        Args:
            message: Message to log
            **kwargs: Additional context
        """
        try:
            if kwargs:
                context = " ".join([f"{k}={v}" for k, v in kwargs.items()])
                self._logger.error(f"{message} - {context}")
            else:
                self._logger.error(message)
        except Exception:
            # Don't let logging errors break the application
            pass

    def log_debug(self, message: str, **kwargs) -> None:
        """Log a debug message.
        
        Args:
            message: Message to log
            **kwargs: Additional context
        """
        try:
            if kwargs:
                context = " ".join([f"{k}={v}" for k, v in kwargs.items()])
                self._logger.debug(f"{message} - {context}")
            else:
                self._logger.debug(message)
        except Exception:
            # Don't let logging errors break the application
            pass

    def set_level(self, level: str) -> None:
        """Set the logging level.
        
        Args:
            level: Logging level (DEBUG, INFO, WARNING, ERROR)
        """
        try:
            level_map = {
                "DEBUG": logging.DEBUG,
                "INFO": logging.INFO,
                "WARNING": logging.WARNING,
                "ERROR": logging.ERROR,
            }
            
            if level.upper() in level_map:
                self._logger.setLevel(level_map[level.upper()])
        except Exception:
            # Don't let logging errors break the application
            pass
