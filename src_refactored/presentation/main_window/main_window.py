"""Refactored Main Window for WinSTT.

This is a properly architected main window that follows DDD/hexagonal architecture
principles with proper separation of concerns.
"""

from pathlib import Path
from typing import Protocol

from PyQt6.QtCore import QObject, Qt, pyqtSignal
from PyQt6.QtGui import QBrush, QColor, QIcon, QPalette
from PyQt6.QtWidgets import QMainWindow, QWidget

from src_refactored.application.main_window_coordination import MainWindowController
from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.presentation.adapters.ui_status_adapter import UIStatusAdapter
from src_refactored.presentation.main_window.controllers.drag_drop_coordination_controller import (
    DragDropCoordinationController,
)
from src_refactored.presentation.main_window.controllers.drag_drop_event_controller import (
    DragDropEventController,
)
from src_refactored.presentation.main_window.controllers.settings_controller import (
    SettingsController,
)
from src_refactored.presentation.main_window.controllers.tray_coordination_controller import (
    TrayCoordinationController,
)
from src_refactored.presentation.main_window.controllers.ui_construction_controller import (
    UIConstructionController,
)
from src_refactored.presentation.main_window.controllers.ui_state_controller import (
    UIStateController,
)
from src_refactored.presentation.main_window.controllers.window_minimize_controller import (
    WindowMinimizeController,
)
from src_refactored.presentation.shared.ui_theme_service import UIThemeService
from src_refactored.presentation.system.user_notification_service import (
    QMessageBoxNotificationService,
)


class IConfigurationService(Protocol):
    """Protocol for configuration service dependency."""
    def get_value(self, key: str, default: str | None = None) -> str | None: ...


class IResourceService(Protocol):
    """Protocol for resource service dependency."""
    def get_resource_path(self, relative_path: str) -> str: ...


class IKeyboardService(Protocol):
    """Protocol for keyboard service dependency."""
    def register_hotkey(self, key_combination: str, callback) -> None: ...
    def unregister_hotkey(self, key_combination: str) -> None: ...
    def set_recording_callback(self, callback) -> None: ...
    def start_monitoring(self) -> None: ...
    def stop_monitoring(self) -> None: ...


class MainWindow(QMainWindow):
    """Properly architected main window following DDD principles.
    
    This class acts as a composition root that:
    1. Sets up dependency injection
    2. Coordinates between components and controllers
    3. Delegates business logic to application services
    4. Keeps UI concerns separate from business logic
    """
    
    def __init__(
        self,
        configuration_service: IConfigurationService,
        resource_service: IResourceService,
        keyboard_service: IKeyboardService,
        logger_service: LoggingPort,
        main_window_controller: MainWindowController,
        system_tray_adapter=None,  # Will be injected from main.py
        drag_drop_adapter=None,  # Will be injected from main.py
    ):
        super().__init__()
        
        # Core dependencies
        self._config = configuration_service
        self._resources = resource_service
        self._keyboard = keyboard_service
        self._logger = logger_service
        self._controller = main_window_controller
        self._system_tray_adapter = system_tray_adapter
        self._drag_drop_adapter = drag_drop_adapter
        
        # Load configuration
        self._load_configuration()
        
        # Set up UI infrastructure
        self._setup_window_properties()
        self._setup_theme()
        
        # Build UI components via controller (SoC)
        self._build_ui_via_controller()

        # Create event-forwarding controllers (SoC) that other setup depends on
        self._dragdrop_event_controller = DragDropEventController(
            coordinator=None,  # will set inside _setup_controllers if available
            logger=self._logger,
        )

        # Set up controllers (may wire the drag/drop event controller)
        self._setup_controllers()

        # Create minimize controller after tray is available
        self._minimize_controller = WindowMinimizeController(
            tray_notifier=self._tray_controller,
            logger=self._logger,
        )
        
        # Initialize services
        self._initialize_services()
        
        self._logger.log_info("Main window initialization completed")

        # Create a hotkey proxy after initialization for thread-safe UI updates
        class _HotkeyProxy(QObject):
            hotkeyEvent = pyqtSignal(bool)  # noqa: N815 - Qt signal naming convention

        self._hotkey_proxy = _HotkeyProxy()
        self._hotkey_proxy.hotkeyEvent.connect(self._handle_hotkey_event)
    
    def _load_configuration(self) -> None:
        """Load application configuration."""
        self._recording_key = self._config.get_value("rec_key", "F9")
        self._enable_sound = self._config.get_value("recording_sound_enabled", "True") == "True"
        self._sound_path = self._config.get_value(
            "sound_file_path", 
            self._resources.get_resource_path("resources/splash.mp3"),
        )
        
        # Query hardware capabilities via application use case and injected port
        try:
            from src_refactored.application.main_window.queries.get_hardware_capabilities_use_case import (
                GetHardwareCapabilitiesUseCase,
            )
            # Expect composition root to inject or make available a hardware port via controller
            # Fallback: safe False if not available
            hw_port = getattr(self._controller, "hardware_capabilities_port", None)
            self._has_hw_acceleration = (
                GetHardwareCapabilitiesUseCase(hw_port).execute().has_gpu
                if hw_port is not None
                else False
            )
        except Exception:
            self._has_hw_acceleration = False
    
    # Hardware acceleration check moved to a dedicated use case/port
    
    def _setup_window_properties(self) -> None:
        """Set up basic window properties."""
        self.setWindowTitle("WinSTT")
        self.setFixedSize(400, 220)
        
        # Set window icon
        icon_path = self._resources.get_resource_path("resources/Windows 1 Theta.png")
        if Path(icon_path).exists():
            self.setWindowIcon(QIcon(icon_path))
        
        # Create central widget
        self.centralwidget = QWidget(parent=self)
        self.setCentralWidget(self.centralwidget)
        
        # Enable drag and drop
        self.setAcceptDrops(True)
    
    def _setup_theme(self) -> None:
        """Set up application theme."""
        # Create theme service
        self._theme = UIThemeService()
        
        # Set up dark theme palette
        palette = QPalette()
        dark_color = QColor(20, 27, 31)
        brush = QBrush(dark_color)
        brush.setStyle(Qt.BrushStyle.SolidPattern)
        
        palette.setBrush(QPalette.ColorGroup.Active, QPalette.ColorRole.Window, brush)
        palette.setBrush(QPalette.ColorGroup.Inactive, QPalette.ColorRole.Window, brush)
        palette.setBrush(QPalette.ColorGroup.Disabled, QPalette.ColorRole.Window, brush)
        
        self.setPalette(palette)
    
    def _build_ui_via_controller(self) -> None:
        """Build UI via a dedicated construction controller for stricter SoC."""
        ui_builder_controller = UIConstructionController(self._logger)
        built = ui_builder_controller.build(
            parent_widget=self.centralwidget,
            resources=self._resources,
            theme_service=self._theme,
            recording_key=self._recording_key,
            has_hw_acceleration=self._has_hw_acceleration,
            on_settings_clicked=self._handle_settings_click,
        )

        self._status_display = built.status_display
        self._progress_indicator = built.progress_indicator
        self._visualization_renderer = built.visualization_renderer

        # Set up UI status adapter for the controller
        self._ui_status_adapter = UIStatusAdapter(
            status_label=self._status_display.get_status_label(),
            progress_bar=self._progress_indicator.get_progress_bar(),
            logger=self._logger,
        )
    
    def _setup_controllers(self) -> None:
        """Set up presentation controllers."""
        # UI State Controller  
        self._ui_controller = UIStateController(
            progress_indicator=self._progress_indicator,
            visualization_renderer=self._visualization_renderer,
            logger=self._logger,
        )
        
        # System Tray Coordination Controller (using proper DDD architecture)
        if self._system_tray_adapter:
            self._tray_controller = TrayCoordinationController(
                tray_port=self._system_tray_adapter,
                resource_service=self._resources,
                logger=self._logger,
            )
            self._tray_controller.setup_system_tray(
                show_window_callback=self._show_window,
                settings_callback=self._handle_settings_click,
                exit_callback=self._close_app,
            )
        else:
            self._tray_controller = None
            if self._logger:
                self._logger.log_warning("System tray adapter not provided, tray functionality disabled")
        
        # Drag & Drop Coordination Controller (using proper DDD architecture)
        if self._drag_drop_adapter:
            self._drag_drop_controller = DragDropCoordinationController(
                drag_drop_port=self._drag_drop_adapter,
                main_window_controller=self._controller,
                ui_controller=self._ui_controller,
                logger=self._logger,
            )
            # Setup drag drop for main window
            self._drag_drop_controller.setup_main_window_drag_drop(self)
            # Wire event forwarding controller
            self._dragdrop_event_controller.coordinator = self._drag_drop_controller
        else:
            self._drag_drop_controller = None
            if self._logger:
                self._logger.log_warning("Drag drop adapter not provided, drag drop functionality disabled")
        
        # Settings Controller
        self._settings_controller = SettingsController(
            parent=self,
            config_service=self._config,
            keyboard_service=self._keyboard,
            status_display=self._status_display,
            logger=self._logger,
            user_notifications=QMessageBoxNotificationService(),
        )
    
    def _initialize_services(self) -> None:
        """Initialize services and connect everything together."""
        # Connect UI status adapter to main window controller via setter to avoid private access
        try:
            self._controller.set_ui_status_port(self._ui_status_adapter)
        except Exception:
            # Backward-compatible fallback if setter not available
            self._controller._ui_status = self._ui_status_adapter  # noqa: SLF001
        
        # Set up keyboard monitoring through adapter (SoC)
        # Marshal callbacks from keyboard thread to UI thread via Qt signal
        self._keyboard.set_recording_callback(lambda pressed: self._hotkey_proxy.hotkeyEvent.emit(pressed))
        self._keyboard.register_hotkey(self._recording_key, lambda: None)
        self._keyboard.start_monitoring()
        
        # Set initial status
        self._status_display.update_status_text("Ready for transcription")
        
        self._logger.log_info(f"Services initialized with recording key: {self._recording_key}")
    
    def _handle_hotkey_event(self, is_pressed: bool) -> None:
        """Handle hotkey press/release events."""
        from src_refactored.application.main_window_coordination import HotkeyRecordingRequest
        
        try:
            # Log the hotkey event for debugging
            self._logger.log_debug(f"Hotkey event: pressed={is_pressed}, key={self._recording_key}")
            
            # Delegate business logic to controller
            request = HotkeyRecordingRequest(
                hotkey_name=self._recording_key,
                is_pressed=is_pressed,
            )
            success = self._controller.handle_hotkey_recording(request)
            
            # Log controller response for debugging
            self._logger.log_debug(f"Controller response: success={success}")
            
            # CRITICAL: Always handle UI state explicitly based on hotkey action and success
            if is_pressed:
                # Hotkey PRESSED
                if success:
                    # Only show recording UI if the controller succeeded (device available, etc.)
                    self._ui_controller.start_recording_ui(
                        enable_sound=self._enable_sound,
                        sound_path=self._sound_path,
                    )
                    self._logger.log_debug("Started recording UI (device available)")
                else:
                    # Controller failed (no device, etc.) - ensure no recording UI
                    self._ui_controller.stop_recording_ui()
                    self._logger.log_debug("Recording start failed - stopped recording UI")
            else:
                # Hotkey RELEASED - always stop recording UI regardless of success
                self._ui_controller.stop_recording_ui()
                self._logger.log_debug("Hotkey released - stopped recording UI")
                # Note: Transcription UI is handled by the controller via status messages
        
        except Exception as e:
            self._logger.log_error(f"Error handling hotkey event: {e}")
            # On any error, ensure we stop recording UI to avoid stuck state
            self._ui_controller.stop_recording_ui()
    
    def _handle_settings_click(self) -> None:
        """Handle settings button click."""
        self._settings_controller.open_settings()
    
    def _show_window(self) -> None:
        """Show and activate the main window."""
        self.show()
        self.raise_()
        self.activateWindow()
    
    def _close_app(self) -> None:
        """Close the application."""
        try:
            self._keyboard.stop_monitoring()
            self._logger.log_info("Application closing")
            # Delegate quitting to the UI application adapter if available
            app_adapter = getattr(self._controller, "ui_application", None)
            if app_adapter and hasattr(app_adapter, "quit"):
                app_adapter.quit()
            else:
                # Fallback: import only here to avoid hard dependency
                from PyQt6.QtWidgets import QApplication
                QApplication.quit()
        except Exception as e:
            self._logger.log_error(f"Error closing application: {e}")
    
    def closeEvent(self, event) -> None:
        """Forward close to minimize controller (SoC)."""
        self._minimize_controller.handle_close_event(self, event)
    
    def dragEnterEvent(self, event) -> None:
        """Forward drag enter to dedicated controller."""
        self._dragdrop_event_controller.handle_drag_enter(event)
    
    def dropEvent(self, event) -> None:
        """Forward drop to dedicated controller."""
        self._dragdrop_event_controller.handle_drop(event)
