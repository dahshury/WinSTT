from __future__ import annotations

from abc import ABC, abstractmethod


class ISentenceClassifier(ABC):
    @abstractmethod
    def classify(self, text: str) -> float:
        """Return probability [0.0, 1.0] that text is a complete sentence."""

    @abstractmethod
    def is_available(self) -> bool: ...

    @abstractmethod
    def shutdown(self) -> None: ...
