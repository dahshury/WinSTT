"""Runtime sessions wrapper and factory for Whisper ONNX models."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import onnxruntime as ort

if TYPE_CHECKING:
    from pathlib import Path


@dataclass
class ModelRuntimeSessions:
    """Holds encoder/decoder sessions for Whisper ONNX runtime."""

    encoder: ort.InferenceSession
    decoder: ort.InferenceSession | None
    decoder_with_past: ort.InferenceSession | None


class OnnxRuntimeSessionFactory:
    """Creates sessions from a directory containing ONNX files."""

    def create(self, onnx_folder: Path) -> ModelRuntimeSessions:
        providers = ort.get_available_providers()
        encoder = ort.InferenceSession(str(onnx_folder / "encoder_model.onnx"), providers=providers)
        decoder = None
        d_basic = onnx_folder / "decoder_model.onnx"
        if d_basic.exists():
            decoder = ort.InferenceSession(str(d_basic), providers=providers)
        d_past = None
        d_past_path = onnx_folder / "decoder_with_past_model.onnx"
        if d_past_path.exists():
            d_past = ort.InferenceSession(str(d_past_path), providers=providers)
        return ModelRuntimeSessions(encoder=encoder, decoder=decoder, decoder_with_past=d_past)


