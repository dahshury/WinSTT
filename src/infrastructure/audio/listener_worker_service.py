"""Listener Worker Infrastructure Service.

This module provides audio listener worker functionality with PyQt threading,
recording management, and cleanup capabilities.
"""

import contextlib
import gc
import logging
from typing import Any

from PyQt6.QtCore import QObject, QThread, pyqtSignal


class ListenerWorkerService(QObject):
    """Audio listener worker with PyQt threading support.
    
    This service manages audio recording lifecycle within PyQt's threading model,
    providing signals for recording state changes and error handling.
    
    Signals:
        transcription_ready: Emitted when transcription is complete
        error: Emitted when listener operations fail
        initialized: Emitted when listener is successfully initialized
        recording_started: Emitted when recording starts
        recording_stopped: Emitted when recording stops
        display_message_signal: Emitted for progress updates
        terminate_signal: Emitted when worker is terminating
    """

    transcription_ready = pyqtSignal(str)
    error = pyqtSignal(str)
    initialized = pyqtSignal()
    recording_started = pyqtSignal()
    recording_stopped = pyqtSignal()
    display_message_signal = pyqtSignal(object,
    object, object, object, object)  # txt, filename, percentage, hold, reset
    terminate_signal = pyqtSignal()

    def __init__(self, model: Any, vad: Any, rec_key: str,
    ):
        """Initialize the listener worker service.
        
        Args:
            model: The transcription model instance
            vad: The VAD instance
            rec_key: The recording key binding
        """
        super().__init__()
        self._running: bool | None = None
        self.rec_key = rec_key
        # The adapter created exposes specific signals/methods; keep as Any for runtime-checked attributes
        self.listener: Any | None = None

        # Store model and VAD for listener creation
        self.model = model
        self.vad = vad

    def _create_listener(self) -> None:
        """Create the PyQt audio listener."""
        # Import here to avoid circular dependencies
        from src.infrastructure.audio.pyqt_audio_adapter import PyQtAudioAdapterService

        # Create the PyQt adapter
        adapter_service = PyQtAudioAdapterService()
        # Wrap bound signal into a callable adapter to satisfy typing
        def _err_cb(*args: Any, **kwargs: Any) -> None:
            with contextlib.suppress(Exception):
                self.display_message_signal.emit(*args)

        self.listener = adapter_service.create_adapter_with_factory(
            self.model, self.vad, self.rec_key, error_callback=_err_cb,
        )

        # Connect signals from the adapter
        if self.listener is not None:
            self.listener.recording_started_signal.connect(self.recording_started.emit)  # type: ignore[attr-defined]
            self.listener.recording_stopped_signal.connect(self.recording_stopped.emit)  # type: ignore[attr-defined]

    def _setup_recording_hooks(self) -> None:
        """Setup recording hooks.
        
        This method is deprecated as state monitoring is now done
        via direct signals from PyQtAudioAdapter.
        """
        # Method kept for backward compatibility but no longer needed

    def run(self) -> None:
        """Run the listener worker.
        
        This method should be called from a worker thread to avoid
        blocking the UI during listener operations.
        """
        try:
            # Create the listener if not already created
            if self.listener is None:
                self._create_listener()

            # Start capturing keys
            if self.listener is not None:
                self.listener.capture_keys(self.rec_key)  # type: ignore[attr-defined]
            self.initialized.emit()
            self._running = True

            # Keep the worker alive
            while self._running:
                QThread.msleep(10)
        except Exception as e:
            error_msg = f"Listener Error: {e}"
            self.error.emit(error_msg)

            # Log the error
            logging.getLogger(__name__).debug(error_msg)
        finally:
            self._cleanup_listener()

    def _cleanup_listener(self) -> None:
        """Clean up listener resources."""
        if self.listener is not None:
            with contextlib.suppress(Exception):
                self.listener.shutdown()  # type: ignore[attr-defined]
            del self.listener
            self.listener = None
        gc.collect()

    def stop(self) -> None:
        """Stop the listener worker."""
        self._running = False
        self.terminate_signal.emit()

    def is_running(self,
    ) -> bool:
        """Check if the listener is running.
        
        Returns:
            True if listener is running, False otherwise
        """
        return self._running is True

    def get_listener(self) -> object | None:
        """Get the listener instance.
        
        Returns:
            The listener instance if created, None otherwise
        """
        return self.listener

    def cleanup(self) -> None:
        """Clean up all resources."""
        self.stop()
        self._cleanup_listener()


class ListenerWorkerManager:
    """High-level manager for listener worker operations.
    
    This manager provides a simplified interface for listener worker
    lifecycle management and recording operations.
    """

    def __init__(self):
        """Initialize the listener worker manager."""
        self._workers: list[ListenerWorkerService] = []

    def create_worker(self, model: Any, vad: Any, rec_key: str,
    ) -> ListenerWorkerService:
        """Create a new listener worker.
        
        Args:
            model: The transcription model instance
            vad: The VAD instance
            rec_key: The recording key binding
            
        Returns:
            A new ListenerWorkerService instance
        """
        worker = ListenerWorkerService(model, vad, rec_key)
        self._workers.append(worker)
        return worker

    def start_worker(self, worker: ListenerWorkerService,
    ) -> None:
        """Start a listener worker.
        
        Args:
            worker: The listener worker to start
        """
        worker.run()

    def stop_worker(self, worker: ListenerWorkerService,
    ) -> None:
        """Stop a listener worker.
        
        Args:
            worker: The listener worker to stop
        """
        worker.stop()

    def cleanup_workers(self) -> None:
        """Clean up all listener workers."""
        for worker in self._workers:
            worker.cleanup()
        self._workers.clear()

    def get_running_workers(self) -> list[ListenerWorkerService]:
        """Get all running listener workers.
        
        Returns:
            List of running ListenerWorkerService instances
        """
        return [worker for worker in self._workers if worker.is_running()]

    def get_all_workers(self) -> list[ListenerWorkerService]:
        """Get all listener workers.
        
        Returns:
            List of all ListenerWorkerService instances
        """
        return self._workers.copy()