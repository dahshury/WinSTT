"""Enhanced ONNX encoder runner for Whisper models with optimizations."""

from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
from onnxruntime import OrtValue

if TYPE_CHECKING:
    from src.infrastructure.transcription.model_runtime_sessions import OptimizedInferenceSession


class WhisperOnnxEncoderService:
    """Runs the Whisper encoder ONNX session with memory optimizations."""

    def __init__(self, session: OptimizedInferenceSession):
        self._session = session

    def encode(self, input_features: np.ndarray) -> np.ndarray:
        """Encode input features using optimized inference."""
        # Convert to OrtValue for better memory management
        if not isinstance(input_features, OrtValue):
            input_ortvalue = OrtValue.ortvalue_from_numpy(input_features.astype(np.float32))
        else:
            input_ortvalue = input_features
        
        # Use IO binding if supported for better performance
        try:
            outputs = self._session.run_with_io_binding(
                {"input_features": input_ortvalue}, 
                ["last_hidden_state"]
            )
            if outputs and hasattr(outputs[0], "numpy"):
                return outputs[0].numpy()
            elif outputs:
                return outputs[0]
        except Exception:
            # Fallback to regular inference
            pass
        
        # Standard inference as fallback
        outputs = self._session.run(None, {"input_features": input_features.astype(np.float32)})
        return outputs[0]

    def encode_ortvalue(self, input_features: np.ndarray) -> OrtValue:
        """Encode and return OrtValue for chained operations without memory copies."""
        input_ortvalue = OrtValue.ortvalue_from_numpy(input_features.astype(np.float32))
        
        try:
            outputs = self._session.run_with_io_binding(
                {"input_features": input_ortvalue}, 
                ["last_hidden_state"]
            )
            if outputs and isinstance(outputs[0], OrtValue):
                return outputs[0]
        except Exception:
            pass
        
        # Fallback: run standard inference and convert back to OrtValue
        outputs = self._session.run(None, {"input_features": input_features.astype(np.float32)})
        return OrtValue.ortvalue_from_numpy(outputs[0])


