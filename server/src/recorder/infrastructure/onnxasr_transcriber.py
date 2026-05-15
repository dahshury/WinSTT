from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

from typing_extensions import override

from src.building_blocks.types import AudioArray
from src.recorder.domain.events import DownloadProgress
from src.recorder.domain.ports.transcriber import ITranscriber, TranscriptionResult

logger = logging.getLogger(__name__)

try:
    import onnx_asr
except ImportError:
    onnx_asr = None  # type: ignore[assignment]


def _make_progress_adapter(model_name: str, sink: Callable[[DownloadProgress], None]) -> Callable[[Any], None]:
    """Map onnx-asr's per-file :class:`onnx_asr.progress.DownloadProgress`
    events into the server's per-model :class:`DownloadProgress` event.

    onnx-asr fires one callback per file per chunk during HF downloads. The
    server-side event aggregates progress across all files in a model so the
    UI can show a single bar with speed / ETA. We track ``(downloaded, total)``
    per filename in a closure and emit aggregated rollups on each update.
    """
    per_file: dict[str, tuple[int, int]] = {}
    start_time = time.monotonic()

    def _on_progress(event: Any) -> None:  # noqa: ANN401 — onnx_asr.progress.DownloadProgress
        per_file[event.filename] = (int(event.downloaded), int(event.total or 0))
        downloaded_bytes = sum(d for d, _ in per_file.values())
        total_bytes = sum(t for _, t in per_file.values())
        progress = (downloaded_bytes / total_bytes) if total_bytes > 0 else 0.0
        elapsed = max(time.monotonic() - start_time, 1e-6)
        speed_bps = downloaded_bytes / elapsed
        remaining = max(total_bytes - downloaded_bytes, 0)
        eta_seconds = (remaining / speed_bps) if speed_bps > 0 else 0.0

        sink(
            DownloadProgress(
                model=model_name,
                progress=progress,
                downloaded_bytes=downloaded_bytes,
                total_bytes=total_bytes,
                speed_bps=speed_bps,
                eta_seconds=eta_seconds,
            )
        )

    return _on_progress


class OnnxAsrTranscriber(ITranscriber):
    """ITranscriber adapter backed by the onnx-asr library.

    Onnx-asr-only after the Track B step 1 refactor — no torch dependency.
    Download progress is wired via onnx-asr's native ``progress_callback``
    (no tqdm-monkey-patch hack anymore).
    """

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
        if on_download_progress is not None:
            kwargs["progress_callback"] = _make_progress_adapter(model_name, on_download_progress)

        logger.info("Loading onnx-asr model %s (quantization=%s)", model_name, quantization)
        self._model: Any = onnx_asr.load_model(model_name, **kwargs)
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
        """Release the model and its ORT sessions via onnx-asr's lifecycle API."""
        self._ready = False
        model = self._model
        self._model = None
        if model is not None and hasattr(model, "close"):
            model.close()
