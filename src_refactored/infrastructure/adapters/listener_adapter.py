"""Listener Service Adapter.

This adapter bridges the real ListenerWorkerService (which uses PyQt threading)
with the simple IListenerService protocol expected by the presentation layer.
"""

from PyQt6.QtCore import QThread

from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.infrastructure.audio.listener_worker_service import ListenerWorkerService


class ListenerServiceAdapter:
    """Adapter that bridges ListenerWorkerService with IListenerService protocol."""
    
    def __init__(self, real_service: ListenerWorkerService, logger: LoggingPort | None = None):
        self._service = real_service
        self._logger = logger
        self._worker_thread: QThread | None = None
        self._is_listening = False
        
        # Connect to service signals for state tracking
        self._service.initialized.connect(self._on_initialized)
        self._service.recording_started.connect(self._on_recording_started)
        self._service.recording_stopped.connect(self._on_recording_stopped)
        self._service.error.connect(self._on_error)
        self._service.terminate_signal.connect(self._on_terminated)
    
    def start_listening(self) -> None:
        """Start the listener service in a worker thread."""
        if not self._is_listening:
            try:
                # Create and start worker thread
                self._worker_thread = QThread()
                self._service.moveToThread(self._worker_thread)
                self._worker_thread.started.connect(self._service.run)
                self._worker_thread.start()
                
                if self._logger:
                    self._logger.log_info("Starting listener service")
                    
            except Exception as e:
                if self._logger:
                    self._logger.log_error("Failed to start listener service", exception=e)
                
    def stop_listening(self) -> None:
        """Stop the listener service and clean up worker thread."""
        if self._is_listening or self._worker_thread:
            try:
                # Signal the service to stop
                self._service.stop()
                
                # Wait for thread to finish
                if self._worker_thread:
                    self._worker_thread.quit()
                    self._worker_thread.wait(5000)  # Wait up to 5 seconds
                    self._worker_thread = None
                
                self._is_listening = False
                
                if self._logger:
                    self._logger.log_info("Stopped listener service")
                    
            except Exception as e:
                if self._logger:
                    self._logger.log_error("Error stopping listener service", exception=e)
    
    def is_listening(self) -> bool:
        """Check if the listener service is currently listening."""
        return self._is_listening and self._service.is_running()
    
    # Signal handlers to track service state
    def _on_initialized(self) -> None:
        """Handle service initialization."""
        self._is_listening = True
        if self._logger:
            self._logger.log_info("Listener service initialized")
    
    def _on_recording_started(self) -> None:
        """Handle recording started."""
        if self._logger:
            self._logger.log_info("Recording started")
    
    def _on_recording_stopped(self) -> None:
        """Handle recording stopped."""
        if self._logger:
            self._logger.log_info("Recording stopped")
    
    def _on_error(self, error_msg: str) -> None:
        """Handle service errors."""
        if self._logger:
            self._logger.log_error(f"Listener service error: {error_msg}")
    
    def _on_terminated(self) -> None:
        """Handle service termination."""
        self._is_listening = False
        if self._logger:
            self._logger.log_info("Listener service terminated")
