"""Application Orchestrator for WinSTT

This module provides the main application workflow orchestration,
managing the startup, initialization, and shutdown processes.
"""

import sys

from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import QApplication, QMessageBox

from logger import setup_logger
from src.core.utils import resource_path


class ApplicationOrchestrator:
    """Orchestrates the main application workflow and lifecycle."""
    
    def __init__(self):
        self.logger = setup_logger()
        self.app: QApplication | None = None
        self.main_window = None
        
    def initialize_application(self) -> QApplication:
        """Initialize the Qt application with proper configuration."""
        self.app = QApplication(sys.argv)
        self.app.setQuitOnLastWindowClosed(False)
        self.app.setWindowIcon(QIcon(resource_path("resources/Windows 1 Theta.png")))
        
        self.logger.info("Qt Application initialized")
        return self.app
    
    def check_single_instance(self) -> bool:
        """Check if another instance is already running.
        
        Returns:
            True if this is the only instance, False if another instance exists
        """
        from src.main import is_already_running
        
        if is_already_running():
            self._handle_existing_instance()
            return False
        return True
    
    def _handle_existing_instance(self) -> None:
        """Handle the case where another instance is already running."""
        from src.main import HAS_WIN32GUI
        
        try:
            # Send signal to bring existing window to front
            if sys.platform == "win32":
                if HAS_WIN32GUI:
                    self._activate_existing_window()
                else:
                    self.logger.warning("win32gui module not found. Install with: pip install pywin32")
                    QMessageBox.warning(
                        None, 
                        "WinSTT", 
                        "Another instance is already running. The pywin32 package is required to activate the existing window.",
                    )
            
            self.logger.info("An instance of WinSTT is already running. Exiting.")
            sys.exit(0)
            
        except Exception as e:
            self.logger.exception(f"Error activating existing instance: {e}")
            QMessageBox.warning(None, "WinSTT", "An instance of WinSTT is already running.")
            sys.exit(0)
    
    def _activate_existing_window(self) -> None:
        """Activate the existing WinSTT window using win32gui."""
        import win32gui
        
        def enum_windows_callback(hwnd, result_list):
            if win32gui.IsWindowVisible(hwnd):
                window_title = win32gui.GetWindowText(hwnd)
                if window_title == "WinSTT":  # Match the window title
                    result_list.append(hwnd)
            return True
        
        hwnd_list = []
        win32gui.EnumWindows(enum_windows_callback, hwnd_list)
        
        if hwnd_list:
            # Bring window to foreground
            win32gui.ShowWindow(hwnd_list[0], 9)  # SW_RESTORE
            win32gui.SetForegroundWindow(hwnd_list[0])
    
    def create_main_window(self):
        """Create and setup the main application window."""
        from unittest.mock import patch

        from src.main import suppress_subprocess_call
        
        # Import the UI components with subprocess suppression
        with patch("subprocess.Popen", side_effect=suppress_subprocess_call):
            from src.ui.main_window import Window
        
        self.main_window = Window()
        return self.main_window
    
    def start_application(self) -> int:
        """Start the main application workflow.
        
        Returns:
            Exit code for the application
        """
        try:
            # Initialize Qt application
            app = self.initialize_application()
            
            # Check for single instance
            if not self.check_single_instance():
                return 0  # Another instance exists, exit gracefully
            
            # Create and show main window
            window = self.create_main_window()
            window.show()
            
            self.logger.info("WinSTT application started successfully")
            
            # Start the Qt event loop
            return app.exec()
            
        except Exception as e:
            self.logger.exception(f"Failed to start application: {e}")
            QMessageBox.critical(
                None, 
                "WinSTT Error", 
                f"Failed to start application: {e!s}",
            )
            return 1
    
    def shutdown_application(self) -> None:
        """Perform graceful application shutdown."""
        try:
            if self.main_window:
                self.main_window.close()
            
            if self.app:
                self.app.quit()
            
            self.logger.info("Application shutdown completed")
            
        except Exception as e:
            self.logger.exception(f"Error during application shutdown: {e}")


def create_application_orchestrator() -> ApplicationOrchestrator:
    """Factory function to create an ApplicationOrchestrator instance."""
    return ApplicationOrchestrator()