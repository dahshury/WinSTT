from __future__ import annotations

import logging
import threading
from typing import Any

import numpy as np
from typing_extensions import override

from src.building_blocks.types import AudioArray
from src.recorder.domain.events import SpeakerSegment
from src.recorder.domain.ports.diarizer import IDiarizer

logger = logging.getLogger(__name__)

try:
    import onnx_asr
except ImportError:
    onnx_asr = None  # type: ignore[assignment]


class OnnxAsrDiarizer(IDiarizer):
    """Adapter wrapping :func:`onnx_asr.load_session_diarizer`.

    Lazy-loads pyannote-segmentation-3.0 + wespeaker-resnet34-LM on first
    :meth:`diarize` call (downloads ~32 MB from HF on first run, then cached).
    Subsequent calls reuse the same ORT sessions and the same
    :class:`OnlineSpeakerClustering` state, so speaker ids stay stable across
    the entire recorder lifetime until :meth:`reset` is called.
    """

    def __init__(
        self,
        *,
        max_speakers: int = 8,
        delta_new: float = 0.5,
        rho_update: float = 0.3,
        segmentation_model: str = "onnx-community/pyannote-segmentation-3.0",
        embedding_model: str = "wespeaker-voxceleb-resnet34-LM",
        providers: tuple[str, ...] | None = None,
    ) -> None:
        if onnx_asr is None:
            msg = "onnx-asr is not installed; install ``onnx-asr[hub]`` to enable diarization"
            raise ImportError(msg)
        self._max_speakers = max_speakers
        self._delta_new = delta_new
        self._rho_update = rho_update
        self._segmentation_model = segmentation_model
        self._embedding_model = embedding_model
        self._providers = providers
        self._session: Any = None
        self._lock = threading.Lock()

    def _ensure_session(self) -> Any:  # noqa: ANN401
        if self._session is not None:
            return self._session
        with self._lock:
            if self._session is None:
                kwargs: dict[str, Any] = {
                    "segmentation_model": self._segmentation_model,
                    "embedding_model": self._embedding_model,
                    "max_speakers": self._max_speakers,
                    "delta_new": self._delta_new,
                    "rho_update": self._rho_update,
                }
                if self._providers is not None:
                    kwargs["providers"] = list(self._providers)
                logger.info(
                    "[diarizer] loading session diarizer (seg=%s emb=%s max_spk=%d)",
                    self._segmentation_model,
                    self._embedding_model,
                    self._max_speakers,
                )
                self._session = onnx_asr.load_session_diarizer(**kwargs)
        return self._session

    @override
    def diarize(self, audio: AudioArray) -> tuple[SpeakerSegment, ...]:
        if audio.size == 0:
            return ()
        # The diarizer expects float32 in [-1, 1]; AudioArray already is.
        waveform = audio.astype(np.float32, copy=False)
        try:
            session = self._ensure_session()
            segments = session.diarize(waveform, sample_rate=16_000)
        except Exception:  # diarization must never crash the recorder
            logger.exception("[diarizer] diarize() failed; returning empty segments")
            return ()
        return tuple(SpeakerSegment(start=s.start, end=s.end, speaker=s.speaker) for s in segments)

    @override
    def reset(self) -> None:
        if self._session is not None:
            with self._lock:
                if self._session is not None:
                    self._session.reset()

    @override
    def shutdown(self) -> None:
        with self._lock:
            if self._session is not None:
                try:
                    self._session.close()
                except Exception:
                    logger.exception("[diarizer] shutdown failed; ignoring")
                self._session = None
