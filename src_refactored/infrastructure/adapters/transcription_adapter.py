"""Transcription and VAD Service Adapters.

These adapters bridge the real transcription and VAD services to work with
the listener service and provide the simple interfaces expected by the application.
"""

import io
from typing import Any

from src_refactored.domain.common.ports.logging_port import LoggingPort


class SimpleVADAdapter:
    """Real VAD adapter using VaDetector from the original implementation."""

    def __init__(self, logger: LoggingPort | None = None):
        self._logger = logger
        self._vad_detector = None
        try:
            # Import and initialize the real VAD detector
            from utils.transcribe import VaDetector
            self._vad_detector = VaDetector()
            if self._logger:
                self._logger.log_info("Initialized real VAD adapter with VaDetector")
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Failed to initialize VAD detector: {e}")
            self._vad_detector = None

    def detect_speech(self, audio_data: Any) -> bool:
        """Detect speech in audio data using real VAD implementation."""
        if self._vad_detector is None:
            # Fallback to always return True if VAD is not available
            return True
        
        try:
            # audio_data should be a BytesIO buffer containing WAV data
            if isinstance(audio_data, bytes | bytearray):
                audio_buffer = io.BytesIO(audio_data)
            elif hasattr(audio_data, "read"):
                audio_buffer = audio_data
            else:
                if self._logger:
                    self._logger.log_warning("Invalid audio data format for VAD")
                return True
            
            # Use the real VAD detector to check for speech
            has_speech = self._vad_detector.has_speech(audio_buffer)
            
            if self._logger:
                self._logger.log_debug(f"VAD detected speech: {has_speech}")
            
            return has_speech
            
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error in VAD speech detection: {e}")
            # Return True on error to allow transcription attempt
            return True

    def has_speech(self, audio_data: Any) -> bool:
        """Alias for detect_speech to match original interface."""
        return self.detect_speech(audio_data)


class SimpleTranscriptionAdapter:
    """Real transcription adapter using WhisperONNXTranscriber from the original implementation."""

    def __init__(self, logger: LoggingPort | None = None):
        self._logger = logger
        self._transcriber = None
        try:
            # Import and initialize the real transcriber with the complete model
            from utils.transcribe import WhisperONNXTranscriber
            # Use lite-whisper-turbo which is complete, and quantized for better compatibility
            self._transcriber = WhisperONNXTranscriber(
                q="quantized", 
                model_type="lite-whisper-turbo",
            )
            if self._logger:
                self._logger.log_info("Initialized real transcription adapter with lite-whisper-turbo")
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Failed to initialize transcriber: {e}")
            self._transcriber = None

    def transcribe_audio(self, audio_data: Any) -> str:
        """Transcribe audio data to text using real transcription implementation."""
        if self._transcriber is None:
            if self._logger:
                self._logger.log_warning("Transcriber not available, returning fallback message")
            return "Transcription service not available"
        
        try:
            # audio_data should be a file path or BytesIO buffer
            if isinstance(audio_data, str):
                # File path
                result = self._transcriber.transcribe(audio_data)
            elif isinstance(audio_data, bytes | bytearray):
                # Convert bytes to BytesIO
                audio_buffer = io.BytesIO(audio_data)
                result = self._transcriber.transcribe(audio_buffer)
            elif hasattr(audio_data, "read"):
                # File-like object
                result = self._transcriber.transcribe(audio_data)
            else:
                if self._logger:
                    self._logger.log_warning("Invalid audio data format for transcription")
                return "Invalid audio format"
            
            if self._logger:
                self._logger.log_debug(f"Transcription completed: {result[:50]}...")
            
            return result if result else "No transcription result"
            
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error in transcription: {e}")
            return f"Transcription error: {e!s}"

    def transcribe(self, audio_data: Any) -> str:
        """Alias for transcribe_audio to match original interface."""
        return self.transcribe_audio(audio_data)
