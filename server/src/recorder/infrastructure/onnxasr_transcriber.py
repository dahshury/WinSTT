from __future__ import annotations

import gc
import logging
import time
from collections.abc import Callable
from typing import Any

from typing_extensions import override

from src.building_blocks.types import AudioArray
from src.recorder.domain.events import DownloadProgress
from src.recorder.domain.ports.transcriber import ITranscriber, TranscriptionResult
from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

logger = logging.getLogger(__name__)

try:
    import onnx_asr
except ImportError:
    onnx_asr = None


class OnnxAsrTranscriber(ITranscriber):
    """ITranscriber adapter backed by the onnx-asr library."""

    def __init__(
        self,
        *,
        model_name: str,
        quantization: str | None = None,
        providers: list[str] | None = None,
        on_download_progress: Callable[[DownloadProgress], None] | None = None,
    ) -> None:
        if onnx_asr is None:
            msg = "onnx_asr is not installed"
            raise RuntimeError(msg)

        providers_tuple: tuple[str, ...] | None = tuple(providers) if providers else None

        kwargs: dict[str, Any] = {"quantization": quantization}
        if providers_tuple is not None:
            kwargs["providers"] = providers_tuple

        logger.info("Loading onnx-asr model %s (quantization=%s)", model_name, quantization)
        if on_download_progress is not None:
            with _intercept_hf_progress(model_name, on_download_progress):
                self._model: Any = onnx_asr.load_model(model_name, **kwargs)
        else:
            self._model = onnx_asr.load_model(model_name, **kwargs)
        self._ready = True
        logger.info("onnx-asr model %s loaded", model_name)

    @override
    def transcribe(
        self,
        audio: AudioArray,
        language: str = "",
        use_prompt: bool = True,
    ) -> TranscriptionResult:
        start_t = time.time()
        lang_arg = language if language else None

        try:
            text: str = self._model.recognize(audio, sample_rate=16_000, language=lang_arg)
        except TypeError:
            # Some models don't accept the language kwarg
            text = self._model.recognize(audio, sample_rate=16_000)

        elapsed = time.time() - start_t
        return TranscriptionResult(
            text=text.strip() if text else "",
            language=language,
            language_probability=0.0,
            duration_seconds=elapsed,
        )

    @override
    def is_ready(self) -> bool:
        return self._ready

    @override
    def shutdown(self) -> None:
        self._ready = False
        del self._model
        self._model = None
        gc.collect()
