"""Streaming transcription service (UI-agnostic).

Accumulates audio into a ring buffer and periodically transcribes
windows using the same modular components as the offline engine.
"""

from __future__ import annotations

from collections import deque
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    import onnxruntime as ort

    from .audio_preprocessing_service import TranscriptionAudioPreprocessingService
    from .decoding_service import WhisperOnnxDecodingService
    from .encoding_service import WhisperOnnxEncoderService
    from .postprocessing_service import WhisperPostprocessingService


class StreamingTranscriptionService:
    """Non-blocking streaming transcription coordinator."""

    def __init__(
        self,
        runtime_sessions: dict[str, ort.InferenceSession],
        preprocessor: TranscriptionAudioPreprocessingService,
        encoder: WhisperOnnxEncoderService,
        decoder: WhisperOnnxDecodingService,
        postprocessor: WhisperPostprocessingService,
        feature_extractor,  # WhisperFeatureExtractor
        buffer_seconds: float = 3.0,
        process_window_seconds: float = 1.0,
        target_sample_rate: int = 16000,
    ) -> None:
        self._sessions = runtime_sessions
        self._preprocessor = preprocessor
        self._encoder = encoder
        self._decoder = decoder
        self._postprocessor = postprocessor
        self._feature_extractor = feature_extractor

        self._target_sr = int(target_sample_rate)
        self._buffer: deque[float] = deque(maxlen=int(buffer_seconds * target_sample_rate))
        self._window_size = int(process_window_seconds * target_sample_rate)
        self._current_transcript: str = ""

    def add_audio_chunk(self, chunk: np.ndarray, sample_rate: int) -> None:
        """Append audio data to the ring buffer.

        Expects mono np.ndarray of dtype float32 or int16.
        """
        if chunk is None or chunk.size == 0:
            return
        if chunk.dtype == np.int16:
            chunk = chunk.astype(np.float32) / 32768.0
        elif chunk.dtype != np.float32:
            chunk = chunk.astype(np.float32)

        # If sample rate differs, a lightweight resample using np.interp
        if sample_rate != self._target_sr and sample_rate > 0:
            duration = len(chunk) / float(sample_rate)
            target_len = int(duration * self._target_sr)
            if target_len > 0:
                x_old = np.linspace(0.0, 1.0, num=len(chunk), endpoint=False, dtype=np.float32)
                x_new = np.linspace(0.0, 1.0, num=target_len, endpoint=False, dtype=np.float32)
                chunk = np.interp(x_new, x_old, chunk).astype(np.float32, copy=False)

        self._buffer.extend(chunk)

    def process_available(self) -> str | None:
        """Process when enough audio is available; returns latest transcript or None."""
        if len(self._buffer) < self._window_size:
            return None

        audio_data = np.array(list(self._buffer), dtype=np.float32)
        # Preprocess via feature extractor
        features = self._feature_extractor(
            audio_data,
            sampling_rate=self._target_sr,
            return_tensors="np",
        )
        encoder_outputs = self._encoder.encode(features.input_features)
        output_ids = self._decoder.decode(encoder_outputs)
        transcript = self._postprocessor.decode_tokens(output_ids) or ""
        self._current_transcript = transcript

        # Keep only half a second for context
        half_second = int(0.5 * self._target_sr)
        self._buffer = deque(list(self._buffer)[-half_second:], maxlen=self._buffer.maxlen)
        return self._current_transcript

    def get_current_transcript(self) -> str:
        return self._current_transcript

    def clear(self) -> None:
        self._buffer.clear()
        self._current_transcript = ""


