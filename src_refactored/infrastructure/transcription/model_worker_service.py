"""Model Worker Infrastructure Service.

This module provides transcription model worker functionality with PyQt threading,
file processing, and progress tracking capabilities.
"""

import io
import logging
from typing import Any, Protocol

from PyQt6.QtCore import QObject, pyqtSignal


class _TranscriberProtocol(Protocol):
    def transcribe(self, file_path: str | io.BytesIO) -> str: ...
    def get_segments(self) -> list[dict[str, Any]]: ...


class ModelWorkerService(QObject):
    """Transcription model worker with PyQt threading support.
    
    This service manages model initialization and transcription operations
    within PyQt's threading model, providing signals for progress tracking
    and error handling.
    
    Signals:
        error: Emitted when model operations fail
        display_message_signal: Emitted for progress updates
        initialized: Emitted when model is successfully initialized
    """

    error = pyqtSignal(str)
    display_message_signal = pyqtSignal(object, object, object, object, object)  # txt, filename, percentage, hold, reset
    initialized = pyqtSignal()

    def __init__(self, model_type: str = "whisper-turbo", quantization: str | None = None):
        """Initialize the model worker service.
        
        Args:
            model_type: The type of model to initialize
            quantization: Optional quantization setting
        """
        super().__init__()
        self.model_type = model_type
        self.quantization = quantization
        self.status = False
        self.model: _TranscriberProtocol | None = None

    def run(self) -> None:
        """Initialize the transcription model.
        
        This method should be called from a worker thread to avoid
        blocking the UI during model initialization.
        """
        try:
            # Log initialization attempt
            logging.getLogger(__name__).debug(
                f"Initializing model type: {self.model_type} with quantization: {self.quantization}",
            )

            # Import here to avoid circular dependencies
            from utils.transcribe import WhisperONNXTranscriber

            # Initialize the WhisperONNXTranscriber
            self.model = WhisperONNXTranscriber(
                q=self.quantization,
                display_message_signal=self.display_message_signal,
                model_type=self.model_type,
            )

            self.initialized.emit()
            self.toggle_status()
        except Exception as e:
            error_msg = f"Failed to initialize model: {e}"
            self.error.emit(error_msg)

            # Log the error
            logging.getLogger(__name__).exception(error_msg)

    def toggle_status(self) -> None:
        """Toggle the model status.
        
        Switches between active and inactive states.
        """
        self.status = not self.status

    def is_active(self,
    ) -> bool:
        """Check if model is active.
        
        Returns:
            True if model is active, False otherwise
        """
        return self.status

    def get_model(self) -> object | None:
        """Get the model instance.
        
        Returns:
            The model instance if initialized, None otherwise
        """
        return self.model

    def transcribe_file(self, file_path: str | io.BytesIO) -> dict[str, Any] | None:
        """Transcribe an audio file using the model.
        
        Args:
            file_path: Path to the audio file or BytesIO buffer
            
        Returns:
            Dictionary containing transcription text and segments, or None if failed
        """
        try:
            if not hasattr(self, "model") or self.model is None:
                logging.getLogger(__name__).error("Model not initialized")
                return None

            # Log transcription attempt
            logger = logging.getLogger(__name__)
            if isinstance(file_path, io.BytesIO):
                # Check if we have the original filename stored on the BytesIO object
                if hasattr(file_path, "original_filename"):
                    logger.debug(f"Transcribing memory buffer for: {file_path.original_filename}")
                else:
                    logger.debug("Transcribing memory buffer")
            else:
                # Regular file path
                logger.debug(f"Transcribing file: {file_path}")

            # Transcribe the file
            text = self.model.transcribe(file_path)

            # Get segmentation information
            segments = self.model.get_segments()

            # Return results in a dictionary
            return {
                "text": text,
                "segments": segments,
            }
        except Exception as e:
            logging.getLogger(__name__).exception(f"Error transcribing file: {e!s}")
            return None

    def cleanup(self) -> None:
        """Clean up model resources."""
        self.model = None
        self.status = False


class ModelWorkerManager:
    """High-level manager for model worker operations.
    
    This manager provides a simplified interface for model worker
    lifecycle management and transcription operations.
    """

    def __init__(self):
        """Initialize the model worker manager."""
        self._workers: list[ModelWorkerService] = []

    def create_worker(
        self,
        model_type: str = "whisper-turbo",
        quantization: str | None = None,
    ) -> ModelWorkerService:
        """Create a new model worker.
        
        Args:
            model_type: The type of model to initialize
            quantization: Optional quantization setting
            
        Returns:
            A new ModelWorkerService instance
        """
        worker = ModelWorkerService(model_type, quantization)
        self._workers.append(worker)
        return worker

    def initialize_worker(self, worker: ModelWorkerService,
    ) -> None:
        """Initialize a model worker.
        
        Args:
            worker: The model worker to initialize
        """
        worker.run()

    def transcribe_with_worker(
        self,
        worker: ModelWorkerService,
        file_path: str | io.BytesIO,
    ) -> dict[str, Any] | None:
        """Transcribe a file using a specific worker.
        
        Args:
            worker: The model worker to use
            file_path: Path to the audio file or BytesIO buffer
            
        Returns:
            Dictionary containing transcription results or None if failed
        """
        return worker.transcribe_file(file_path)

    def cleanup_workers(self) -> None:
        """Clean up all model workers."""
        for worker in self._workers:
            worker.cleanup()
        self._workers.clear()

    def get_active_workers(self) -> list[ModelWorkerService]:
        """Get all active model workers.
        
        Returns:
            List of active ModelWorkerService instances
        """
        return [worker for worker in self._workers if worker.is_active()]

    def get_all_workers(self) -> list[ModelWorkerService]:
        """Get all model workers.
        
        Returns:
            List of all ModelWorkerService instances
        """
        return self._workers.copy()