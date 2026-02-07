from __future__ import annotations

from typing import Any

import numpy as np
from typing_extensions import override

from src.building_blocks.types import AudioChunk
from src.recorder.domain.ports.wake_word import IWakeWordDetector, WakeWordResult

try:
    from openwakeword.model import Model as OWWModel
except ImportError:
    OWWModel = None


class OWWDetector(IWakeWordDetector):
    def __init__(
        self,
        *,
        model_paths: list[str] | None = None,
        inference_framework: str = "onnx",
        sensitivity: float = 0.6,
    ) -> None:
        if OWWModel is None:
            msg = "openwakeword is not installed"
            raise RuntimeError(msg)
        kwargs: dict[str, object] = {"inference_framework": inference_framework}
        if model_paths:
            kwargs["wakeword_models"] = model_paths
        self._model: Any = OWWModel(**kwargs)
        self._sensitivity = sensitivity

    @override
    def detect(self, chunk: AudioChunk) -> WakeWordResult:
        pcm = np.frombuffer(chunk, dtype=np.int16)
        self._model.predict(pcm)

        max_score: float = -1.0
        max_index: int = -1
        keys: list[str] = list(self._model.prediction_buffer.keys())

        for idx, mdl in enumerate(keys):
            scores: list[float] = list(self._model.prediction_buffer[mdl])
            if scores and scores[-1] >= self._sensitivity and scores[-1] > max_score:
                max_score = scores[-1]
                max_index = idx

        if max_index >= 0:
            word = keys[max_index] if max_index < len(keys) else ""
            return WakeWordResult(detected=True, word_index=max_index, word=str(word))
        return WakeWordResult(detected=False, word_index=-1, word="")

    @override
    def cleanup(self) -> None:
        pass
