"""ONNX-based transcription service implementation.

Provides Whisper ONNX transcription with non-blocking patterns.
Responsibilities are modularized to adhere to the project's
hexagonal architecture.
"""

import gc
import logging
from typing import Any

import onnxruntime as ort
from transformers import WhisperFeatureExtractor, WhisperTokenizerFast

from src.domain.transcription.ports import TranscriptionOutput
from src.domain.transcription.value_objects.transcription_configuration import (
    TranscriptionConfiguration,
)
from src.domain.transcription.value_objects.transcription_quality import (
    TranscriptionQuality,
)
from src.domain.transcription.value_objects.transcription_request import (
    TranscriptionRequest,
)
from src.domain.transcription.value_objects.transcription_status import (
    TranscriptionStatus,
)
from src.infrastructure.media.media_info_service import MediaInfoService

# Modular services
from .audio_preprocessing_service import TranscriptionAudioPreprocessingService
from .decoding_service import WhisperOnnxDecodingService
from .encoding_service import WhisperOnnxEncoderService
from .postprocessing_service import WhisperPostprocessingService

# Suppress transformers logging
logging.getLogger("transformers").setLevel(logging.ERROR)

custom_logger = logging.getLogger(__name__)


class ONNXTranscriptionService:
    """ONNX-based Whisper transcription service (UI-agnostic)."""

    def __init__(self,
                 cache_path: str | None = None,
                 quality: TranscriptionQuality = TranscriptionQuality.QUANTIZED,
                 model_type: str = "whisper-turbo",
                 display_message_callback: Any | None = None,
                 progress_callback: Any | None = None,
                 configuration: TranscriptionConfiguration | None = None,
                 runtime_sessions: dict[str, ort.InferenceSession] | None = None,
                 tokenizer: WhisperTokenizerFast | None = None,
                 feature_extractor: WhisperFeatureExtractor | None = None,
                 model_config: dict | None = None,
                 generation_config: dict | None = None,
                 preprocessor: TranscriptionAudioPreprocessingService | None = None,
                 encoder_service: WhisperOnnxEncoderService | None = None,
                 decoder_service: WhisperOnnxDecodingService | None = None,
                 postprocessor: WhisperPostprocessingService | None = None):
        super().__init__()

        # Prefer externally provided configuration when available
        self.configuration = configuration
        self.quality = configuration.quality if configuration is not None else quality
        self.model_type = model_type
        self.display_message_callback = display_message_callback
        self.progress_callback = progress_callback

        # State
        self.status = TranscriptionStatus.IDLE
        self.is_initialized = False
        self.sessions: dict[str, ort.InferenceSession] = runtime_sessions or {}
        self.tokenizer: WhisperTokenizerFast | None = tokenizer
        self.feature_extractor: WhisperFeatureExtractor | None = feature_extractor
        self.config: dict | None = model_config or {}
        self.generation_config: dict | None = generation_config or {}

        # Modular components (DI-friendly)
        self._preprocessor = preprocessor
        self._encoder_service = encoder_service
        self._decoder_service = decoder_service
        self._postprocessor = postprocessor

        custom_logger.info("ONNXTranscriptionService initialized with quality: %s, model: %s", self.quality.value, model_type)

    async def initialize_async(self) -> bool:
        """Initialize the transcription service asynchronously."""
        if self.is_initialized:
            return True

        try:
            self.status = TranscriptionStatus.INITIALIZING
            if self.display_message_callback:
                self.display_message_callback("Initializing transcription service...", None, 10, False, False)

            # Require sessions and artifacts to be injected by the caller
            if not self.sessions:
                msg = "Runtime sessions were not provided to ONNXTranscriptionService"
                raise RuntimeError(msg)
            if self.tokenizer is None or self.feature_extractor is None:
                msg = "Artifacts (tokenizer/feature_extractor) were not provided to ONNXTranscriptionService"
                raise RuntimeError(msg)

            # Config dictionaries must be injected; default to empty dicts
            if self.config is None:
                self.config = {}
            if self.generation_config is None:
                self.generation_config = {}

            # Wire modular components if not provided
            if self._encoder_service is None and "encoder" in self.sessions:
                self._encoder_service = WhisperOnnxEncoderService(self.sessions["encoder"])  # type: ignore[index]
            if self._decoder_service is None:
                self._decoder_service = WhisperOnnxDecodingService(
                    decoder_session=self.sessions.get("decoder_with_past", self.sessions.get("decoder")),  # type: ignore[arg-type]
                    fallback_decoder_session=self.sessions.get("decoder"),
                    model_config=getattr(self, "config", {}),
                    generation_config=getattr(self, "generation_config", {}),
                )
            if self._postprocessor is None and self.tokenizer is not None:
                self._postprocessor = WhisperPostprocessingService(self.tokenizer)
            if self._preprocessor is None and self.feature_extractor is not None:
                self._preprocessor = TranscriptionAudioPreprocessingService()

            self.is_initialized = True
            self.status = TranscriptionStatus.IDLE

            if self.display_message_callback:
                self.display_message_callback("Transcription service ready", None, None, False, True)

            custom_logger.info("ONNX transcription service initialized successfully")
            return True

        except Exception as e:
            self.status = TranscriptionStatus.ERROR
            error_msg = f"Failed to initialize transcription service: {e}"
            custom_logger.exception(error_msg)
            if self.display_message_callback:
                self.display_message_callback(error_msg, None, 0, True, True)
            return False

    async def transcribe_async(self, request: TranscriptionRequest,
    ) -> TranscriptionOutput:
        """Transcribe audio asynchronously."""
        if not self.is_initialized:
            msg = "Service not initialized"
            raise RuntimeError(msg)

        try:
            self.status = TranscriptionStatus.PROCESSING
            if self.progress_callback:
                self.progress_callback(0, 0, "Starting transcription...")

            # Preprocess audio
            if self.progress_callback:
                self.progress_callback(20, 100, "Preprocessing audio...")
            assert self._preprocessor is not None
            assert self.feature_extractor is not None
            audio_features = self._preprocessor.preprocess(request.audio_input, self.feature_extractor, 16000)

            # Run encoder
            if self.progress_callback:
                self.progress_callback(40, 100, "Running encoder...")
            assert self._encoder_service is not None
            encoder_outputs = self._encoder_service.encode(audio_features)

            # Run decoder
            if self.progress_callback:
                self.progress_callback(70, 100, "Running decoder...")
            assert self._decoder_service is not None
            output_ids = self._decoder_service.decode(encoder_outputs)

            # Postprocess
            if self.progress_callback:
                self.progress_callback(90, 100, "Postprocessing...")
            assert self._postprocessor is not None
            transcription_text = self._postprocessor.decode_tokens(output_ids)

            # Segments
            segments = []
            if getattr(request, "return_segments", False):
                media_info = MediaInfoService()
                audio_duration = media_info.get_duration_seconds(request.audio_input)
                if self._postprocessor is None and self.tokenizer is not None:
                    self._postprocessor = WhisperPostprocessingService(self.tokenizer)
                if self._postprocessor is not None:
                    segments = self._postprocessor.simple_segments(audio_duration, transcription_text)
            else:
                segments = []

            self.status = TranscriptionStatus.COMPLETED
            if self.progress_callback:
                self.progress_callback(100, 100, "Completed")

            return TranscriptionOutput(
                text=transcription_text,
                segments=[
                    {"start": seg.start_time.seconds, "end": seg.end_time.seconds, "text": getattr(seg.text, "content", str(seg.text))}
                    for seg in segments
                ] if segments else None,
            )

        except Exception as e:
            self.status = TranscriptionStatus.ERROR
            error_msg = f"Transcription failed: {e}"
            custom_logger.exception(error_msg)
            if self.progress_callback:
                self.progress_callback(0, 0, error_msg)
            raise

    def cleanup(self) -> None:
        """Cleanup resources."""
        # Clear sessions
        for session in self.sessions.values():
            if session:
                del session
        self.sessions.clear()
        # Force garbage collection
        gc.collect()
        custom_logger.info("ONNX transcription service cleaned up")
