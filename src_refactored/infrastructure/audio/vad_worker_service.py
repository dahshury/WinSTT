"""VAD Worker Infrastructure Service.

This module provides Voice Activity Detection (VAD) worker functionality
with PyQt threading and lifecycle management.
"""


import logging

from PyQt6.QtCore import QObject, pyqtSignal


class VadWorkerService(QObject):
    """Voice Activity Detection worker with PyQt threading support.
    
    This service manages VAD initialization and lifecycle within PyQt's
    threading model, providing signals for status updates and error handling.
    
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
            # Import refactored VAD pipeline lazily
            from src_refactored.infrastructure.audio.vad_service import (
                VADService,
                VADServiceRequest,
            )
            from src_refactored.infrastructure.audio.silero_vad_model_service import (
                SileroVADModelService,
            )
            from src_refactored.infrastructure.audio.audio_processing_service import (
                VADAudioProcessingService,
            )
            from src_refactored.infrastructure.audio.vad_validation_service import (
                VADValidationService,
            )
            from src_refactored.infrastructure.audio.vad_smoothing_service import (
                VADSmoothingService,
            )
            from src_refactored.domain.audio.value_objects.vad_operations import (
                VADConfiguration,
                VADModel,
                VADOperation,
            )

            service = VADService(
                model_service=SileroVADModelService(),
                audio_processing_service=VADAudioProcessingService(),
                validation_service=VADValidationService(),
                calibration_service=None,
                smoothing_service=VADSmoothingService(),
                progress_tracking_service=None,
                logger_service=logging.getLogger(__name__),
            )

            cfg = VADConfiguration(
                model=VADModel.SILERO_V3,
                threshold=0.02,
                sample_rate=16000,
                frame_size=512,
                hop_size=256,
                enable_smoothing=True,
                smoothing_window=3,
                min_speech_duration=0.08,
                min_silence_duration=0.08,
            )

            resp = service.execute(VADServiceRequest(operation=VADOperation.INITIALIZE, config=cfg))
            # Consider success on explicit SUCCESS result
            if str(getattr(resp, "result", "")).lower() in ("vadresult.success", "success"):
                self.vad = service
                self.initialized.emit()
                self.toggle_status()
                return

            # Failed initialization
            error_msg = "Failed to initialize VAD service"
            self.error.emit(error_msg)
            logging.getLogger(__name__).debug(error_msg)
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