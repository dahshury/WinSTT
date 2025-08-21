#!/usr/bin/env python3
"""Production Main Entry Point for WinSTT.

This is the single, production-ready main entry point that uses the existing
hexagonal architecture composition root for dependency injection.
"""

import logging
import os
import sys
from contextlib import suppress
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

# Suppress warnings and configure environment
os.environ["PYGAME_HIDE_SUPPORT_PROMPT"] = "hide"
os.environ["PYTHONWARNINGS"] = "ignore::DeprecationWarning,ignore::SyntaxWarning,ignore::UserWarning"
os.environ["QT_LOGGING_RULES"] = "qt.gui.imageio=false;*.debug=false;qt.qpa.*=false"

# Suppress transformers warnings
logging.getLogger("transformers").setLevel(logging.ERROR)

from PyQt6.QtCore import QObject, QTimer, pyqtSignal
from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import QApplication, QMessageBox

# Best-effort: disable pyqtgraph's atexit cleanup early to prevent
# RecursionError in ViewBox.quit during interpreter shutdown
try:  # pragma: no cover - best effort only
    import pyqtgraph as _pg  # type: ignore[import-not-found]
    if hasattr(_pg, "setConfigOptions"):
        _pg.setConfigOptions(exitCleanup=False)
    elif hasattr(_pg, "setConfigOption"):
        _pg.setConfigOption("exitCleanup", False)
except Exception:
    pass

# Import specific services from hexagonal architecture to avoid metaclass conflicts
from src.infrastructure.adapters.logging_adapter import PythonLoggingAdapter

# Create a configuration adapter that bridges the existing ConfigurationService with the protocol



class WinSTTApplication:
    """Main application class that coordinates everything using the hexagonal architecture."""
    
    def __init__(self):
        # Use specific services from hexagonal architecture
        self.logger = PythonLoggingAdapter()
        
        # Use proper adapters from infrastructure layer
        from src.infrastructure.adapters.configuration_adapter import (
            ConfigurationServiceAdapter,
        )
        self.configuration_service = ConfigurationServiceAdapter("settings.json", self.logger)
        
        # Simple single instance check without complex dependencies
        self.single_instance_service = None
        self.app: QApplication | None = None
        self.main_window = None
        self.bridge_adapter = None
        self._sigint_timer: QTimer | None = None
        self._is_shutting_down: bool = False
        self.transcription_model = None
    

    
    def _check_single_instance(self) -> bool:
        """Simple single instance check."""
        import socket
        try:
            self.single_instance_service = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.single_instance_service.bind(("localhost", 47123))
            self.single_instance_service.listen(1)
            return False  # No other instance running
        except OSError:
            # Another instance is running
            if self.single_instance_service:
                self.single_instance_service.close()
                self.single_instance_service = None
            return True
    
    def run(self) -> int:
        """Run the application."""
        try:
            # Check for single instance
            if self._check_single_instance():
                self.logger.log_info("Another instance is already running")
                QMessageBox.information(None, "WinSTT", "Another instance is already running.")
                return 0
            
            # Create Qt application
            self.app = QApplication(sys.argv)
            self.app.setQuitOnLastWindowClosed(False)

            # Ensure Ctrl+C (SIGINT) terminates the Qt event loop and triggers cleanup
            self._install_signal_handlers()

            # Ensure we always cleanup on normal quit paths as well
            with suppress(Exception):
                self.app.aboutToQuit.connect(self._on_about_to_quit)

            # Disable pyqtgraph's atexit cleanup early to avoid RecursionError on shutdown
            self._disable_pyqtgraph_exit_cleanup()
            
            # Set application icon using resource service
            try:
                from src.infrastructure.adapters.resource_adapter import (
                    ResourceServiceAdapter,
                )
                resource_service = ResourceServiceAdapter(self.logger)
                icon_path = resource_service.get_resource_path("@resources/Windows 1 Theta.png")
                if os.path.exists(icon_path):
                    self.app.setWindowIcon(QIcon(icon_path))
                else:
                    # Fallback to PNG version
                    icon_path = resource_service.get_resource_path("@resources/Windows 1 Theta.png")
                    if os.path.exists(icon_path):
                        self.app.setWindowIcon(QIcon(icon_path))
            except Exception as e:
                self.logger.log_warning(f"Could not set application icon: {e}")
            
            # Create main window with proper dependency injection
            # Import main window
            # Use proper resource adapter from infrastructure layer  
            from src.infrastructure.adapters.resource_adapter import (
                ResourceServiceAdapter,
            )
            from src.presentation.main_window.main_window import MainWindow
            resource_service = ResourceServiceAdapter(self.logger)
            
            # Use real hardcore implementations from the refactored architecture
            # Create real keyboard service with adapter
            from src.infrastructure.adapters.keyboard_adapter import (
                KeyboardServiceAdapter,
            )
            from src.infrastructure.audio.keyboard_service import (
                KeyboardService,
                KeyboardServiceConfiguration,
            )
            
            keyboard_config = KeyboardServiceConfiguration(
                enable_key_normalization=True,
                track_key_states=True,
                enable_event_logging=True,
                suppress_hotkeys=False,  # Avoid OS suppression to work without elevated rights
            )
            real_keyboard_service = KeyboardService(keyboard_config)
            keyboard_service = KeyboardServiceAdapter(real_keyboard_service, self.logger)
            
            # Create real VAD and transcription adapters
            from src.infrastructure.adapters.transcription_adapter import (
                SimpleTranscriptionAdapter,
                SimpleVADAdapter,
            )
            
            vad_service = SimpleVADAdapter(self.logger)
            transcription_model = SimpleTranscriptionAdapter(self.logger)
            self.transcription_model = transcription_model
            
            # Get recording key from config
            recording_key = self.configuration_service.get_value("rec_key", "F10")
            
            # Create audio recording use cases and supporting services
            from src.application.audio_recording import (
                GetRecordingStatusUseCase,
                StartRecordingUseCase,
                StopRecordingUseCase,
            )
            from src.application.main_window_coordination import MainWindowController

            # Create audio recorder entity
            from src.domain.audio.entities import AudioRecorder
            from src.infrastructure.adapters.audio_device_adapter import (
                AudioDeviceAdapter,
            )
            from src.infrastructure.adapters.audio_to_text_bridge_adapter import (
                AudioToTextBridgeAdapter,
            )
            audio_recorder = AudioRecorder()  # Uses defaults
            
            # Create the bridge adapter that unifies the old AudioToText with the new DDD system
            # Create text paste adapter (infrastructure)
            from src.infrastructure.adapters.text_paste_adapter import (
                ClipboardTextPasteAdapter,
            )
            text_paste_adapter = ClipboardTextPasteAdapter(self.logger)

            self.bridge_adapter = AudioToTextBridgeAdapter(
                audio_recorder=audio_recorder,
                transcription_adapter=transcription_model,
                vad_adapter=vad_service,
                recording_key=recording_key,
                logger=self.logger,
                ui_callback=None,  # Will be set after main window creation
                text_paste_port=text_paste_adapter,
            )
            
            # Create use cases with shared audio recorder
            start_recording_use_case = StartRecordingUseCase(audio_recorder)
            stop_recording_use_case = StopRecordingUseCase(audio_recorder)
            recording_status_use_case = GetRecordingStatusUseCase(audio_recorder)
            
            # Create audio device service
            audio_device_service = AudioDeviceAdapter(self.logger)
            
            # Main window controller will get UI status service after main window creation
            main_window_controller = MainWindowController(
                start_recording_use_case=start_recording_use_case,
                stop_recording_use_case=stop_recording_use_case,
                recording_status_use_case=recording_status_use_case,
                ui_status_service=None,  # Will be set after main window creation
                audio_device_service=audio_device_service,
                logger=self.logger,
                audio_text_bridge=self.bridge_adapter,
            )
            
            # Create system tray adapter (proper DDD architecture)
            from src.infrastructure.adapters.qt_system_tray_adapter import (
                QtSystemTrayAdapter,
            )
            system_tray_adapter = QtSystemTrayAdapter(
                resource_service=resource_service,
                logger=self.logger,
            )
            
            # Create drag drop adapter (proper DDD architecture)
            from src.infrastructure.adapters.qt_drag_drop_adapter import (
                QtDragDropAdapter,
            )
            drag_drop_adapter = QtDragDropAdapter(logger=self.logger)
            
            # Create main window with proper DDD architecture
            # Use the real main window (single source of truth)
            
            self.main_window = MainWindow(
                configuration_service=self.configuration_service,
                resource_service=resource_service,
                keyboard_service=keyboard_service,
                logger_service=self.logger,
                main_window_controller=main_window_controller,
                system_tray_adapter=system_tray_adapter,
                drag_drop_adapter=drag_drop_adapter,
            )
            
            # Set the UI status service reference in the controller after main window is created
            if hasattr(self.main_window, "_ui_status_adapter"):
                main_window_controller._ui_status = self.main_window._ui_status_adapter
                # Thread-safe UI status dispatcher to marshal callbacks to Qt main thread
                class _UiStatusDispatcher(QObject):
                    emitStatus = pyqtSignal(object, object, object, object, object)

                dispatcher = _UiStatusDispatcher()

                def _on_emit_status(txt, filename, percentage, hold, reset):
                    # Reset request: clear transient status and optionally progress
                    if reset:
                        from src.domain.common.ports.ui_status_port import StatusClearRequest
                        self.main_window._ui_status_adapter.clear_status(StatusClearRequest(clear_progress=True, reset_to_default=False))
                        # Ensure any transcribing UI state is stopped
                        try:
                            if hasattr(self.main_window, "_ui_controller") and self.main_window._ui_controller is not None:
                                self.main_window._ui_controller.stop_transcribing_ui()
                        except Exception:
                            pass
                        return
                    if txt:
                        from src.domain.common.ports.ui_status_port import (
                            StatusDuration,
                            StatusMessage,
                            StatusType,
                        )
                        lower = txt.lower().strip()
                        # Device errors must map to ERROR, not RECORDING
                        if "no recording device" in lower or "connect a microphone" in lower or "microphone" in lower:
                            status_type = StatusType.ERROR
                        # No speech detected should be WARNING
                        elif "no speech detected" in lower:
                            status_type = StatusType.WARNING
                        # Only treat as RECORDING if it explicitly starts with Recording...
                        elif lower.startswith("recording..."):
                            status_type = StatusType.RECORDING
                        elif lower.startswith("transcribing"):
                            status_type = StatusType.TRANSCRIBING
                        elif "error" in lower or "failed" in lower:
                            status_type = StatusType.ERROR
                        else:
                            status_type = StatusType.INFO
                        # Ensure download progress always shows a bar, even if percent cannot be computed
                        is_downloading = "downloading" in lower
                        show_bar = (percentage is not None) or is_downloading
                        progress_value = int(percentage) if percentage is not None else (0 if is_downloading else None)
                        message = StatusMessage(
                            text=txt,
                            type=status_type,
                            filename=filename,
                            progress_value=progress_value,
                            show_progress_bar=show_bar,
                            duration=StatusDuration.PERSISTENT if hold else StatusDuration.NORMAL,
                            auto_clear=not hold,
                        )
                        self.main_window._ui_status_adapter.show_status(message)

                dispatcher.emitStatus.connect(_on_emit_status)

                # Set the UI callback in the bridge adapter to post across threads
                def ui_status_callback(txt: str | None, filename: str | None, percentage: float | None, hold: bool | None, reset: bool | None):
                    dispatcher.emitStatus.emit(txt, filename, percentage, hold, reset)

                # Also register a global status callback for non-UI components
                try:
                    from src.infrastructure.common.ui_status_dispatch import set_ui_status_callback as _set_cb
                    _set_cb(ui_status_callback)
                except Exception:
                    pass

                self.bridge_adapter._ui_callback = ui_status_callback
                # Provide callback to transcription adapter so model downloads emit progress to UI
                with suppress(Exception):
                    transcription_model.set_ui_status_callback(ui_status_callback)

                # Proactively preload selected onnx-asr model in background so first record isn't required
                with suppress(Exception):
                    transcription_model.preload_models()
            
            # Do NOT start the bridge's own hotkey listener; the app's keyboard service will drive it
            
            # Show the main window
            self.main_window.show()
            
            self.logger.log_info("WinSTT application started successfully")
            
            # Run the application
            return self.app.exec()
            
        except Exception as e:
            self.logger.log_error("Failed to start application", exception=e)
            if self.app:
                QMessageBox.critical(None, "WinSTT Error", f"Failed to start application: {e!s}")
            return 1
    
    def shutdown(self) -> None:
        """Shutdown the application."""
        try:
            self._is_shutting_down = True
            # Cleanup bridge adapter first
            if self.bridge_adapter:
                self.bridge_adapter.cleanup()
            
            # Ensure model downloads/initialization are cancelled
            try:
                if self.transcription_model and hasattr(self.transcription_model, "cleanup"):
                    self.transcription_model.cleanup()
            except Exception:
                pass

            if self.main_window:
                # Public close if available, fallback to internal
                if hasattr(self.main_window, "close_app"):
                    self.main_window.close_app()
                elif hasattr(self.main_window, "_close_app"):
                    self.main_window._close_app()
            
            # Cleanup single instance resources
            if self.single_instance_service:
                self.single_instance_service.close()
            
            self.logger.log_info("Application shutdown complete")
            
        except Exception as e:
            self.logger.log_error("Error during shutdown", exception=e)

        # Ensure the Qt event loop exits (if not already quitting)
        if not self._is_shutting_down:
            try:
                if self.app is not None:
                    self.app.quit()
            except Exception:
                pass

    def _on_about_to_quit(self) -> None:
        """Qt aboutToQuit handler to guarantee cleanup on all exit paths."""
        self._is_shutting_down = True
        with suppress(Exception):
            # Run shutdown without requesting another quit
            self.shutdown()

    def _install_signal_handlers(self) -> None:
        """Install SIGINT/SIGTERM handlers and a heartbeat timer so Python can process signals.
        
        Without a periodic Qt timer, Python's signal handlers may not execute
        while the Qt event loop is running. This makes Ctrl+C reliably terminate
        the app from the terminal.
        """
        import signal

        def _handle_signal(signum, frame):  # noqa: ARG001 - required by signal API
            with suppress(Exception):
                self.logger.log_info(f"Received signal {signum}; shutting down...")
            try:
                self.shutdown()
            finally:
                with suppress(Exception):
                    if self.app is not None:
                        self.app.quit()

        with suppress(Exception):
            signal.signal(signal.SIGINT, _handle_signal)
        with suppress(Exception):
            # SIGTERM may not be available on Windows, guard accordingly
            signal.signal(getattr(signal, "SIGTERM", signal.SIGINT), _handle_signal)

        # Periodic no-op timer so Python can run signal handlers during Qt loop
        with suppress(Exception):
            self._sigint_timer = QTimer()
            self._sigint_timer.setInterval(200)
            self._sigint_timer.timeout.connect(lambda: None)
            self._sigint_timer.start()
        if self._sigint_timer is None:
            # Ensure attribute exists even on failure
            self._sigint_timer = None

    def _disable_pyqtgraph_exit_cleanup(self) -> None:
        """Best-effort: prevent pyqtgraph from running ViewBox.quit at atexit (RecursionError).

        This sets the global config option exitCleanup=False if pyqtgraph is installed.
        """
        with suppress(Exception):
            import pyqtgraph as pg  # type: ignore[import-not-found]
            if hasattr(pg, "setConfigOptions"):
                pg.setConfigOptions(exitCleanup=False)
            elif hasattr(pg, "setConfigOption"):
                pg.setConfigOption("exitCleanup", False)


def main() -> int:
    """Main entry point."""
    try:
        app = WinSTTApplication()
        return app.run()
    except KeyboardInterrupt:
        print("\nApplication interrupted by user")
        return 0
    except Exception as e:
        # Use basic logging for critical startup errors
        try:
            logger = PythonLoggingAdapter()
            logger.log_error("Unhandled exception in main", exception=e)
        except Exception:
            # Fallback to print if logging fails
            print(f"Critical error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())