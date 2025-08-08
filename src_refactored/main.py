#!/usr/bin/env python3
"""Production Main Entry Point for WinSTT.

This is the single, production-ready main entry point that uses the existing
hexagonal architecture composition root for dependency injection.
"""

import logging
import os
import sys
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

from PyQt6.QtCore import QObject, pyqtSignal
from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import QApplication, QMessageBox

# Import specific services from hexagonal architecture to avoid metaclass conflicts
from src_refactored.infrastructure.adapters.logging_adapter import PythonLoggingAdapter

# Create a configuration adapter that bridges the existing ConfigurationService with the protocol



class WinSTTApplication:
    """Main application class that coordinates everything using the hexagonal architecture."""
    
    def __init__(self):
        # Use specific services from hexagonal architecture
        self.logger = PythonLoggingAdapter()
        
        # Use proper adapters from infrastructure layer
        from src_refactored.infrastructure.adapters.configuration_adapter import (
            ConfigurationServiceAdapter,
        )
        self.configuration_service = ConfigurationServiceAdapter("settings.json", self.logger)
        
        # Simple single instance check without complex dependencies
        self.single_instance_service = None
        self.app: QApplication | None = None
        self.main_window = None
        self.bridge_adapter = None
    

    
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
            
            # Set application icon using resource service
            try:
                from src_refactored.infrastructure.adapters.resource_adapter import (
                    ResourceServiceAdapter,
                )
                resource_service = ResourceServiceAdapter(self.logger)
                icon_path = resource_service.get_resource_path("resources/Windows 1 Theta.ico")
                if os.path.exists(icon_path):
                    self.app.setWindowIcon(QIcon(icon_path))
                else:
                    # Fallback to PNG version
                    icon_path = resource_service.get_resource_path("resources/Windows 1 Theta.png")
                    if os.path.exists(icon_path):
                        self.app.setWindowIcon(QIcon(icon_path))
            except Exception as e:
                self.logger.log_warning(f"Could not set application icon: {e}")
            
            # Create main window with proper dependency injection
            # Import main window
            # Use proper resource adapter from infrastructure layer  
            from src_refactored.infrastructure.adapters.resource_adapter import (
                ResourceServiceAdapter,
            )
            from src_refactored.presentation.main_window.main_window import MainWindow
            resource_service = ResourceServiceAdapter(self.logger)
            
            # Use real hardcore implementations from the refactored architecture
            # Create real keyboard service with adapter
            from src_refactored.infrastructure.adapters.keyboard_adapter import (
                KeyboardServiceAdapter,
            )
            from src_refactored.infrastructure.audio.keyboard_service import (
                KeyboardService,
                KeyboardServiceConfiguration,
            )
            
            keyboard_config = KeyboardServiceConfiguration(
                enable_key_normalization=True,
                track_key_states=True,
                enable_event_logging=True,
            )
            real_keyboard_service = KeyboardService(keyboard_config)
            keyboard_service = KeyboardServiceAdapter(real_keyboard_service, self.logger)
            
            # Create real VAD and transcription adapters
            from src_refactored.infrastructure.adapters.transcription_adapter import (
                SimpleTranscriptionAdapter,
                SimpleVADAdapter,
            )
            
            vad_service = SimpleVADAdapter(self.logger)
            transcription_model = SimpleTranscriptionAdapter(self.logger)
            
            # Get recording key from config
            recording_key = self.configuration_service.get_value("rec_key", "F10")
            
            # Create audio recording use cases and supporting services
            from src_refactored.application.audio_recording import (
                GetRecordingStatusUseCase,
                StartRecordingUseCase,
                StopRecordingUseCase,
            )
            from src_refactored.application.main_window_coordination import MainWindowController

            # Create audio recorder entity
            from src_refactored.domain.audio.entities import AudioRecorder
            from src_refactored.infrastructure.adapters.audio_device_adapter import (
                AudioDeviceAdapter,
            )
            from src_refactored.infrastructure.adapters.audio_to_text_bridge_adapter import (
                AudioToTextBridgeAdapter,
            )
            audio_recorder = AudioRecorder()  # Uses defaults
            
            # Create the bridge adapter that unifies the old AudioToText with the new DDD system
            # Create text paste adapter (infrastructure)
            from src_refactored.infrastructure.adapters.text_paste_adapter import (
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
            from src_refactored.infrastructure.adapters.qt_system_tray_adapter import (
                QtSystemTrayAdapter,
            )
            system_tray_adapter = QtSystemTrayAdapter(
                resource_service=resource_service,
                logger=self.logger,
            )
            
            # Create drag drop adapter (proper DDD architecture)
            from src_refactored.infrastructure.adapters.qt_drag_drop_adapter import (
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
                    if txt:
                        from src_refactored.domain.common.ports.ui_status_port import (
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
                        message = StatusMessage(
                            text=txt,
                            type=status_type,
                            filename=filename,
                            progress_value=percentage,
                            show_progress_bar=percentage is not None,
                            duration=StatusDuration.PERSISTENT if hold else StatusDuration.NORMAL,
                            auto_clear=not hold,
                        )
                        self.main_window._ui_status_adapter.show_status(message)

                dispatcher.emitStatus.connect(_on_emit_status)

                # Set the UI callback in the bridge adapter to post across threads
                def ui_status_callback(txt: str | None, filename: str | None, percentage: float | None, hold: bool | None, reset: bool | None):
                    dispatcher.emitStatus.emit(txt, filename, percentage, hold, reset)

                self.bridge_adapter._ui_callback = ui_status_callback
            
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
            # Cleanup bridge adapter first
            if self.bridge_adapter:
                self.bridge_adapter.cleanup()
            
            if self.main_window:
                self.main_window.close_app()
            
            # Cleanup single instance resources
            if self.single_instance_service:
                self.single_instance_service.close()
            
            self.logger.log_info("Application shutdown complete")
            
        except Exception as e:
            self.logger.log_error("Error during shutdown", exception=e)


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