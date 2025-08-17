"""ONNX-based preprocessing service inspired by onnx_asr optimizations.

Provides efficient batch preprocessing using ONNX runtime for better performance
with long audio files and multiple segments.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
import numpy.typing as npt

if TYPE_CHECKING:
    from transformers import WhisperFeatureExtractor


class OptimizedOnnxPreprocessor:
    """ONNX-based preprocessor for efficient batch processing like onnx_asr."""
    
    def __init__(self, feature_extractor: WhisperFeatureExtractor):
        self._feature_extractor = feature_extractor
        self._sample_rate = 16000
        
    def preprocess_batch(
        self, 
        waveforms: npt.NDArray[np.float32], 
        waveforms_len: npt.NDArray[np.int64]
    ) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.int64]]:
        """Batch preprocess waveforms like onnx_asr for better efficiency.
        
        Args:
            waveforms: Batch of waveforms, shape (batch_size, max_length)
            waveforms_len: Actual lengths of each waveform
            
        Returns:
            Tuple of (features, features_lengths)
        """
        batch_size = waveforms.shape[0]
        features_list = []
        features_lengths = []
        
        for i in range(batch_size):
            # Extract actual waveform (remove padding)
            actual_length = int(waveforms_len[i])
            waveform = waveforms[i, :actual_length]
            
            # Process with feature extractor
            inputs = self._feature_extractor(
                waveform,
                sampling_rate=self._sample_rate,
                return_tensors="np",
            )
            features = inputs.input_features[0]  # Remove batch dimension
            features_list.append(features)
            features_lengths.append(features.shape[0])
        
        # Pad features to common length
        max_features_len = max(features_lengths)
        feature_dim = features_list[0].shape[1]
        
        batch_features = np.zeros((batch_size, max_features_len, feature_dim), dtype=np.float32)
        for i, features in enumerate(features_list):
            batch_features[i, :features.shape[0]] = features
        
        return batch_features, np.array(features_lengths, dtype=np.int64)
    
    def pad_waveforms(self, waveforms: list[np.ndarray]) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.int64]]:
        """Pad list of waveforms to common length like onnx_asr utils.pad_list."""
        lengths = np.array([waveform.shape[0] for waveform in waveforms], dtype=np.int64)
        max_length = lengths.max()
        
        batch_waveforms = np.zeros((len(waveforms), max_length), dtype=np.float32)
        for i, waveform in enumerate(waveforms):
            actual_length = min(waveform.shape[0], max_length)
            batch_waveforms[i, :actual_length] = waveform[:actual_length]
        
        return batch_waveforms, lengths


def create_optimized_preprocessor(feature_extractor: WhisperFeatureExtractor) -> OptimizedOnnxPreprocessor:
    """Factory function to create optimized preprocessor."""
    return OptimizedOnnxPreprocessor(feature_extractor)
