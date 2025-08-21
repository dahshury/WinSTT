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
            logging.getLogger(__name__).debug(
                f"Initializing onnx-asr worker for model type: {self.model_type}",
            )

            from src.infrastructure.transcription.onnx_transcription_service import (
                OnnxAsrTranscriptionService,
            )

            # Pull configured model and quantization
            try:
                from src.infrastructure.adapters.configuration_adapter import ConfigurationServiceAdapter as _Cfg
                cfg = _Cfg("settings.json", logging.getLogger(__name__))
                model_name = str(cfg.get_setting("model", "onnx-community/whisper-small"))
                quant = str(cfg.get_setting("quantization", "Quantized"))
            except Exception:
                model_name = "onnx-community/whisper-small"
                quant = "Quantized"
            service = OnnxAsrTranscriptionService(
                model_name=model_name,
                use_vad=True,
                quantization=quant,
            )

            # Expose a minimal protocol-compatible wrapper
            class _Compat:
                def __init__(self, svc: OnnxAsrTranscriptionService):
                    self._svc = svc

                def transcribe(self, file_path: str | io.BytesIO) -> str:
                    from src.domain.transcription.value_objects.transcription_request import (
                        TranscriptionRequest,
                    )
                    req = TranscriptionRequest(audio_input=file_path)
                    import asyncio as _a
                    if not getattr(self._svc, "is_initialized", False):
                        _loop = _a.new_event_loop()
                        _a.set_event_loop(_loop)
                        _loop.run_until_complete(self._svc.initialize_async())
                        _loop.close()
                    _loop = _a.new_event_loop()
                    _a.set_event_loop(_loop)
                    result = _loop.run_until_complete(self._svc.transcribe_async(req))
                    _loop.close()
                    return getattr(result, "text", None) or ""

            self.model = _Compat(service)

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

            # Transcribe the file with segments using the underlying service
            from src.domain.transcription.value_objects.transcription_request import (
                TranscriptionRequest,
            )
            import asyncio as _a
            # Access underlying svc via wrapper when available
            svc = getattr(self.model, "_svc", None)
            if svc is None:
                logging.getLogger(__name__).error("Model service unavailable")
                return None
            if not getattr(svc, "is_initialized", False):
                _loop = _a.new_event_loop()
                _a.set_event_loop(_loop)
                _loop.run_until_complete(svc.initialize_async())
                _loop.close()
            req = TranscriptionRequest(audio_input=file_path, return_segments=True)
            _loop = _a.new_event_loop()
            _a.set_event_loop(_loop)
            out = _loop.run_until_complete(svc.transcribe_async(req))
            _loop.close()
            return {"text": out.text, "segments": out.segments}
        except Exception as e:
            logging.getLogger(__name__).exception(f"Error transcribing file: {e!s}")
            return None

    def cleanup(self) -> None:
        """Clean up model resources."""
        try:
            # Best-effort cleanup to drop references and allow GC
            svc = getattr(self.model, "_svc", None)
            if svc is not None and hasattr(svc, "cleanup"):
                svc.cleanup()
        except Exception:
            pass
        self.model = None
        self.status = False
        # Toggle status off and notify any observers that worker is no longer active
        try:
            self.toggle_status()
        except Exception:
            pass

    def transcribe_audio_data(self, audio_bytes: bytes) -> dict[str, Any] | None:
        """Transcribe in-memory audio bytes using the model.
        
        Args:
            audio_bytes: Raw audio data as WAV bytes
        
        Returns:
            Dict with text and segments or None on failure
        """
        try:
            if not hasattr(self, "model") or self.model is None:
                logging.getLogger(__name__).error("Model not initialized")
                return None
            import io as _io
            buf = _io.BytesIO(audio_bytes)
            from src.domain.transcription.value_objects.transcription_request import (
                TranscriptionRequest,
            )
            svc = getattr(self.model, "_svc", None)
            if svc is None:
                text = self.model.transcribe(buf)
                return {"text": text or "", "segments": []}
            import asyncio as _a
            if not getattr(svc, "is_initialized", False):
                _loop = _a.new_event_loop()
                _a.set_event_loop(_loop)
                _loop.run_until_complete(svc.initialize_async())
                _loop.close()
            req = TranscriptionRequest(audio_input=buf, return_segments=True)
            _loop = _a.new_event_loop()
            _a.set_event_loop(_loop)
            out = _loop.run_until_complete(svc.transcribe_async(req))
            _loop.close()
            return {"text": out.text, "segments": out.segments}
        except Exception as e:
            logging.getLogger(__name__).exception(f"Error transcribing audio data: {e!s}")
            return None


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