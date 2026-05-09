from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

from typing_extensions import override

from src.building_blocks.types import AudioArray
from src.recorder.domain.events import DownloadProgress
from src.recorder.domain.ports.transcriber import ITranscriber, TranscriptionResult
from src.recorder.infrastructure.device import resolve_device
from src.recorder.infrastructure.whisper_transcriber import _intercept_hf_progress

logger = logging.getLogger(__name__)

try:
    import faster_whisper
except ImportError:
    faster_whisper = None


class RealtimeTranscriber(ITranscriber):
    def __init__(
        self,
        *,
        model_path: str = "tiny",
        device: str = "cuda",
        compute_type: str = "default",
        gpu_device_index: int | list[int] = 0,
        download_root: str | None = None,
        beam_size: int = 3,
        initial_prompt: str | list[int] | None = None,
        suppress_tokens: list[int] | None = None,
        batch_size: int = 16,
        vad_filter: bool = True,
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
        self._ready = False

        actual_device = resolve_device(device)
        actual_compute = compute_type if actual_device == device else "default"
        if actual_device != device:
            logger.info("Realtime transcription device: %s (compute_type: %s)", actual_device, actual_compute)

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
        prompt = self._initial_prompt if use_prompt else None

        kwargs: dict[str, object] = {
            "language": language if language else None,
            "beam_size": self._beam_size,
            "initial_prompt": prompt,
            "suppress_tokens": self._suppress_tokens,
            # Required so BatchedInferencePipeline can slide its 30s context
            # window over longer audio; without it, recordings >30s produce
            # repeating output that trips the noise-repetition detector.
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
