"""Application Startup Use Case for WinSTT

This module provides the startup use case with proper error handling,
managing the complete application initialization workflow.
"""

import sys
from dataclasses import dataclass
from unittest.mock import patch

from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import QApplication, QMessageBox

from logger import setup_logger
from src.core.utils import resource_path
from src_refactored.application.application_config import ApplicationConfiguration
from src_refactored.infrastructure.common.progress_callback import (
    IProgressCallback,
    ProgressInfo,
    ProgressStatus,
)


@dataclass(frozen=True)
class StartupRequest:
    """Request for application startup."""
    
    config: ApplicationConfiguration
    progress_callback: IProgressCallback | None = None
    force_single_instance: bool = True


@dataclass(frozen=True)
class StartupResult:
    """Result of application startup."""
    
    success: bool
    app: QApplication | None = None
    main_window = None
    error_message: str | None = None
    exit_code: int = 0
    
    @classmethod
    def success_result(cls, app: QApplication, main_window) -> "StartupResult":
        """Create a successful startup result."""
        return cls(success=True, app=app, main_window=main_window)
    
    @classmethod
    def failure_result(cls, error_message: str, exit_code: int = 1) -> "StartupResult":
        """Create a failed startup result."""
        return cls(success=False, error_message=error_message, exit_code=exit_code)
    
    @classmethod
    def single_instance_result(cls) -> "StartupResult":
        """Create result for when another instance is already running."""
        return cls(success=False, error_message="Another instance is already running", exit_code=0)


class StartupApplicationUseCase:
    """Use case for starting the WinSTT application."""
    
    def __init__(self):
        self.logger = setup_logger()
    
    def execute(self, request: StartupRequest) -> StartupResult:
        """Execute the application startup workflow.
        
        Args:
            request: Startup request with configuration and options
            
        Returns:
            StartupResult with success status and created objects
        """
        try:
            # Step 1: Initialize configuration
            self._report_progress(request.progress_callback, "Initializing configuration...", 10)
            request.config.initialize()
            
            # Step 2: Initialize Qt Application
            self._report_progress(request.progress_callback, "Initializing Qt Application...", 20)
            app = self._initialize_qt_application()
            
            # Step 3: Check single instance if required
            if request.force_single_instance:
                self._report_progress(request.progress_callback, "Checking for existing instances...", 30)
                if not self._check_single_instance():
                    return StartupResult.single_instance_result()
            
            # Step 4: Setup subprocess suppression
            self._report_progress(request.progress_callback, "Setting up subprocess suppression...", 40)
            suppress_subprocess_call = self._get_subprocess_suppression()
            
            # Step 5: Create main window
            self._report_progress(request.progress_callback, "Creating main window...", 60)
            main_window = self._create_main_window(suppress_subprocess_call)
            
            # Step 6: Show main window
            self._report_progress(request.progress_callback, "Showing main window...", 80)
            main_window.show()
            
            # Step 7: Complete startup
            self._report_progress(request.progress_callback, "Startup completed successfully", 100)
            self.logger.info("WinSTT application started successfully")
            
            return StartupResult.success_result(app, main_window)
            
        except Exception as e:
            error_msg = f"Failed to start application: {e}"
            self.logger.exception(error_msg)
            
            # Show error dialog
            QMessageBox.critical(None, "WinSTT Error", error_msg)
            
            return StartupResult.failure_result(error_msg)
    
    def _initialize_qt_application(self) -> QApplication:
        """Initialize the Qt application with proper configuration."""
        app = QApplication(sys.argv)
        app.setQuitOnLastWindowClosed(False)
        app.setWindowIcon(QIcon(resource_path("resources/Windows 1 Theta.png")))
        
        self.logger.info("Qt Application initialized")
        return app
    
    def _check_single_instance(self) -> bool:
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
    
    def _get_subprocess_suppression(self):
        """Get the subprocess suppression function."""
        from src.main import suppress_subprocess_call
        return suppress_subprocess_call
    
    def _create_main_window(self, suppress_subprocess_call):
        """Create and setup the main application window."""
        # Import the UI components with subprocess suppression
        with patch("subprocess.Popen", side_effect=suppress_subprocess_call):
            from src.ui.main_window import Window
        
        main_window = Window()
        self.logger.info("Main window created successfully")
        return main_window
    
    def _report_progress(
        self, 
        callback: IProgressCallback | None, 
        message: str, 
        percentage: int,
    ) -> None:
        """Report progress if callback is provided."""
        if callback:
            progress_info = ProgressInfo(
                current=percentage,
                total=100,
                message=message,
                status=ProgressStatus.IN_PROGRESS if percentage < 100 else ProgressStatus.COMPLETED,
            )
            callback.report_progress(progress_info)


def create_startup_use_case() -> StartupApplicationUseCase:
    """Factory function to create a StartupApplicationUseCase instance."""
    return StartupApplicationUseCase()