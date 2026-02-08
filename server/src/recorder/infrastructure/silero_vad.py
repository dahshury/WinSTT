from __future__ import annotations

from typing import Any

import numpy as np
import torch
from numpy.typing import NDArray
from typing_extensions import override

from src.building_blocks.types import AudioChunk
from src.recorder.domain.ports.vad import IVoiceActivityDetector, VADResult

_SAMPLE_RATE = 16000
_INT16_MAX_ABS_VALUE = 32768.0


class SileroVAD(IVoiceActivityDetector):
    def __init__(self, *, sensitivity: float = 0.4, use_onnx: bool = False, sample_rate: int = 16000) -> None:
        self._sensitivity = sensitivity
        self._sample_rate = sample_rate
        self._model: Any
        self._model, _ = torch.hub.load(  # type: ignore[no-untyped-call]
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            verbose=False,
            onnx=use_onnx,
        )

    @property
    def sensitivity(self) -> float:
        return self._sensitivity

    @sensitivity.setter
    def sensitivity(self, value: float) -> None:
        self._sensitivity = value

    @override
    def detect(self, chunk: AudioChunk) -> VADResult:
        if self._sample_rate != _SAMPLE_RATE:
            from scipy.signal import resample_poly

            pcm = np.frombuffer(chunk, dtype=np.int16)
            resampled: NDArray[np.float64] = resample_poly(pcm.astype(np.float64), _SAMPLE_RATE, self._sample_rate)
            chunk = resampled.astype(np.int16).tobytes()

        audio_chunk = np.frombuffer(chunk, dtype=np.int16)
        audio_float = audio_chunk.astype(np.float32) / _INT16_MAX_ABS_VALUE
        tensor: Any = torch.from_numpy(audio_float)
        vad_prob: float = self._model(tensor, _SAMPLE_RATE).item()
        is_speech = vad_prob > (1 - self._sensitivity)
        return VADResult(is_speech=is_speech, confidence=vad_prob)

    @override
    def reset(self) -> None:
        self._model.reset_states()
