"""ONNX-based transcription service implementation.

Provides Whisper ONNX transcription with non-blocking patterns.
Responsibilities are modularized to adhere to the project's
hexagonal architecture.
"""

import gc
import logging
from typing import Any

import numpy as np
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
 
from src.infrastructure.transcription.model_cache_service import ModelCacheService
from src.infrastructure.transcription.model_download_service import ModelDownloadService
from src.domain.transcription.value_objects.model_download_config import (
    ModelDownloadConfig,
)

# Modular services
from .audio_preprocessing_service import TranscriptionAudioPreprocessingService
from .decoding_service import WhisperOnnxDecodingService
from .encoding_service import WhisperOnnxEncoderService
from .postprocessing_service import WhisperPostprocessingService
from .onnx_preprocessor_service import create_optimized_preprocessor
from .vad_segmenter import SileroVadSegmenter, VadSegmentationConfig

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
        self._cache_path = cache_path

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
        self._vad_segmenter: SileroVadSegmenter | None = None

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

            # Initialize VAD segmenter (best-effort); ensure VAD model exists in cache
            try:
                cache_base = self._cache_path
                if cache_base is None:
                    from src.infrastructure.common.resource_service import resource_path as _resource_path
                    cache_base = _resource_path("src/cache")
                cache = ModelCacheService(cache_path=cache_base)
                vad_path = cache.cache_path / "vad" / "silero_vad_16k.onnx"
                if not vad_path.exists() or vad_path.stat().st_size <= 1000:
                    dl_cfg = ModelDownloadConfig(
                        cache_path=cache_base,
                        model_type=self.model_type,
                        quality=self.quality,
                    )
                    ModelDownloadService(dl_cfg).download_vad_model()
                if vad_path.exists() and vad_path.stat().st_size > 1000:
                    self._vad_segmenter = SileroVadSegmenter(str(vad_path))
            except Exception:
                self._vad_segmenter = None

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

            assert self._preprocessor is not None
            assert self.feature_extractor is not None

            # Choose path: VAD-assisted segmentation for timestamps, or single-pass
            use_segments = bool(getattr(request, "return_segments", False) and self._vad_segmenter is not None)

            if use_segments:
                if self.progress_callback:
                    self.progress_callback(20, 100, "Loading audio for segmentation...")
                # Load waveform at 16k mono float32
                waveform, _ = self._preprocessor.load_waveform(request.audio_input, 16000)
                if self.progress_callback:
                    self.progress_callback(35, 100, "Running VAD segmentation...")
                spans = self._vad_segmenter.segment(waveform, VadSegmentationConfig(sample_rate=16000)) if self._vad_segmenter else []

                if self.progress_callback:
                    self.progress_callback(50, 100, "Transcribing segments...")
                
                # Use optimized batch processing like onnx_asr
                segments_out = self._transcribe_segments_batch(waveform, spans)
                transcription_text = " ".join(seg["text"] for seg in segments_out) if segments_out else ""
                segments_result = segments_out if segments_out else None
            else:
                # Single-pass inference
                if self.progress_callback:
                    self.progress_callback(20, 100, "Preprocessing audio...")
                audio_features = self._preprocessor.preprocess(request.audio_input, self.feature_extractor, 16000)
                if self.progress_callback:
                    self.progress_callback(40, 100, "Running encoder...")
                assert self._encoder_service is not None
                encoder_outputs = self._encoder_service.encode(audio_features)
                if self.progress_callback:
                    self.progress_callback(70, 100, "Running decoder...")
                assert self._decoder_service is not None
                output_ids = self._decoder_service.decode(encoder_outputs)
                if self.progress_callback:
                    self.progress_callback(90, 100, "Postprocessing...")
                assert self._postprocessor is not None
                transcription_text = self._postprocessor.decode_tokens(output_ids)
                segments_result = None

            self.status = TranscriptionStatus.COMPLETED
            if self.progress_callback:
                self.progress_callback(100, 100, "Completed")

            return TranscriptionOutput(text=transcription_text, segments=segments_result)

        except Exception as e:
            self.status = TranscriptionStatus.ERROR
            error_msg = f"Transcription failed: {e}"
            custom_logger.exception(error_msg)
            if self.progress_callback:
                self.progress_callback(0, 0, error_msg)
            raise

    def _transcribe_segments_batch(self, waveform: np.ndarray, spans: list[tuple[int, int]], batch_size: int = 8) -> list[dict[str, Any]]:
        """Optimized batch processing of VAD segments using onnx_asr approach.
        
        Uses the ASR model's native batch processing like onnx_asr for better efficiency.
        """
        from itertools import islice
        
        assert self._encoder_service is not None
        assert self._decoder_service is not None
        assert self._postprocessor is not None
        assert self.feature_extractor is not None
        assert self._preprocessor is not None
        
        segments_out: list[dict[str, Any]] = []
        
        # Process segments in batches like onnx_asr VAD approach
        spans_iter = iter(spans)
        while batch_spans := list(islice(spans_iter, batch_size)):
            # Filter valid spans
            valid_spans = [(start, end) for start, end in batch_spans if end > start]
            if not valid_spans:
                continue
            
            try:
                # Extract waveform segments like onnx_asr
                segment_waveforms = [waveform[start:end] for start, end in valid_spans]
                
                if not segment_waveforms:
                    continue
                
                # Use onnx_asr's pad_list approach for batch processing
                padded_waveforms, waveform_lengths = self._pad_waveforms(segment_waveforms)
                
                # Batch preprocessing like onnx_asr
                batch_features = []
                for seg_wave in segment_waveforms:
                    seg_feats = self._preprocessor.preprocess(seg_wave, self.feature_extractor, 16000)
                    batch_features.append(seg_feats)
                
                # Process each segment in the batch
                for (start_samp, end_samp), seg_feats in zip(valid_spans, batch_features, strict=True):
                    # Use OrtValue for better memory management
                    if hasattr(self._encoder_service, "encode_ortvalue"):
                        enc_ortvalue = self._encoder_service.encode_ortvalue(seg_feats)
                        ids = self._decoder_service.decode(enc_ortvalue)
                    else:
                        enc = self._encoder_service.encode(seg_feats)
                        ids = self._decoder_service.decode(enc)
                    
                    text_seg = self._postprocessor.decode_tokens(ids).strip()
                    if text_seg:
                        segments_out.append({
                            "start": float(start_samp) / 16000.0,
                            "end": float(end_samp) / 16000.0,
                            "text": text_seg,
                        })
                        
            except Exception as e:
                # Fallback to individual processing if batch fails
                custom_logger.warning("Batch processing failed, falling back to individual: %s", e)
                for start_samp, end_samp in valid_spans:
                    try:
                        seg_wave = waveform[start_samp:end_samp]
                        seg_feats = self._preprocessor.preprocess(seg_wave, self.feature_extractor, 16000)
                        enc = self._encoder_service.encode(seg_feats)
                        ids = self._decoder_service.decode(enc)
                        text_seg = self._postprocessor.decode_tokens(ids).strip()
                        if text_seg:
                            segments_out.append({
                                "start": float(start_samp) / 16000.0,
                                "end": float(end_samp) / 16000.0,
                                "text": text_seg,
                            })
                    except Exception:
                        continue  # Skip problematic segments
        
        return segments_out

    def _pad_waveforms(self, waveforms: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
        """Pad list of waveforms to common length like onnx_asr utils.pad_list."""
        lengths = np.array([waveform.shape[0] for waveform in waveforms], dtype=np.int64)
        max_length = lengths.max()
        
        padded = np.zeros((len(waveforms), max_length), dtype=np.float32)
        for i, waveform in enumerate(waveforms):
            actual_length = min(waveform.shape[0], max_length)
            padded[i, :actual_length] = waveform[:actual_length]
        
        return padded, lengths

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