"""Logging service for centralized logging configuration and management.

This module provides infrastructure services for logging setup,
configuration, and management across the application.
"""

import logging
import logging.handlers
import sys
from datetime import datetime
from pathlib import Path


class LoggingService:
    """Service for managing application logging configuration.
    
    This service provides infrastructure-only logic for logging setup
    and management, without any UI or business logic dependencies.
    """

    def __init__(self):
        """Initialize the logging service."""
        self._configured_loggers: dict[str, logging.Logger] = {}
        self._default_format = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
        self._default_date_format = "%Y-%m-%d %H:%M:%S"
        self._log_directory: Path | None = None
        self._is_configured = False

    def setup_basic_logging(self,
                           level: int | str = logging.INFO,
                           format_string: str | None = None,
                           date_format: str | None = None) -> None:
        """Setup basic logging configuration.
        
        Args:
            level: Logging level (e.g., logging.INFO, 'INFO')
            format_string: Custom format string for log messages
            date_format: Custom date format for timestamps
        """
        if isinstance(level, str):
            level = getattr(logging, level.upper())

        format_str = format_string or self._default_format
        date_fmt = date_format or self._default_date_format

        logging.basicConfig(
            level=level,
            format=format_str,
            datefmt=date_fmt,
            force=True,  # Override any existing configuration
        )

        self._is_configured = True

    def setup_file_logging(self,
                          log_directory: str | Path,
                          app_name: str = "app",
                          level: int | str = logging.INFO,
                          max_bytes: int = 10 * 1024 * 1024,  # 10MB
                          backup_count: int = 5,
                          format_string: str | None = None,
                          date_format: str | None = None) -> Path:
        """Setup file-based logging with rotation.
        
        Args:
            log_directory: Directory to store log files
            app_name: Application name for log file naming
            level: Logging level
            max_bytes: Maximum size of each log file
            backup_count: Number of backup files to keep
            format_string: Custom format string for log messages
            date_format: Custom date format for timestamps
            
        Returns:
            Path to the main log file
        """
        if isinstance(level, str):
            level = getattr(logging, level.upper())

        self._log_directory = Path(log_directory)
        self._log_directory.mkdir(parents=True, exist_ok=True)

        log_file = self._log_directory / f"{app_name}.log"

        # Create rotating file handler
        file_handler = logging.handlers.RotatingFileHandler(
            log_file,
            maxBytes=max_bytes,
            backupCount=backup_count,
            encoding="utf-8",
        )

        # Set format
        format_str = format_string or self._default_format
        date_fmt = date_format or self._default_date_format
        formatter = logging.Formatter(format_str, date_fmt)
        file_handler.setFormatter(formatter)

        # Configure root logger
        root_logger = logging.getLogger()
        root_logger.setLevel(level)
        root_logger.addHandler(file_handler)

        self._is_configured = True
        return log_file

    def setup_console_and_file_logging(self,
                                      log_directory: str | Path,
                                      app_name: str = "app",
                                      level: int | str = logging.INFO,
                                      console_level: int | str | None = None,
                                      file_level: int | str | None = None,
                                      max_bytes: int = 10 * 1024 * 1024,
                                      backup_count: int = 5,
                                      format_string: str | None = None,
                                      date_format: str | None = None) -> Path:
        """Setup both console and file logging.
        
        Args:
            log_directory: Directory to store log files
            app_name: Application name for log file naming
            level: Default logging level
            console_level: Console-specific logging level (defaults to level)
            file_level: File-specific logging level (defaults to level)
            max_bytes: Maximum size of each log file
            backup_count: Number of backup files to keep
            format_string: Custom format string for log messages
            date_format: Custom date format for timestamps
            
        Returns:
            Path to the main log file
        """
        if isinstance(level, str):
            level = getattr(logging, level.upper())

        console_lvl = console_level or level
        file_lvl = file_level or level

        if isinstance(console_lvl, str):
            console_lvl = getattr(logging, console_lvl.upper())
        if isinstance(file_lvl, str):
            file_lvl = getattr(logging, file_lvl.upper())

        # Setup log directory
        self._log_directory = Path(log_directory)
        self._log_directory.mkdir(parents=True, exist_ok=True)
        log_file = self._log_directory / f"{app_name}.log"

        # Create formatters
        format_str = format_string or self._default_format
        date_fmt = date_format or self._default_date_format
        formatter = logging.Formatter(format_str, date_fmt)

        # Console handler
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setLevel(console_lvl)
        console_handler.setFormatter(formatter)

        # File handler
        file_handler = logging.handlers.RotatingFileHandler(
            log_file,
            maxBytes=max_bytes,
            backupCount=backup_count,
            encoding="utf-8",
        )
        file_handler.setLevel(file_lvl)
        file_handler.setFormatter(formatter)

        # Configure root logger
        root_logger = logging.getLogger()
        # Ensure both are ints
        root_logger.setLevel(int(min(int(console_lvl), int(file_lvl))))

        # Clear existing handlers
        root_logger.handlers.clear()

        # Add handlers
        root_logger.addHandler(console_handler)
        root_logger.addHandler(file_handler)

        self._is_configured = True
        return log_file

    def get_logger(self, name: str, level: int | str | None = None) -> logging.Logger:
        """Get a named logger with optional custom level.
        
        Args:
            name: Logger name
            level: Optional custom level for this logger
            
        Returns:
            Configured logger instance
        """
        if name in self._configured_loggers:
            return self._configured_loggers[name]

        logger = logging.getLogger(name)

        if level is not None:
            if isinstance(level, str):
                resolved_level = getattr(logging, level.upper())
            else:
                resolved_level = int(level)
            logger.setLevel(resolved_level)

        self._configured_loggers[name] = logger
        return logger

    def set_logger_level(self, name: str, level: int | str) -> None:
        """Set the level for a specific logger.
        
        Args:
            name: Logger name
            level: New logging level
        """
        if isinstance(level, str):
            level = getattr(logging, level.upper())

        logger = logging.getLogger(name)
        logger.setLevel(level)

        if name in self._configured_loggers:
            self._configured_loggers[name] = logger

    def silence_logger(self, name: str,
    ) -> None:
        """Silence a specific logger by setting it to CRITICAL level.
        
        Args:
            name: Logger name to silence
        """
        self.set_logger_level(name, logging.CRITICAL)

    def silence_loggers(self, names: list[str]) -> None:
        """Silence multiple loggers.
        
        Args:
            names: List of logger names to silence
        """
        for name in names:
            self.silence_logger(name)

    def add_file_handler(self,
                        logger_name: str,
                        log_file: str | Path,
                        level: int | str = logging.INFO,
                        format_string: str | None = None,
                        date_format: str | None = None,
                        max_bytes: int | None = None,
                        backup_count: int | None = None) -> None:
        """Add a file handler to a specific logger.
        
        Args:
            logger_name: Name of the logger
            log_file: Path to the log file
            level: Logging level for this handler
            format_string: Custom format string
            date_format: Custom date format
            max_bytes: Maximum file size for rotation (None for no rotation)
            backup_count: Number of backup files (only used if max_bytes is set)
        """
        if isinstance(level, str):
            level = getattr(logging, level.upper())

        logger = self.get_logger(logger_name)

        # Create handler
        if max_bytes is not None:
            handler = logging.handlers.RotatingFileHandler(
                log_file,
                maxBytes=max_bytes,
                backupCount=backup_count or 5,
                encoding="utf-8",
            )
        else:
            # Keep type consistent for callers that expect RotatingFileHandler
            handler = logging.handlers.RotatingFileHandler(
                log_file,
                maxBytes=0,
                backupCount=0,
                encoding="utf-8",
            )

        handler.setLevel(level)

        # Set formatter
        format_str = format_string or self._default_format
        date_fmt = date_format or self._default_date_format
        formatter = logging.Formatter(format_str, date_fmt)
        handler.setFormatter(formatter)

        logger.addHandler(handler)

    def create_timestamped_log_file(self,
                                   base_name: str,
                                   directory: str | Path | None = None) -> Path:
        """Create a timestamped log file path.
        
        Args:
            base_name: Base name for the log file
            directory: Directory for the log file (defaults to configured log directory)
            
        Returns:
            Path to the timestamped log file
        """
        log_dir = Path(directory) if directory else self._log_directory
        if log_dir is None:
            log_dir = Path.cwd() / "logs"

        log_dir.mkdir(parents=True, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        return log_dir / f"{base_name}_{timestamp}.log"


    def get_log_directory(self) -> Path | None:
        """Get the configured log directory.
        
        Returns:
            Path to log directory or None if not configured
        """
        return self._log_directory

    def set_log_directory(self, directory: str | Path) -> None:
        """Set the log directory.
        
        Args:
            directory: Path to log directory
        """
        self._log_directory = Path(directory)
        self._log_directory.mkdir(parents=True, exist_ok=True)

    def is_configured(self) -> bool:
        """Check if logging has been configured.
        
        Returns:
            True if logging is configured, False otherwise
        """
        return self._is_configured

    def get_configured_loggers(self) -> dict[str, logging.Logger]:
        """Get all configured loggers.
        
        Returns:
            Dictionary of logger names to logger instances
        """
        return self._configured_loggers.copy()

    def cleanup_old_logs(self,
                        max_age_days: int = 30,
                        directory: str | Path | None = None) -> list[Path]:
        """Clean up old log files.
        
        Args:
            max_age_days: Maximum age of log files to keep
            directory: Directory to clean (defaults to configured log directory)
            
        Returns:
            List of deleted log file paths
        """
        log_dir = Path(directory) if directory else self._log_directory
        if log_dir is None or not log_dir.exists():
            return []

        deleted_files = []
        cutoff_time = datetime.now().timestamp() - (max_age_days * 24 * 60 * 60)

        for log_file in log_dir.glob("*.log*"):
            if log_file.is_file() and log_file.stat().st_mtime < cutoff_time:
                try:
                    log_file.unlink()
                    deleted_files.append(log_file)
                except OSError:
                    # Ignore files that can't be deleted
                    pass

        return deleted_files

    def reset_configuration(self) -> None:
        """Reset logging configuration."""
        # Clear all handlers from root logger
        root_logger = logging.getLogger()
        for handler in root_logger.handlers[:]:
            root_logger.removeHandler(handler)
            handler.close()

        # Clear configured loggers
        self._configured_loggers.clear()
        self._is_configured = False

    def get_current_log_level(self, logger_name: str | None = None) -> int:
        """Get the current log level for a logger.
        
        Args:
            logger_name: Name of the logger (None for root logger)
            
        Returns:
            Current log level
        """
        logger = logging.getLogger(logger_name)
        return logger.getEffectiveLevel()

    def get_log_level_name(self, level: int,
    ) -> str:
        """Get the name of a log level.
        
        Args:
            level: Log level number
            
        Returns:
            Log level name
        """
        return logging.getLevelName(level)

    def setup_logger(self) -> logging.Logger:
        """Wrapper around the existing logger/logger.py setup_logger function.
        
        This method mirrors the existing setup_logger functionality from logger/logger.py
        to provide dependency injection capabilities while maintaining compatibility.
        
        Returns:
            Configured logger instance
        """
        import os
        from datetime import datetime
        from logging import StreamHandler

        # Mirror the original setup_logger logic
        log_file_name = f"{datetime.now().strftime('%m_%d')}.log"
        log_path = os.path.join("log", log_file_name)
        os.makedirs(log_path, exist_ok=True)
        log_file_path = os.path.join(log_path, log_file_name)

        # Create a custom logger
        logger = logging.getLogger(__name__)
        logger.setLevel(logging.INFO)  # Set to INFO to reduce verbosity

        # Check if handlers already exist to avoid duplicates
        if not logger.handlers:
            # Configure the file handler
            file_handler = logging.FileHandler(log_file_path)
            file_handler.setFormatter(logging.Formatter
                                      ("[%(asctime)s] %(levelname)s - %(message)s"))
            file_handler.setLevel(logging.INFO)

            # Create a stream handler and set its level to WARNING
            stream_handler = StreamHandler()
            stream_handler.setLevel(logging.WARNING)  # Only show warnings and errors in console

            # Add both handlers to the custom logger
            logger.addHandler(file_handler)
            logger.addHandler(stream_handler)

        # Track this logger
        self._configured_loggers[__name__] = logger
        self._is_configured = True

        return logger

    def setup_logger_with_service(self,
                                 app_name: str = "winstt",
                                 log_directory: str | Path = "log") -> logging.Logger:
        """Enhanced setup_logger that uses the service's capabilities.

        This method provides an improved version of setup_logger with better
        configuration options while maintaining the same interface.

        Args:
            app_name: Application name for log files
            log_directory: Directory for log files

        Returns:
            Configured logger instance
        """
        # Use the service's enhanced logging setup
        self.setup_console_and_file_logging(
            log_directory=log_directory,
            app_name=app_name,
            level=logging.INFO,
            console_level=logging.WARNING,
            file_level=logging.INFO,
            format_string="[%(asctime)s] %(levelname)s - %(message)s",
        )

        # Return the configured logger
        return self.get_logger(__name__)