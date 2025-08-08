"""Main window coordinator for the refactored presentation layer.

This module provides the main window coordinator that uses the new infrastructure
services following the hexagonal architecture pattern.
"""

import logging
from pathlib import Path

from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtGui import QAction
from PyQt6.QtWidgets import QApplication, QMainWindow, QSystemTrayIcon

from src_refactored.infrastructure.settings.json_settings_repository import JSONSettingsRepository
from src_refactored.presentation.qt.services.drag_drop_integration_service import (
    DragDropIntegrationService,
)
from src_refactored.presentation.qt.services.event_filter_service import EventFilterService
from src_refactored.presentation.qt.services.geometry_management_service import (
    GeometryManagementService,
)
from src_refactored.presentation.qt.services.worker_thread_management_service import (
    WorkerThreadManagementService,
)
from src_refactored.presentation.qt.services.event_system_service import UIEventSystem
from src_refactored.presentation.qt.services.opacity_effects_service import OpacityEffectsService
from src_refactored.presentation.qt.services.ui_layout_service import UILayoutService
from src_refactored.presentation.qt.services.ui_text_management_service import (
    UITextManagementService,
)
from src_refactored.presentation.qt.services.visualization_integration_service import (
    VisualizationIntegrationService,
)
from src_refactored.presentation.qt.services.widget_layering_service import WidgetLayeringService
from src_refactored.presentation.qt.services.window_configuration_service import (
    WindowConfigurationService,
)


class MainWindow(QMainWindow):
    """Main window coordinator using refactored services.
    
    This class coordinates the main window functionality using the new
    infrastructure services, following the hexagonal architecture pattern.
    """

    # Signals for communication
    settings_requested = pyqtSignal()
    transcription_requested = pyqtSignal(str)  # file path
    recording_toggled = pyqtSignal(bool)  # recording state

    def __init__(self):
        super().__init__()
        self.logger = logging.getLogger(__name__)
        self.logger.info("🏗️ Setting up main window...")

        # Initialize services
        self._initialize_services()

        # Setup UI components
        self._setup_ui()

        # Load configuration
        self._load_configuration()

        # Initialize worker management
        self._initialize_workers()

        # Setup system integration
        self._setup_system_integration()

        self.logger.info("✅ Main window setup complete")

    def _initialize_services(self) -> None:
        """Initialize all required services."""
        self.logger.info("🔧 Initializing services...")

        # Core services
        self.event_system = UIEventSystem()
        self.settings_service = JSONSettingsRepository(Path("config/settings.json"))

        # Window services
        self.window_config_service = WindowConfigurationService()
        self.ui_layout_service = UILayoutService()
        self.visualization_service = VisualizationIntegrationService()
        self.opacity_effects_service = OpacityEffectsService()
        self.text_management_service = UITextManagementService()
        self.widget_layering_service = WidgetLayeringService()

        # System integration services
        self.worker_management_service = WorkerThreadManagementService()
        self.event_filter_service = EventFilterService()
        self.drag_drop_service = DragDropIntegrationService()
        self.geometry_service = GeometryManagementService()

        self.logger.info("✅ Services initialized")

    def _setup_ui(self) -> None:
        """Setup the user interface using services."""
        self.logger.info("🎨 Setting up UI components...")

        # Configure window properties
        self.window_config_service.configure_window(self)

        # Setup UI layout
        self.ui_layout_service.setup_layout(self)

        # Setup visualization integration
        self.visualization_service.setup_visualization(self)

        # Setup widget layering
        self.widget_layering_service.setup_layering(self)

        # Setup text management
        self.text_management_service.setup_text_elements(self)

        self.logger.info("✅ UI components setup complete")

    def _load_configuration(self) -> None:
        """Load application configuration."""
        self.logger.info("⚙️ Loading configuration...")

        try:
            self.config = self.settings_service.load_settings()

            # Apply configuration to UI
            self._apply_configuration()

            self.logger.info("✅ Configuration loaded")
        except Exception as e:
            self.logger.exception(f"❌ Failed to load configuration: {e}")
            # Use default configuration
            self.config = self._get_default_configuration()

    def _apply_configuration(self) -> None:
        """Apply loaded configuration to the UI."""
        # Recording settings
        self.enable_recording_sound = self.config.get("enable_sound", True)
        self.start_sound = self.config.get("sound_path", "resources/splash.mp3")
        self.current_output_srt = self.config.get("output_srt", False)
        self.rec_key = self.config.get("rec_key", "CTRL+ALT+A")

        # Model settings
        self.selected_model = self.config.get("model", "whisper-turbo")
        self.selected_quantization = self.config.get("quantization", "Full")

        # LLM settings
        self.llm_enabled = self.config.get("llm_enabled", False)
        self.llm_model = self.config.get("llm_model", "gemma-3-1b-it")
        self.llm_quantization = self.config.get("llm_quantization", "Full")
        self.llm_prompt = self.config.get("llm_prompt", "You are a helpful assistant.")

    def _get_default_configuration(self) -> dict:
        """Get default configuration values."""
        return {
            "enable_sound": True,
            "sound_path": "resources/splash.mp3",
            "output_srt": False,
            "rec_key": "CTRL+ALT+A",
            "model": "whisper-turbo",
            "quantization": "Full",
            "llm_enabled": False,
            "llm_model": "gemma-3-1b-it",
            "llm_quantization": "Full",
            "llm_prompt": "You are a helpful assistant.",
        }

    def _initialize_workers(self) -> None:
        """Initialize worker thread management."""
        self.logger.info("🧵 Initializing worker management...")

        # Initialize worker threads
        self.worker_management_service.initialize_workers(self)

        # Setup worker references
        self.vad_thread: QThread | None = None
        self.model_thread: QThread | None = None
        self.listener_thread: QThread | None = None
        self.started_listener = False

        # Initialize transcription state
        self.is_transcribing = False
        self.transcription_queue = []

        self.logger.info("✅ Worker management initialized")

    def _setup_system_integration(self) -> None:
        """Setup system integration features."""
        self.logger.info("🔗 Setting up system integration...")

        # Setup system tray
        self._setup_system_tray()

        # Setup event filtering
        self.event_filter_service.install_event_filter(self)

        # Enable drag and drop
        self.drag_drop_service.enable_drag_drop(self)

        # Setup geometry management
        self.geometry_service.setup_geometry(self)

        self.logger.info("✅ System integration setup complete")

    def _setup_system_tray(self) -> None:
        """Setup system tray icon and menu."""
        self.logger.info("🔔 Creating system tray icon...")

        # Create tray icon
        self.tray_icon = QSystemTrayIcon(self)

        # Setup tray actions
        self.show_action = QAction("Show", self)
        self.settings_action = QAction("Settings", self)
        self.close_action = QAction("Exit", self)

        # Connect actions
        self.show_action.triggered.connect(self.show_window)
        self.settings_action.triggered.connect(self.open_settings)
        self.close_action.triggered.connect(self.close_app)

        # Configure tray directly
        self.tray_icon.setIcon(self.style().standardIcon(self.style().StandardPixmap.SP_ComputerIcon))
        self.tray_icon.setToolTip("WinSTT")
        self.tray_icon.setVisible(True)

        self.logger.info("✅ System tray icon created")

    def open_settings(self) -> None:
        """Open the settings dialog."""
        self.logger.info("⚙️ Opening settings dialog...")
        self.settings_requested.emit()

    def show_window(self) -> None:
        """Show the main window."""
        self.show()
        self.raise_()
        self.activateWindow()

    def close_app(self) -> None:
        """Close the application."""
        self.logger.info("🚪 Closing application...")

        # Cleanup workers
        self.worker_management_service.cleanup_workers()

        # Close application
        QApplication.quit()

    def start_recording(self) -> None:
        """Start audio recording."""
        self.logger.info("Starting recording...")
        self.recording_toggled.emit(True)

        # Apply recording visual effects
        self.opacity_effects_service.apply_recording_effects(self)

    def stop_recording(self) -> None:
        """Stop audio recording."""
        self.logger.info("⏹️ Stopping recording...")
        self.recording_toggled.emit(False)

        # Remove recording visual effects
        self.opacity_effects_service.remove_recording_effects(self)

    def update_transcription_progress(self, progress: float, message: str = "",
    ) -> None:
        """Update transcription progress."""
        # Update progress display using text management service
        self.text_management_service.update_progress_text(self, progress, message)

    def display_transcription_result(self, result: str,
    ) -> None:
        """Display transcription result."""
        self.logger.info("📝 Transcription result: {result[:100]}...")

        # Display result using text management service
        self.text_management_service.display_result(self, result)

    def handle_file_drop(self, file_paths: list[str]) -> None:
        """Handle dropped files."""
        self.logger.info("📁 Files dropped: {len(file_paths)} files")

        for file_path in file_paths:
            self.transcription_requested.emit(file_path)

    def showEvent(self, event) -> None:
        """Handle window show event."""
        super().showEvent(event)

        # Initialize workers after window is shown
        if not self.started_listener:
            self.worker_management_service.start_workers(self)
            self.started_listener = True

    def closeEvent(self, event) -> None:
        """Handle window close event."""
        # Hide to system tray instead of closing
        event.ignore()
        self.hide()

        if self.tray_icon.isVisible():
            self.tray_icon.showMessage(
                "WinSTT",
                "Application was minimized to tray",
                QSystemTrayIcon.MessageIcon.Information,
                2000,
            )