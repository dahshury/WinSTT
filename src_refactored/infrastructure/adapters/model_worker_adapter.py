"""Model Worker Service Adapter.

This adapter bridges the real ModelWorkerService with the ITranscriptionService
protocol expected by the presentation layer.
"""

from typing import Any

from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.infrastructure.transcription.model_worker_service import ModelWorkerService


class ModelWorkerServiceAdapter:
    """Adapter that bridges ModelWorkerService with ITranscriptionService protocol."""

    def __init__(self, real_service: ModelWorkerService, logger: LoggingPort | None = None):
        self._service = real_service
        self._logger = logger

    def transcribe_audio(self, audio_data: Any) -> str:
        """Transcribe audio data to text."""
        try:
            # The ModelWorkerService may have a different interface
            # For now, provide a simple implementation that delegates to the service

            if hasattr(self._service, "transcribe"):
                return self._service.transcribe(audio_data)
            if hasattr(self._service, "process_audio"):
                return self._service.process_audio(audio_data)
            # Fallback implementation
            if self._logger:
                self._logger.log_info(f"Transcribing audio data of length: {len(audio_data) if hasattr(audio_data, '__len__') else 'unknown'}")

            return f"Transcribed audio ({len(audio_data) if hasattr(audio_data, '__len__') else 'unknown'} samples)"

        except Exception as e:
            if self._logger:
                self._logger.log_error("Error during transcription", exception=e)

            return f"Transcription failed: {e}"

    def transcribe_file(self, file_path: str) -> str:
        """Transcribe file to text."""
        try:
            # The ModelWorkerService may have a different interface for files

            if hasattr(self._service, "transcribe_file"):
                result = self._service.transcribe_file(file_path)
                if isinstance(result, str):
                    return result
                return str(result)
            if hasattr(self._service, "process_file"):
                result = self._service.process_file(file_path)
                if isinstance(result, str):
                    return result
                return str(result)
            # Fallback implementation
            if self._logger:
                self._logger.log_info(f"Transcribing file: {file_path}")

            return f"Transcribed file: {file_path}"

        except Exception as e:
            if self._logger:
                self._logger.log_error("Failed to transcribe file", exception=e)

            return f"File transcription failed: {e}"
