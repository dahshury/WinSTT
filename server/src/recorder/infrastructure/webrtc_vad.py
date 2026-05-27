from __future__ import annotations

from typing import Any

import numpy as np
from numpy.typing import NDArray
from scipy.signal import resample_poly
from typing_extensions import override

from src.building_blocks.types import AudioChunk
from src.recorder.domain.ports.vad import IVoiceActivityDetector, VADResult

try:
    import webrtcvad
except ImportError:
    webrtcvad = None

_SAMPLE_RATE = 16000


class WebRTCVAD(IVoiceActivityDetector):
    def __init__(self, *, sensitivity: int = 3, sample_rate: int = 16000) -> None:
        if webrtcvad is None:
            msg = "webrtcvad is not installed"
            raise RuntimeError(msg)
        self._model: Any = webrtcvad.Vad()
        self._sensitivity = sensitivity
        self._model.set_mode(sensitivity)
        self._sample_rate = sample_rate
        self._is_active = False

    @property
    def sensitivity(self) -> int:
        return self._sensitivity

    def set_sensitivity(self, sensitivity: int) -> None:
        """Retune the WebRTC aggressiveness in-place (0..3).

        webrtcvad's ``set_mode`` is a cheap setter on the underlying C
        VAD struct — safe to call from any thread that holds a transient
        reference (the detect() loop reads ``is_speech`` per chunk and
        doesn't pin the mode for the duration of a recording).
        """
        clamped = max(0, min(3, int(sensitivity)))
        self._sensitivity = clamped
        self._model.set_mode(clamped)

    @override
    def detect(self, chunk: AudioChunk) -> VADResult:
        if self._sample_rate != _SAMPLE_RATE:
            pcm = np.frombuffer(chunk, dtype=np.int16)
            resampled: NDArray[np.float64] = resample_poly(pcm.astype(np.float64), _SAMPLE_RATE, self._sample_rate)
            chunk = resampled.astype(np.int16).tobytes()

        frame_length = int(_SAMPLE_RATE * 0.01)
        num_frames = len(chunk) // (2 * frame_length)
        speech_frames = 0

        for i in range(num_frames):
            start = i * frame_length * 2
            end = start + frame_length * 2
            frame = chunk[start:end]
            if len(frame) == frame_length * 2 and self._model.is_speech(frame, _SAMPLE_RATE):
                speech_frames += 1

        is_speech = speech_frames > 0
        confidence = speech_frames / max(num_frames, 1)
        self._is_active = is_speech
        return VADResult(is_speech=is_speech, confidence=confidence)

    @override
    def reset(self) -> None:
        self._is_active = False
