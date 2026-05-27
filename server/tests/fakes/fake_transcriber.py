from __future__ import annotations

from typing_extensions import override

from src.building_blocks.types import AudioArray
from src.recorder.domain.ports.transcriber import ITranscriber, TranscriptionResult


class FakeTranscriber(ITranscriber):
    def __init__(
        self,
        result: TranscriptionResult | None = None,
    ) -> None:
        self._result = result or TranscriptionResult(
            text="fake transcription",
            language="en",
            language_probability=0.99,
            duration_seconds=1.0,
        )
        self._ready = True
        self._call_count = 0
        self._shutdown_called = False

    @override
    def transcribe(
        self,
        audio: AudioArray,
        language: str = "",
        use_prompt: bool = True,
        custom_words: list[str] | None = None,
        initial_prompt_text: str | None = None,
    ) -> TranscriptionResult:
        self._call_count += 1
        self._last_custom_words = custom_words
        self._last_initial_prompt_text = initial_prompt_text
        return self._result

    @property
    def last_custom_words(self) -> list[str] | None:
        return getattr(self, "_last_custom_words", None)

    @property
    def last_initial_prompt_text(self) -> str | None:
        return getattr(self, "_last_initial_prompt_text", None)

    @override
    def is_ready(self) -> bool:
        return self._ready

    @override
    def shutdown(self) -> None:
        self._shutdown_called = True
        self._ready = False

    @property
    def call_count(self) -> int:
        return self._call_count

    @property
    def shutdown_called(self) -> bool:
        return self._shutdown_called

    def set_result(self, result: TranscriptionResult) -> None:
        self._result = result
