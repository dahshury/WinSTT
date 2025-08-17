"""Silero ONNX-based VAD Model Service.

Implements VADModelServiceProtocol using the Silero VAD ONNX model. Falls back
gracefully to energy-based detection if the model is unavailable or inputs
cannot be inferred.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import numpy as np
import onnxruntime as ort

from src.domain.transcription.value_objects.model_download_config import (
    ModelDownloadConfig,
)
from src.domain.transcription.value_objects.transcription_quality import (
    TranscriptionQuality,
)
from src.infrastructure.transcription.model_cache_service import (
    ModelCacheService,
)
from src.infrastructure.transcription.model_download_service import (
    ModelDownloadService,
)

from .vad_service import ModelLoadResult, VADModelServiceProtocol

if TYPE_CHECKING:
    from pathlib import Path

    from src.domain.audio.value_objects.audio_operations import AudioChunk
    from src.domain.audio.value_objects.vad_operations import (
        VADConfiguration,
        VADModel,
    )


@dataclass
class _SileroState:
    model_path: Path | None = None
    session: ort.InferenceSession | None = None
    input_name: str | None = None


class SileroVADModelService(VADModelServiceProtocol):
    """ONNX Runtime-backed Silero VAD service with safe fallbacks."""

    def __init__(self, cache_path: str | None = None) -> None:
        self._state = _SileroState()
        self._model_info: dict[str, Any] = {}
        # Default cache under src/cache in development
        if cache_path:
            self._cache_path = cache_path
        else:
            from pathlib import Path as _Path
            self._cache_path = str((_Path(__file__).resolve().parents[2] / "cache").resolve())

    def load_model(self, model: VADModel, config: VADConfiguration,
    ) -> ModelLoadResult:
        try:
            # Resolve cache path and ensure VAD model exists
            cache = ModelCacheService(cache_path=self._cache_path)
            vad_dir = cache.cache_path / "vad"
            vad_dir.mkdir(parents=True, exist_ok=True)
            model_path = vad_dir / "silero_vad_16k.onnx"

            if not model_path.exists() or model_path.stat().st_size <= 1024:
                # Download VAD model via unified service
                dl_cfg = ModelDownloadConfig(
                    cache_path=str(cache.cache_path),
                    model_type="whisper-turbo",
                    quality=TranscriptionQuality.QUANTIZED,
                )
                downloader = ModelDownloadService(dl_cfg)
                ok = downloader.download_vad_model()
                if not ok:
                    return ModelLoadResult(
                        model_loaded=False,
                        error_message="Failed to download Silero VAD model",
                    )

            # Create ORT session
            providers = ort.get_available_providers()
            session = ort.InferenceSession(str(model_path), providers=providers)
            # Infer input name (first input)
            input_name = session.get_inputs()[0].name if session.get_inputs() else None

            self._state = _SileroState(
                model_path=model_path,
                session=session,
                input_name=input_name,
            )

            self._model_info = {
                "model_file": str(model_path),
                "providers": providers,
                "sample_rate": config.sample_rate,
            }

            return ModelLoadResult(model_loaded=True, model_info=self._model_info, load_time=0.0)

        except Exception as e:  # Fallback allowed; VAD service will still function on energy
            return ModelLoadResult(model_loaded=False, error_message=str(e))

    def detect_voice_activity(self,
        audio_chunk: AudioChunk, config: VADConfiguration,
    ) -> tuple[bool, float, str | None]:
        try:
            # Decode bytes to float32 mono at 16kHz (expected)
            audio_f32 = np.frombuffer(audio_chunk.data, dtype=np.float32)
            if audio_f32.size == 0:
                return False, 0.0, None

            # Normalize/clamp
            max_abs = float(np.max(np.abs(audio_f32))) if audio_f32.size > 0 else 0.0
            if max_abs > 0:
                audio_f32 = (audio_f32 / max_abs).clip(-1.0, 1.0)

            # Try ONNX inference if session is available
            if self._state.session and self._state.input_name:
                input_tensor = audio_f32.reshape(1, -1)
                try:
                    outputs = self._state.session.run(None, {self._state.input_name: input_tensor})
                    # Heuristic: use first scalar-like output as speech probability
                    prob = 0.0
                    if outputs:
                        first = outputs[0]
                        prob = float(np.mean(first)) if np.ndim(first) > 0 else float(first)  # type: ignore[arg-type]
                    has_speech = prob >= max(0.1, min(0.9, config.threshold))
                    return has_speech, max(0.0, min(1.0, prob)), None
                except Exception:
                    # Fall through to energy-based fallback
                    pass

            # Energy-based fallback using RMS vs threshold
            rms = float(np.sqrt(np.mean(np.square(audio_f32)))) if audio_f32.size > 0 else 0.0
            confidence = min(1.0, rms / max(config.threshold, 1e-6)) if config.threshold > 0 else 0.0
            return rms >= config.threshold, confidence, None

        except Exception as e:
            return False, 0.0, str(e)

    def get_model_info(self) -> dict[str, Any]:
        return dict(self._model_info)

    def unload_model(self) -> tuple[bool, str | None]:
        try:
            self._state = _SileroState()
            self._model_info.clear()
            return True, None
        except Exception as e:
            return False, str(e)


