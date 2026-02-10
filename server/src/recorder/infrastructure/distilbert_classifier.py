from __future__ import annotations

import logging
import re
from functools import lru_cache
from typing import Any

from typing_extensions import override

from src.recorder.domain.ports.sentence_classifier import ISentenceClassifier

logger = logging.getLogger(__name__)

# Strip trailing non-alpha characters for cleaner classification
_TRAILING_NON_ALPHA = re.compile(r"[^a-zA-Z]+$")


class DistilBertClassifier(ISentenceClassifier):
    """DistilBERT-based sentence completion classifier.

    Loads ``KoljaB/SentenceFinishedClassification`` (or a custom model)
    and returns the probability that the input text is a complete sentence.
    """

    def __init__(self, model_name: str = "KoljaB/SentenceFinishedClassification", device: str = "cuda") -> None:
        self._model_name = model_name
        self._device = device
        self._model: Any = None
        self._tokenizer: Any = None
        self._available = False
        self._load()

    def _load(self) -> None:
        try:
            import torch
            from transformers import (  # type: ignore[attr-defined]
                DistilBertForSequenceClassification,
                DistilBertTokenizerFast,
            )

            device = self._device
            if device == "cuda" and not torch.cuda.is_available():
                device = "cpu"

            self._tokenizer = DistilBertTokenizerFast.from_pretrained(self._model_name)
            self._model = DistilBertForSequenceClassification.from_pretrained(self._model_name).to(device)  # type: ignore[arg-type]
            self._model.eval()
            self._device = device
            self._available = True
            logger.info("Loaded sentence classifier: %s on %s", self._model_name, device)
        except ImportError:
            logger.warning("transformers not installed — sentence classifier unavailable")
            self._available = False
        except Exception:
            logger.exception("Failed to load sentence classifier")
            self._available = False

    @override
    def classify(self, text: str) -> float:
        if not self._available:
            return 0.0
        cleaned = _TRAILING_NON_ALPHA.sub("", text.strip())
        if not cleaned:
            return 0.0
        return self._classify_cached(cleaned)

    @lru_cache(maxsize=512)  # noqa: B019
    def _classify_cached(self, text: str) -> float:
        import torch

        inputs = self._tokenizer(
            text,
            return_tensors="pt",
            truncation=True,
            max_length=128,
            padding=True,
        )
        inputs = {k: v.to(self._device) for k, v in inputs.items()}
        with torch.no_grad():
            logits = self._model(**inputs).logits
        probs = torch.softmax(logits, dim=-1)
        # Class 1 = complete sentence
        prob_complete: float = probs[0][1].item()
        return prob_complete

    @override
    def is_available(self) -> bool:
        return self._available

    @override
    def shutdown(self) -> None:
        self._model = None
        self._tokenizer = None
        self._available = False
        self._classify_cached.cache_clear()
