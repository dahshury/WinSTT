"""Application bootstrap service for PyQt6 application setup and configuration.

This module provides infrastructure services for QApplication initialization,
configuration, and lifecycle management.
"""

import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from PyQt6.QtCore import QCoreApplication
from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import QApplication


class ApplicationBootstrap:
    """Service for bootstrapping PyQt6 applications.
    
    This service provides infrastructure-only logic for QApplication setup
    and configuration, without any UI or business logic dependencies.
    """

    def __init__(self):
        """Initialize the application bootstrap service."""
        self._app: QApplication | None = None
        self._is_initialized = False
        self._quit_on_last_window_closed = False
        self._window_icon_path: str | None = None
        self._application_name: str | None = None
        self._organization_name: str | None = None
        self._organization_domain: str | None = None
        self._application_version: str | None = None

    def create_application(self, argv: list[str] | None = None) -> QApplication:
        """Create and configure QApplication instance.
        
        Args:
            argv: Command line arguments (defaults to sys.argv)
            
        Returns:
            Configured QApplication instance
        """
        if self._app is not None:
            return self._app

        if argv is None:
            argv = sys.argv

        self._app = QApplication(argv,
    )
        self._is_initialized = True

        return self._app

    def configure_application(self,
                            quit_on_last_window_closed: bool = False,
                            window_icon_path: str | None = None,
                            application_name: str | None = None,
                            organization_name: str | None = None,
                            organization_domain: str | None = None,
                            application_version: str | None = None) -> None:
        """Configure QApplication properties.
        
        Args:
            quit_on_last_window_closed: Whether app should quit when last window closes
            window_icon_path: Path to application icon
            application_name: Application name
            organization_name: Organization name
            organization_domain: Organization domain
            application_version: Application version
        """
        if not self._app:
            msg = "Application must be created before configuration"
            raise RuntimeError(msg)

        # Store configuration
        self._quit_on_last_window_closed = quit_on_last_window_closed
        self._window_icon_path = window_icon_path
        self._application_name = application_name
        self._organization_name = organization_name
        self._organization_domain = organization_domain
        self._application_version = application_version

        # Apply configuration
        self._app.setQuitOnLastWindowClosed(quit_on_last_window_closed)

        if window_icon_path and Path(window_icon_path).exists():
            self._app.setWindowIcon(QIcon(window_icon_path))

        if application_name:
            QCoreApplication.setApplicationName(application_name)

        if organization_name:
            QCoreApplication.setOrganizationName(organization_name)

        if organization_domain:
            QCoreApplication.setOrganizationDomain(organization_domain)

        if application_version:
            QCoreApplication.setApplicationVersion(application_version,
    )

    def setup_winstt_application(
    self,
    argv: list[str] | None = None,
    icon_path: str | None = None) -> QApplication:
        """Setup QApplication with WinSTT-specific configuration.
        
        This method replicates the QApplication setup logic from main.py.
        
        Args:
            argv: Command line arguments (defaults to sys.argv)
            icon_path: Path to application icon
            
        Returns:
            Configured QApplication instance
        """
        # Create application
        app = self.create_application(argv)

        # Configure with WinSTT defaults
        self.configure_application(
            quit_on_last_window_closed=False,
            window_icon_path=icon_path,
            application_name="WinSTT",
            organization_name="WinSTT",
            organization_domain="winstt.com",
            application_version="1.0.0",
        )

        return app

    def get_application(self) -> QApplication | None:
        """Get the current QApplication instance.
        
        Returns:
            QApplication instance or None if not created
        """
        return self._app

    def is_initialized(self) -> bool:
        """Check if application has been initialized.
        
        Returns:
            True if application is initialized, False otherwise
        """
        return self._is_initialized

    def set_quit_on_last_window_closed(self, quit_on_close: bool,
    ) -> None:
        """Set whether application should quit when last window closes.
        
        Args:
            quit_on_close: Whether to quit on last window close
        """
        if not self._app:
            msg = "Application must be created before configuration"
            raise RuntimeError(msg)

        self._quit_on_last_window_closed = quit_on_close
        self._app.setQuitOnLastWindowClosed(quit_on_close,
    )

    def set_window_icon(self, icon_path: str,
    ) -> bool:
        """Set application window icon.
        
        Args:
            icon_path: Path to icon file
            
        Returns:
            True if icon was set successfully, False otherwise
        """
        if not self._app:
            msg = "Application must be created before configuration"
            raise RuntimeError(msg)

        if not Path(icon_path).exists():
            return False

        try:
            self._window_icon_path = icon_path
            self._app.setWindowIcon(QIcon(icon_path),
    )
            return True
        except Exception:
            return False

    def set_application_metadata(self,
                               name: str | None = None,
                               organization: str | None = None,
                               domain: str | None = None,
                               version: str | None = None) -> None:
        """Set application metadata.
        
        Args:
            name: Application name
            organization: Organization name
            domain: Organization domain
            version: Application version
        """
        if name:
            self._application_name = name
            QCoreApplication.setApplicationName(name)

        if organization:
            self._organization_name = organization
            QCoreApplication.setOrganizationName(organization)

        if domain:
            self._organization_domain = domain
            QCoreApplication.setOrganizationDomain(domain)

        if version:
            self._application_version = version
            QCoreApplication.setApplicationVersion(version)

    def execute_application(self) -> int:
        """Execute the application event loop.
        
        Returns:
            Application exit code
        """
        if not self._app:
            msg = "Application must be created before execution"
            raise RuntimeError(msg)

        return self._app.exec()

    def quit_application(self) -> None:
        """Quit the application."""
        if self._app:
            self._app.quit()

    def get_configuration(self,
    ) -> dict[str, Any]:
        """Get current application configuration.
        
        Returns:
            Dictionary with current configuration
        """
        return {
            "is_initialized": self._is_initialized,
            "quit_on_last_window_closed": self._quit_on_last_window_closed,
            "window_icon_path": self._window_icon_path,
            "application_name": self._application_name,
            "organization_name": self._organization_name,
            "organization_domain": self._organization_domain,
            "application_version": self._application_version,
        }

    def reset_configuration(self) -> None:
        """Reset application configuration to defaults."""
        self._quit_on_last_window_closed = False
        self._window_icon_path = None
        self._application_name = None
        self._organization_name = None
        self._organization_domain = None
        self._application_version = None

    def cleanup(self) -> None:
        """Clean up application resources."""
        if self._app:
            self._app.quit()
            self._app = None
        self._is_initialized = False
        self.reset_configuration()

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit with cleanup."""
        self.cleanup()


class ApplicationBootstrapManager:
    """High-level manager for application bootstrap operations.
    
    Provides a simplified interface for common bootstrap patterns.
    """

    def __init__(self):
        """Initialize the application bootstrap manager."""
        self.service = ApplicationBootstrap()

    def bootstrap_winstt_application(self,
                                   argv: list[str] | None = None,
                                   icon_resource_path: str | None = None) -> QApplication:
        """Bootstrap WinSTT application with standard configuration.
        
        Args:
            argv: Command line arguments
            icon_resource_path: Path to application icon resource
            
        Returns:
            Configured QApplication instance
        """
        return self.service.setup_winstt_application(argv, icon_resource_path)

    def run_application_with_bootstrap(self,
                                     setup_func: Callable[[], None],
                                     argv: list[str] | None = None,
                                     icon_path: str | None = None) -> int:
        """Run application with full bootstrap lifecycle.
        
        Args:
            setup_func: Function to call after application setup
            argv: Command line arguments
            icon_path: Path to application icon
            
        Returns:
            Application exit code
        """
        try:
            # Bootstrap application
            self.bootstrap_winstt_application(argv, icon_path)

            # Run setup function
            setup_func()

            # Execute application
            return self.service.execute_application()
        except Exception:
            return 1

    def cleanup(self) -> None:
        """Clean up manager resources."""
        self.service.cleanup()

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        self.cleanup()