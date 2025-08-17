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
    """Enhanced service with onnx_asr-inspired optimizations for audio preprocessing."""

    def __init__(self):
        """Initialize with caching for better performance."""
        self._supported_sample_rates = {8000, 16000, 22050, 24000, 32000, 44100, 48000}

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

    def load_waveform(
        self,
        audio_input: str | io.BytesIO | np.ndarray,
        sampling_rate: int = 16000,
    ) -> tuple[np.ndarray, int]:
        """Load audio as mono float32 waveform at target sampling rate.

        Returns (waveform, sample_rate). Waveform is 1D float32 array.
        """
        # Normalize input into a 1D float32 numpy array at target sr, mono
        if isinstance(audio_input, str):
            audio_array, sr = librosa.load(audio_input, sr=sampling_rate, mono=True)
        elif isinstance(audio_input, io.BytesIO):
            audio_segment = AudioSegment.from_file(audio_input)
            audio_segment = audio_segment.set_frame_rate(sampling_rate).set_channels(1)
            samples = np.array(audio_segment.get_array_of_samples(), dtype=np.float32)
            default_sample_width = 2
            sample_width = getattr(audio_segment, "sample_width", default_sample_width)
            min_width_for_scale = 1
            max_value = float(1 << (8 * sample_width - 1)) if sample_width >= min_width_for_scale else 0.0
            audio_array = samples / max_value if max_value > 0 else samples
            sr = sampling_rate
        else:
            audio_array = audio_input.astype(np.float32)
            stereo_channels = 2
            if audio_array.ndim > 1 and audio_array.shape[1] == stereo_channels:
                audio_array = audio_array.mean(axis=1)
            sr = sampling_rate

        # Guard against silent input
        if audio_array.size == 0:
            audio_array = np.zeros(sampling_rate, dtype=np.float32)
        return audio_array.astype(np.float32, copy=False), sr

    def efficient_resample(self, audio_array: np.ndarray, orig_sr: int, target_sr: int = 16000) -> np.ndarray:
        """Efficient resampling using librosa with optimizations like onnx_asr."""
        if orig_sr == target_sr:
            return audio_array
        
        # Use high-quality resampling for better accuracy
        return librosa.resample(
            audio_array, 
            orig_sr=orig_sr, 
            target_sr=target_sr,
            res_type='kaiser_fast'  # Faster than default 'kaiser_best'
        )

    def validate_sample_rate(self, sample_rate: int) -> bool:
        """Check if sample rate is supported like onnx_asr."""
        return sample_rate in self._supported_sample_rates

    def normalize_audio(self, audio_array: np.ndarray) -> np.ndarray:
        """Normalize audio to prevent clipping and improve consistency."""
        # Ensure float32 for consistency
        if audio_array.dtype != np.float32:
            audio_array = audio_array.astype(np.float32)
        
        # Normalize to [-1, 1] range
        max_val = np.abs(audio_array).max()
        if max_val > 0:
            audio_array = audio_array / max_val
        
        return audio_array


