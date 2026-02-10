from __future__ import annotations

import logging
import sys
import time
import types
from collections.abc import Callable, Generator
from contextlib import contextmanager
from typing import Any

import numpy as np
from typing_extensions import override

from src.building_blocks.types import AudioArray
from src.recorder.domain.events import DownloadProgress
from src.recorder.domain.ports.transcriber import ITranscriber, TranscriptionResult
from src.recorder.infrastructure.device import resolve_device

logger = logging.getLogger(__name__)


class DownloadCancelledError(Exception):
    """Raised when a model download is cancelled by the user."""

try:
    import faster_whisper
except ImportError:
    faster_whisper = None


@contextmanager
def _intercept_hf_progress(
    model_name: str,
    on_progress: Callable[[DownloadProgress], None],
    cancel_check: Callable[[], bool] | None = None,
) -> Generator[None, None, None]:
    """Replace huggingface_hub's tqdm class to intercept download progress.

    Creates a subclass of huggingface_hub's tqdm that tracks cumulative byte
    progress across all download bars.  The subclass is injected into every
    loaded ``huggingface_hub.*`` module that references the original class,
    so download functions use it regardless of when they were imported.

    Start/complete events are fired automatically only if an actual download
    occurs (i.e. at least one tqdm progress bar is created).  The original
    class references are restored on context exit.
    """
    try:
        from huggingface_hub.utils import tqdm as _orig_cls  # type: ignore[attr-defined]
    except ImportError:
        yield
        return

    # Resolve the root tqdm base class.  huggingface_hub.utils.tqdm.tqdm is a
    # subclass of tqdm.auto.tqdm.  faster_whisper.utils.disabled_tqdm is ALSO a
    # subclass of tqdm.auto.tqdm but NOT of the HF wrapper.  We need the common
    # ancestor so ``issubclass`` catches both branches.
    try:
        from tqdm.auto import tqdm as _base_tqdm
    except ImportError:
        _base_tqdm = _orig_cls

    _bars: list[Any] = []
    _started: list[bool] = [False]
    _t0: list[float] = [0.0]  # monotonic start time (set on first threshold-crossing update)

    _MIN_TOTAL = 1_000_000  # 1 MB — below this, skip progress events

    def _emit(pct: float, downloaded: float, total: float) -> None:
        elapsed = time.monotonic() - _t0[0] if _t0[0] else 0.0
        speed = downloaded / elapsed if elapsed > 0.5 else 0.0
        remaining = total - downloaded
        eta = remaining / speed if speed > 0 else 0.0
        on_progress(
            DownloadProgress(
                model=model_name,
                progress=pct,
                downloaded_bytes=int(downloaded),
                total_bytes=int(total),
                speed_bps=speed,
                eta_seconds=eta,
            )
        )

    class _TrackedTqdm(_orig_cls):
        def __init__(self, *args: object, **kwargs: object) -> None:
            kwargs["disable"] = True  # suppress original tqdm — caller handles UI
            super().__init__(*args, **kwargs)  # type: ignore[no-untyped-call]
            self._tracked_n: float = 0.0
            _bars.append(self)

        def update(self, n: object = 1) -> object:
            # Check for cancellation before processing the update
            if cancel_check is not None and cancel_check():
                raise DownloadCancelledError("Download cancelled by user")
            # Real tqdm.update() is a no-op when disable=True (returns
            # immediately without updating self.n).  We must track bytes
            # ourselves via _tracked_n so the aggregate calculation works.
            result: object = super().update(n)
            if isinstance(n, (int, float)):
                self._tracked_n += float(n)
            # Read self.total dynamically — snapshot_download's _AggregatedTqdm
            # externally mutates bytes_progress.total after construction.
            # Only include bars with total > 0 (the bytes bar starts at
            # total=0 and gets total set externally, so exclude it until
            # then).  Cap each bar's downloaded to its total to prevent
            # overshoot when updates arrive before total is set.
            total: float = 0.0
            downloaded: float = 0.0
            for b in _bars:
                t = float(getattr(b, "total", 0) or 0)
                if t > 0:
                    total += t
                    downloaded += min(b._tracked_n, t)
            # Skip events while total < 1 MB — small config/vocab files
            # complete instantly before the large model file is discovered,
            # causing a false 99% spike.  Model files are always > 1 MB.
            if total >= _MIN_TOTAL:
                if not _started[0]:
                    _started[0] = True
                    _t0[0] = time.monotonic()
                    _emit(0.0, 0.0, total)
                _emit(min(downloaded / total, 0.99), downloaded, total)
            return result

    # Replace tqdm class references in every loaded huggingface_hub and
    # faster_whisper module.  faster_whisper.utils defines ``disabled_tqdm``
    # as a direct subclass of ``tqdm.auto.tqdm`` (sibling to the HF wrapper)
    # and passes it as ``tqdm_class=`` to snapshot_download, so we must check
    # against the common base ``_base_tqdm`` to catch both branches.
    _patches: list[tuple[types.ModuleType, str, object]] = []
    for _mod_name, _mod in list(sys.modules.items()):
        if _mod is None:
            continue
        if not (_mod_name.startswith("huggingface_hub") or _mod_name.startswith("faster_whisper")):
            continue
        for attr in ("tqdm", "hf_tqdm", "disabled_tqdm"):
            val = getattr(_mod, attr, None)
            if val is None or val is _TrackedTqdm:
                continue
            if isinstance(val, type) and issubclass(val, _base_tqdm):
                setattr(_mod, attr, _TrackedTqdm)
                _patches.append((_mod, attr, val))
    logger.info("Patched %d tqdm references for download progress of %s", len(_patches), model_name)

    try:
        yield
    finally:
        for _patched_mod, _patched_attr, _orig_val in _patches:
            setattr(_patched_mod, _patched_attr, _orig_val)
        if _started[0]:
            # Compute final totals for the complete event
            total_f: float = 0.0
            for b in _bars:
                t = float(getattr(b, "total", 0) or 0)
                if t > 0:
                    total_f += t
            _emit(1.0, total_f, total_f)


class WhisperTranscriber(ITranscriber):
    def __init__(
        self,
        *,
        model_path: str = "tiny",
        device: str = "cuda",
        compute_type: str = "default",
        gpu_device_index: int | list[int] = 0,
        download_root: str | None = None,
        beam_size: int = 5,
        initial_prompt: str | list[int] | None = None,
        suppress_tokens: list[int] | None = None,
        batch_size: int = 16,
        vad_filter: bool = True,
        normalize_audio: bool = False,
        on_download_progress: Callable[[DownloadProgress], None] | None = None,
        cancel_check: Callable[[], bool] | None = None,
    ) -> None:
        if faster_whisper is None:
            msg = "faster_whisper is not installed"
            raise RuntimeError(msg)
        self._beam_size = beam_size
        self._initial_prompt = initial_prompt
        self._suppress_tokens = suppress_tokens or [-1]
        self._batch_size = batch_size
        self._vad_filter = vad_filter
        self._normalize_audio = normalize_audio
        self._ready = False

        actual_device = resolve_device(device)
        actual_compute = compute_type if actual_device == device else "default"
        if actual_device != device:
            logger.info("Transcription device: %s (compute_type: %s)", actual_device, actual_compute)

        model_kwargs: dict[str, object] = {
            "model_size_or_path": model_path,
            "device": actual_device,
            "compute_type": actual_compute,
            "device_index": gpu_device_index,
            "download_root": download_root,
        }

        if on_download_progress is not None:
            with _intercept_hf_progress(model_path, on_download_progress, cancel_check):
                self._model: Any = faster_whisper.WhisperModel(**model_kwargs)
        else:
            self._model = faster_whisper.WhisperModel(**model_kwargs)
        if batch_size > 0:
            self._model = faster_whisper.BatchedInferencePipeline(model=self._model)
        self._ready = True

    @override
    def transcribe(
        self,
        audio: AudioArray,
        language: str = "",
        use_prompt: bool = True,
    ) -> TranscriptionResult:
        start_t = time.time()

        if self._normalize_audio and audio.size > 0:
            peak = float(np.max(np.abs(audio)))
            if peak > 0:
                audio = (audio / peak * 0.95).astype(np.float32)

        prompt = self._initial_prompt if use_prompt else None

        kwargs: dict[str, object] = {
            "language": language if language else None,
            "beam_size": self._beam_size,
            "initial_prompt": prompt,
            "suppress_tokens": self._suppress_tokens,
            "vad_filter": self._vad_filter,
        }
        if self._batch_size > 0:
            kwargs["batch_size"] = self._batch_size

        try:
            segments, info = self._model.transcribe(audio, **kwargs)
            text = " ".join(seg.text for seg in segments).strip()
        except RuntimeError:
            # BatchedInferencePipeline raises when VAD finds no speech in audio
            text = ""
            info = None
        elapsed = time.time() - start_t

        return TranscriptionResult(
            text=text,
            language=str(getattr(info, "language", language)),
            language_probability=float(getattr(info, "language_probability", 0.0)),
            duration_seconds=elapsed,
        )

    @override
    def is_ready(self) -> bool:
        return self._ready

    @override
    def shutdown(self) -> None:
        self._ready = False
        # Release the model reference only.  Explicit CUDA cache clearing is
        # omitted — it can hang for minutes on certain driver combinations.
        # The server's os._exit(0) handles final CUDA teardown safely.
        self._model = None
