"""VAD Worker Infrastructure Service.

This module provides Voice Activity Detection (VAD) worker functionality
with PyQt threading and lifecycle management.
"""


import logging

from PyQt6.QtCore import QObject, pyqtSignal


class VadWorkerService(QObject):
    """VAD worker using onnx_asr Silero VAD with PyQt threading support.
    
    This service manages VAD initialization and lifecycle within PyQt's threading
    model. It uses onnx_asr.load_vad("silero") and exposes a minimal API that
    older callers expect (get_detector, is_active).
    
    Signals:
        initialized: Emitted when VAD is successfully initialized
        error: Emitted when VAD initialization fails
    """

    initialized = pyqtSignal()
    error = pyqtSignal(str)

    def __init__(self):
        """Initialize the VAD worker service."""
        super().__init__()
        self.status = False
        self.vad: object | None = None

    def run(self) -> None:
        """Initialize the refactored VAD service in a worker thread."""
        try:
            import onnx_asr  # type: ignore[import-not-found]
            # Load Silero VAD via onnx_asr; quantization/provider auto-selected
            self.vad = onnx_asr.load_vad("silero")
            self.initialized.emit()
            self.toggle_status()
        except Exception as e:
            error_msg = f"Failed to initialize VAD: {e}"
            self.error.emit(error_msg)
            logging.getLogger(__name__).debug(error_msg)

    def toggle_status(self) -> None:
        """Toggle the VAD status.
        
        Switches between active and inactive states.
        """
        self.status = not self.status

    def is_active(self,
    ) -> bool:
        """Check if VAD is active.
        
        Returns:
            True if VAD is active, False otherwise
        """
        return self.status

    def get_detector(self) -> object | None:
        """Get the VAD detector instance.
        
        Returns:
            The VAD detector instance if initialized, None otherwise
        """
        return self.vad

    def cleanup(self) -> None:
        """Clean up VAD resources."""
        self.vad = None
        self.status = False


class VadWorkerManager:
    """High-level manager for VAD worker operations.
    
    This manager provides a simplified interface for VAD worker
    lifecycle management and common operations.
    """

    def __init__(self):
        """Initialize the VAD worker manager."""
        self._workers: list[VadWorkerService] = []

    def create_worker(self) -> VadWorkerService:
        """Create a new VAD worker.
        
        Returns:
            A new VadWorkerService instance
        """
        worker = VadWorkerService()
        self._workers.append(worker)
        return worker

    def initialize_worker(self, worker: VadWorkerService,
    ) -> None:
        """Initialize a VAD worker.
        
        Args:
            worker: The VAD worker to initialize
        """
        worker.run()

    def cleanup_workers(self) -> None:
        """Clean up all VAD workers."""
        for worker in self._workers:
            worker.cleanup()
        self._workers.clear()

    def get_active_workers(self) -> list[VadWorkerService]:
        """Get all active VAD workers.
        
        Returns:
            List of active VadWorkerService instances
        """
        return [worker for worker in self._workers if worker.is_active()]

    def get_all_workers(self) -> list[VadWorkerService]:
        """Get all VAD workers.
        
        Returns:
            List of all VadWorkerService instances
        """
        return self._workers.copy()