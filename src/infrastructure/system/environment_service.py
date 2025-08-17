"""Environment service for managing environment variables and system configuration.

This module provides infrastructure services for setting up environment variables,
warning suppression, and logging configuration.
"""

import logging
import os
import sys
import warnings


class EnvironmentService:
    """Service for managing environment variables and system configuration.
    
    This service provides infrastructure-only logic for environment setup,
    without any UI or business logic dependencies.
    """

    def __init__(self):
        """Initialize the environment service."""
        self._original_env = {}
        self._configured_loggers = set()
        self._suppressed_warnings = []

    def setup_application_environment(self) -> None:
        """Set up the complete application environment with all necessary configurations."""
        self.suppress_third_party_warnings()
        self.configure_pygame_environment()
        self.configure_qt_logging()
        self.configure_python_warnings()
        self.setup_transformers_logging()

    def suppress_third_party_warnings(self) -> None:
        """Suppress warnings from third-party libraries."""
        # Suppress specific warnings
        warnings.filterwarnings("ignore", category=SyntaxWarning)
        warnings.filterwarnings("ignore", category=UserWarning, module="pygame")
        warnings.filterwarnings("ignore", category=UserWarning, module="pydub")
        warnings.filterwarnings("ignore", message="pkg_resources is deprecated")

        self._suppressed_warnings.extend([
            "SyntaxWarning",
            "UserWarning (pygame)",
            "UserWarning (pydub)",
            "pkg_resources deprecation",
        ])

    def configure_pygame_environment(self) -> None:
        """Configure pygame-specific environment variables."""
        self._set_env_var("PYGAME_HIDE_SUPPORT_PROMPT", "hide")

    def configure_qt_logging(self) -> None:
        """Configure Qt logging rules to suppress debug messages."""
        qt_rules = "qt.gui.imageio=false;*.debug=false;qt.qpa.*=false"
        self._set_env_var("QT_LOGGING_RULES", qt_rules)

    def configure_python_warnings(self) -> None:
        """Configure Python warning suppression."""
        warning_rules = "ignore::DeprecationWarning,ignore::SyntaxWarning,ignore::UserWarning"
        self._set_env_var("PYTHONWARNINGS", warning_rules)

    def setup_transformers_logging(self) -> None:
        """Configure transformers library logging to suppress warnings."""
        transformers_logger = logging.getLogger("transformers")
        transformers_logger.setLevel(logging.ERROR)
        self._configured_loggers.add("transformers")

    def setup_python_path(self, root_directory: str,
    ) -> None:
        """Add the root directory to Python path for imports.
        
        Args:
            root_directory: Path to the root directory to add to sys.path
        """
        if root_directory not in sys.path:
            sys.path.insert(0, root_directory)

    def get_environment_variable(self, key: str, default: str | None = None) -> str | None:
        """Get an environment variable value.
        
        Args:
            key: Environment variable name
            default: Default value if variable is not set
            
        Returns:
            Environment variable value or default
        """
        return os.environ.get(key, default)

    def set_environment_variable(self, key: str, value: str, backup: bool = True) -> None:
        """Set an environment variable.
        
        Args:
            key: Environment variable name
            value: Environment variable value
            backup: Whether to backup the original value for restoration
        """
        if backup and key not in self._original_env:
            self._original_env[key] = os.environ.get(key,
    )

        os.environ[key] = value

    def restore_environment_variable(self, key: str,
    ) -> bool:
        """Restore an environment variable to its original value.
        
        Args:
            key: Environment variable name
            
        Returns:
            True if variable was restored, False if no backup exists
        """
        if key in self._original_env:
            original_value = self._original_env[key]
            if original_value is None:
                if key in os.environ:
                    del os.environ[key]
            else:
                os.environ[key] = original_value
            del self._original_env[key]
            return True
        return False

    def get_system_info(self,
    ) -> dict[str, str]:
        """Get system information for debugging purposes.
        
        Returns:
            Dictionary with system information
        """
        return {
            "platform": sys.platform,
            "os_name": os.name,
            "python_version": sys.version,
            "python_executable": sys.executable,    
            "working_directory": os.getcwd(),   
            "temp_directory": self.get_temp_directory(),
            "user_home": self.get_user_home_directory(),
        }

    def get_temp_directory(self) -> str:
        """Get the system temporary directory.
        
        Returns:
            Path to the temporary directory
        """
        import tempfile
        return tempfile.gettempdir()

    def get_user_home_directory(self) -> str:
        """Get the user's home directory.
        
        Returns:
            Path to the user's home directory
        """
        return os.path.expanduser("~")

    def is_windows(self) -> bool:
        """Check if running on Windows.
        
        Returns:
            True if running on Windows, False otherwise
        """
        return os.name in ("nt", "win32") or sys.platform == "win32"

    def is_linux(self) -> bool:
        """Check if running on Linux.
        
        Returns:
            True if running on Linux, False otherwise
        """
        return sys.platform.startswith("linux")

    def is_macos(self) -> bool:
        """Check if running on macOS.
        
        Returns:
            True if running on macOS, False otherwise
        """
        return sys.platform == "darwin"

    def get_configured_loggers(self) -> list[str]:
        """Get list of loggers that have been configured.
        
        Returns:
            List of logger names that have been configured
        """
        return list(self._configured_loggers)

    def get_suppressed_warnings(self) -> list[str]:
        """Get list of warning types that have been suppressed.
        
        Returns:
            List of suppressed warning descriptions
        """
        return self._suppressed_warnings.copy()

    def cleanup(self) -> None:
        """Clean up environment changes and restore original values."""
        # Restore all backed up environment variables
        for key in list(self._original_env.keys()):
            self.restore_environment_variable(key)

        # Reset configured loggers to default levels
        for logger_name in self._configured_loggers:
            logger = logging.getLogger(logger_name)
            logger.setLevel(logging.NOTSET)

        self._configured_loggers.clear()
        self._suppressed_warnings.clear()

    def _set_env_var(self, key: str, value: str,
    ) -> None:
        """Internal method to set environment variable with backup.
        
        Args:
            key: Environment variable name
            value: Environment variable value
        """
        if key not in self._original_env:
            self._original_env[key] = os.environ.get(key)
        os.environ[key] = value