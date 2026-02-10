from __future__ import annotations

from typing_extensions import override

from src.recorder.domain.ports.sentence_classifier import ISentenceClassifier


class FakeSentenceClassifier(ISentenceClassifier):
    def __init__(self, fixed_prob: float = 1.0) -> None:
        self._prob = fixed_prob
        self._available = True
        self._shutdown = False

    @override
    def classify(self, text: str) -> float:
        return self._prob

    @override
    def is_available(self) -> bool:
        return self._available

    @override
    def shutdown(self) -> None:
        self._shutdown = True
        self._available = False

    def set_prob(self, prob: float) -> None:
        self._prob = prob

    def set_available(self, available: bool) -> None:
        self._available = available
