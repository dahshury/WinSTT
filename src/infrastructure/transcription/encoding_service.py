"""ONNX encoder runner for Whisper models."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np
    import onnxruntime as ort


class WhisperOnnxEncoderService:
    """Runs the Whisper encoder ONNX session."""

    def __init__(self, session: ort.InferenceSession):
        self._session = session

    def encode(self, input_features: np.ndarray) -> np.ndarray:
        outputs = self._session.run(None, {"input_features": input_features})
        return outputs[0]


