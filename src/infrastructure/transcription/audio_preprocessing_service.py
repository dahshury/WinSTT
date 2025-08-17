"""Transcription audio preprocessing service.

Provides audio normalization and feature extraction utilities for
Whisper ONNX transcription. Extracted from the previous monolithic
ONNXTranscriptionService implementation.
"""

from __future__ import annotations

import io
from typing import TYPE_CHECKING

import librosa
import numpy as np
from pydub import AudioSegment

if TYPE_CHECKING:
    from transformers import WhisperFeatureExtractor


class TranscriptionAudioPreprocessingService:
    """Service that converts raw audio inputs to Whisper input features."""

    def preprocess(
        self,
        audio_input: str | io.BytesIO | np.ndarray,
        feature_extractor: WhisperFeatureExtractor,
        sampling_rate: int = 16000,
    ) -> np.ndarray:
        """Preprocess input into Whisper input features.

        Args:
            audio_input: Path, in-memory buffer, or numpy array
            feature_extractor: HuggingFace Whisper feature extractor
            sampling_rate: Target sampling rate (Hz)

        Returns:
            Numpy array of input features ready for ONNX encoder
        """
        # Normalize input into a 1D float32 numpy array at target sr, mono
        if isinstance(audio_input, str):
            audio_array, _ = librosa.load(audio_input, sr=sampling_rate, mono=True)
        elif isinstance(audio_input, io.BytesIO):
            audio_segment = AudioSegment.from_file(audio_input)
            audio_segment = audio_segment.set_frame_rate(sampling_rate).set_channels(1)
            samples = np.array(audio_segment.get_array_of_samples(), dtype=np.float32)
            max_value = float(1 << (8 * audio_segment.sample_width - 1)) if getattr(audio_segment, "sample_width", 2) else 0.0
            audio_array = samples / max_value if max_value > 0 else samples
        else:
            audio_array = audio_input.astype(np.float32)
            if audio_array.ndim > 1 and audio_array.shape[1] == 2:
                audio_array = audio_array.mean(axis=1)

        # Guard against silent input to avoid downstream issues
        if audio_array.size == 0:
            audio_array = np.zeros(sampling_rate, dtype=np.float32)

        inputs = feature_extractor(
            audio_array,
            sampling_rate=sampling_rate,
            return_tensors="np",
        )
        return inputs.input_features


