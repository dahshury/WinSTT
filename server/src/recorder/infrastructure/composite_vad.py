from __future__ import annotations

from typing_extensions import override

from src.building_blocks.types import AudioChunk
from src.recorder.domain.ports.vad import IVoiceActivityDetector, VADResult


class CompositeVAD(IVoiceActivityDetector):
    def __init__(self, *, webrtc: IVoiceActivityDetector, silero: IVoiceActivityDetector) -> None:
        self._webrtc = webrtc
        self._silero = silero

    @override
    def detect(self, chunk: AudioChunk) -> VADResult:
        webrtc_result = self._webrtc.detect(chunk)
        if not webrtc_result.is_speech:
            return VADResult(is_speech=False, confidence=webrtc_result.confidence)
        silero_result = self._silero.detect(chunk)
        is_speech = webrtc_result.is_speech and silero_result.is_speech
        confidence = min(webrtc_result.confidence, silero_result.confidence)
        return VADResult(is_speech=is_speech, confidence=confidence)

    @override
    def reset(self) -> None:
        self._webrtc.reset()
        self._silero.reset()
