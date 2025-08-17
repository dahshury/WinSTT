"""Refactored Main Window for WinSTT.

This is a properly architected main window that follows DDD/hexagonal architecture
principles with proper separation of concerns.
"""

from contextlib import suppress
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from PyQt6.QtCore import QObject, Qt, pyqtSignal
from PyQt6.QtGui import QBrush, QColor, QIcon, QPalette
from PyQt6.QtWidgets import QMainWindow, QWidget

from src.application.main_window_coordination import MainWindowController
from src.domain.common.ports.logging_port import LoggingPort
from src.presentation.adapters.ui_status_adapter import UIStatusAdapter
from src.presentation.main_window.controllers.drag_drop_coordination_controller import (
    DragDropCoordinationController,
)
from src.presentation.main_window.controllers.drag_drop_event_controller import (
    DragDropEventController,
)
from src.presentation.main_window.controllers.settings_controller import (
    SettingsController,
)
from src.presentation.main_window.controllers.tray_coordination_controller import (
    TrayCoordinationController,
)
from src.presentation.main_window.controllers.ui_construction_controller import (
    UIConstructionController,
)
from src.presentation.main_window.controllers.ui_state_controller import (
    UIStateController,
)
from src.presentation.main_window.controllers.window_minimize_controller import (
    WindowMinimizeController,
)
from src.presentation.shared.ui_theme_service import UIThemeService
from src.presentation.system.user_notification_service import (
    QMessageBoxNotificationService,
)

if TYPE_CHECKING:
    from collections.abc import Callable


class IConfigurationService(Protocol):
    """Protocol for configuration service dependency."""
    def get_value(self, key: str, default: str | None = None) -> str | None: ...


class IResourceService(Protocol):
    """Protocol for resource service dependency."""
    def get_resource_path(self, relative_path: str) -> str: ...


class IKeyboardService(Protocol):
    """Protocol for keyboard service dependency."""
    def register_hotkey(self, key_combination: str, callback: "Callable[[], None]") -> None: ...
    def unregister_hotkey(self, key_combination: str) -> None: ...
    def set_recording_callback(self, callback: "Callable[[bool], None]") -> None: ...
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

        # Optional controllers typed as Optional
        self._tray_controller: TrayCoordinationController | None = None
        self._drag_drop_controller: DragDropCoordinationController | None = None
        
        # Load configuration
        self._load_configuration()
        
        # Set up UI infrastructure
        self._setup_window_properties()
        self._setup_theme()
        
        # Build UI components via controller (SoC)
        self._build_ui_via_controller()

        # Create event-forwarding controllers (SoC) that other setup depends on
        self._dragdrop_event_controller: DragDropEventController = DragDropEventController(
            coordinator=None,  # will set inside _setup_controllers if available
            logger=self._logger,
        )

        # Set up controllers (may wire the drag/drop event controller)
        self._setup_controllers()

        # Create minimize controller after tray is available
        self._minimize_controller: WindowMinimizeController = WindowMinimizeController(
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
        rec_key = self._config.get_value("rec_key", "F9")
        self._recording_key = rec_key or "F9"
        enable_sound_value = self._config.get_value("recording_sound", "True")
        self._enable_sound = str(enable_sound_value).strip().lower() in {"true", "1", "yes"}
        # Get configured sound path; support both alias forms and absolute paths
        configured_sound = self._config.get_value("sound_path", "@resources/splash.wav")
        try:
            resolved_sound = (
                configured_sound
                if Path(str(configured_sound)).exists()
                else self._resources.get_resource_path(str(configured_sound))
            )
        except Exception:
            resolved_sound = ""
        if not resolved_sound:
            with suppress(Exception):
                resolved_sound = self._resources.get_resource_path("@resources/splash.wav")
        self._sound_path = resolved_sound
        
        # Query hardware capabilities via application use case and injected port
        try:
            from src.application.main_window.queries.get_hardware_capabilities_use_case import (
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
        icon_path = self._resources.get_resource_path("@resources/Windows 1 Theta.png")
        if Path(icon_path).exists():
            self.setWindowIcon(QIcon(icon_path))
        
        # Create central widget
        self.centralwidget = QWidget(parent=self)
        self.setCentralWidget(self.centralwidget)
        
        # Drag and drop is handled on the central widget via the drag/drop service
        # Ensure the window itself does not intercept drag events
        self.setAcceptDrops(False)
    
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
            # Inject a simple WAV sound player so UI beeps work independently of ATT service
            sound_player_service=self._create_sound_player(),
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
                exit_callback=self.close_app,
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
            resource_service=self._resources,
        )

    def _create_sound_player(self):
        """Create and return a sound player adapter instance."""
        try:
            from src.infrastructure.adapters.sound_player_adapter import SoundPlayerAdapter
            return SoundPlayerAdapter()
        except Exception:
            return None
    
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
        from src.application.main_window_coordination import HotkeyRecordingRequest
        
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
                    # Controller failed (e.g., models not ready). Provide audible feedback if enabled.
                    if self._enable_sound and self._sound_path:
                        self._ui_controller.play_notification_sound(self._sound_path)
                    # Ensure no recording UI
                    self._ui_controller.stop_recording_ui()
                    self._logger.log_debug("Recording start failed - provided feedback beep and stopped recording UI")
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
        """Deprecated: use close_app(). Left for backward compatibility."""
        self.close_app()

    def close_app(self) -> None:
        """Close the application and cleanup resources (tray, keyboard)."""
        try:
            # Stop keyboard monitoring first
            with suppress(Exception):
                self._keyboard.stop_monitoring()
            if self._logger:
                self._logger.log_info("Application closing")

            # Explicitly cleanup visualization renderer to avoid pyqtgraph atexit recursion
            try:
                if hasattr(self, "_visualization_renderer") and self._visualization_renderer is not None:
                    cleanup_method = getattr(self._visualization_renderer, "cleanup", None)
                    if callable(cleanup_method):
                        cleanup_method()
            except Exception:
                pass

            # Clean up tray resources proactively to avoid late signal issues
            try:
                if self._tray_controller is not None:
                    self._tray_controller.cleanup()
                elif self._system_tray_adapter is not None and hasattr(self._system_tray_adapter, "cleanup"):
                    self._system_tray_adapter.cleanup()
            except Exception:
                # Best effort
                pass

            # Delegate quitting to the UI application adapter if available
            app_adapter = getattr(self._controller, "ui_application", None)
            if app_adapter and hasattr(app_adapter, "quit"):
                app_adapter.quit()
            else:
                # Fallback: import only here to avoid hard dependency
                from PyQt6.QtWidgets import QApplication
                QApplication.quit()

            # Ensure quit is processed even if a modal menu/dialog was open
            with suppress(Exception):
                from PyQt6.QtCore import QTimer
                from PyQt6.QtWidgets import QApplication as _QApp
                QTimer.singleShot(100, lambda: _QApp.instance() and _QApp.instance().quit())
            # Last resort: hard exit after a short delay if the event loop won't terminate
            with suppress(Exception):
                import os as _os

                from PyQt6.QtCore import QTimer as _QTimer
                _QTimer.singleShot(1500, lambda: _os._exit(0))
        except Exception as e:
            if self._logger:
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
