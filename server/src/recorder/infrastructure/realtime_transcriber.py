from __future__ import annotations

import logging
import time
from typing import Any

from typing_extensions import override

from src.building_blocks.types import AudioArray
from src.recorder.domain.ports.transcriber import ITranscriber, TranscriptionResult
from src.recorder.infrastructure.device import resolve_device

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
        batch_size: int = 16,
    ) -> None:
        if faster_whisper is None:
            msg = "faster_whisper is not installed"
            raise RuntimeError(msg)
        self._beam_size = beam_size
        self._initial_prompt = initial_prompt
        self._batch_size = batch_size
        self._ready = False

        actual_device = resolve_device(device)
        actual_compute = compute_type if actual_device == device else "default"
        if actual_device != device:
            logger.info("Realtime transcription device: %s (compute_type: %s)", actual_device, actual_compute)

        self._model: Any = faster_whisper.WhisperModel(
            model_size_or_path=model_path,
            device=actual_device,
            compute_type=actual_compute,
            device_index=gpu_device_index,
            download_root=download_root,
        )
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
        }
        if self._batch_size > 0:
            kwargs["batch_size"] = self._batch_size

        segments, info = self._model.transcribe(audio, **kwargs)
        text = " ".join(seg.text for seg in segments).strip()
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
        self._model = None
