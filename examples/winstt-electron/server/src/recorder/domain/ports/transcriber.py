from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from src.building_blocks.types import AudioArray


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    language: str
    language_probability: float
    duration_seconds: float


class ITranscriber(ABC):
    @property
    def requires_warmup(self) -> bool:
        """Whether a dummy warmup inference pays off for this transcriber.

        Local ONNX engines JIT-compile kernels on first inference, so a warmup
        pass moves that cost off the first real PTT. Cloud/remote transcribers
        have no local kernels — a "warmup" would be a real, billed API
        round-trip over the WS RPC bridge that also races the electron
        connection at startup (a miss blocks for the full request timeout, then
        the server falls back to a local model). They opt out by overriding this
        to ``False``. Defaults to ``True`` so local adapters need no change.
        """
        return True

    @abstractmethod
    def transcribe(
        self,
        audio: AudioArray,
        language: str = "",
        use_prompt: bool = True,
        custom_words: list[str] | None = None,
        initial_prompt_text: str | None = None,
    ) -> TranscriptionResult: ...

    @abstractmethod
    def is_ready(self) -> bool: ...

    @abstractmethod
    def shutdown(self) -> None: ...
