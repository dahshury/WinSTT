"""Enhanced model loader with optimized ONNX session management.

This encapsulates model URL decisions and file presence checks so the
transcription service only orchestrates sessions rather than owning
download configuration. Now includes optimizations from onnx_asr.
"""

from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING

from src.domain.transcription.value_objects.model_download_config import ModelDownloadConfig
from src.infrastructure.transcription.model_cache_service import ModelCacheService
from src.infrastructure.transcription.model_download_service import ModelDownloadService
from src.infrastructure.transcription.model_runtime_sessions import (
    OptimizedInferenceSession,
    OnnxSessionOptions,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from src.domain.transcription.value_objects.download_progress import DownloadProgress
    from src.domain.transcription.value_objects.transcription_quality import TranscriptionQuality


class OnnxModelLoader:
    """Loads Whisper ONNX encoder/decoder sessions ensuring files are present."""

    def __init__(
        self,
        cache_path: str,
        model_type: str,
        quality: TranscriptionQuality,
        on_progress: Callable[[DownloadProgress], None] | None = None,
        on_completed: Callable[[str], None] | None = None,
        on_failed: Callable[[str, str], None] | None = None,
    ) -> None:
        self._cache_path = cache_path
        self._model_type = model_type
        self._quality = quality
        self._cache = ModelCacheService(cache_path=cache_path)
        self._on_progress = on_progress
        self._on_completed = on_completed
        self._on_failed = on_failed

    def ensure_models_present(self) -> None:
        if self._cache.is_model_cached(self._model_type, self._quality.value) and self._cache.is_config_cached(self._model_type):
            return
        cfg = ModelDownloadConfig(cache_path=self._cache_path, model_type=self._model_type, quality=self._quality)
        downloader = ModelDownloadService(cfg)
        # Bridge progress events to provided callbacks
        try:
            if self._on_progress is not None:
                downloader.download_progress.connect(self._on_progress)  # type: ignore[attr-defined]
            if self._on_completed is not None:
                downloader.download_completed.connect(self._on_completed)  # type: ignore[attr-defined]
            if self._on_failed is not None:
                downloader.download_failed.connect(self._on_failed)  # type: ignore[attr-defined]
        except Exception:
            pass
        downloader.cleanup_incomplete_downloads()
        ok = downloader.download_whisper_models()
        if not ok:
            msg = "Whisper models download failed"
            raise RuntimeError(msg)

    def load_sessions(self, cpu_preprocessing: bool = True) -> dict[str, OptimizedInferenceSession]:
        """Load optimized ONNX sessions with enhanced performance settings."""
        options = OnnxSessionOptions(cpu_preprocessing=cpu_preprocessing)
        onnx_folder = self._cache.get_onnx_folder_path(self._model_type)
        suffix = "" if self._quality.value == "full" else "_quantized"
        model_paths = {
            "encoder": onnx_folder / f"encoder_model{suffix}.onnx",
            "decoder": onnx_folder / f"decoder_model{suffix}.onnx",
            "decoder_with_past": onnx_folder / f"decoder_with_past_model{suffix}.onnx",
        }

        sessions: dict[str, OptimizedInferenceSession] = {}
        for name, path in model_paths.items():
            if not path.exists():
                msg = f"Model file not found: {path}"
                raise FileNotFoundError(msg)
            try:
                sessions[name] = OptimizedInferenceSession(str(path), options)
            except Exception:
                with contextlib.suppress(Exception):
                    path.unlink(missing_ok=True)
                self.ensure_models_present()
                sessions[name] = OptimizedInferenceSession(str(path), options)
        return sessions

    def are_models_present(self) -> bool:
        """Check if both model ONNX files and configs are present in cache."""
        return self._cache.is_model_cached(self._model_type, self._quality.value) and self._cache.is_config_cached(self._model_type)

    def get_model_cache_dir(self) -> str:
        """Return the model directory used for configs/tokenizer/artifacts."""
        return str(self._cache.get_model_cache_path(self._model_type))


