"""Word-level timestamp alignment for playback highlighting and word-level SRT.

Strategy (tiered, torch-free):

1. **Native** — when the aligning model exposes word timestamps (a Whisper
   ``*_timestamped`` export, via cross-attention DTW), use them directly.
2. **Use-our-words fallback** — for any other transcript we already trust
   (a history entry's text, or a non-timestamped model's SRT output), run the
   tiny timestamped Whisper purely for *timing*, then sequence-align its word
   list onto OUR words and transfer the timestamps. The displayed words are
   always the real transcript — zero drift from a second transcription.

Blocking (model load + inference) — callers run :meth:`align` off the asyncio
event loop. Whisper is 30 s-bounded, so callers MUST keep each clip under a
single window (history clips are short; the SRT path aligns per VAD segment).
"""

from __future__ import annotations

import difflib
import logging
import re
import threading
from typing import Any, Final

logger = logging.getLogger(__name__)

#: Multilingual tiny Whisper export exposing ``cross_attentions.*`` decoder
#: outputs (what the fork's DTW needs). ~40 MB, downloaded once and HF-cached.
DEFAULT_ALIGN_MODEL: Final = "onnx-community/whisper-tiny_timestamped"

# Strip everything but alphanumerics for matching, so " Let's" ↔ "Let's" and
# "dog." ↔ "dog" line up across the two tokenizations.
_NORM_RE = re.compile(r"[^0-9a-z]+")


def _norm(word: str) -> str:
    return _NORM_RE.sub("", word.lower())


def _enforce_monotonic(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Clamp starts/ends non-decreasing so the highlight never jumps backward."""
    prev = 0.0
    for w in words:
        start = max(float(w["start"]), prev)
        end = max(float(w["end"]), start)
        w["start"], w["end"] = start, end
        prev = start
    return words


# Word-start markers across tokenizers: ASCII space, SentencePiece ``▁``
# (NeMo / Kaldi / GigaAM / T-one), and BPE ``Ġ`` (Whisper-style).
_WORD_START = (" ", "▁", "Ġ")


def group_tokens_to_words(tokens: list[str], timestamps: list[float]) -> list[dict[str, Any]]:
    """Group per-token strings+emit-times into word-level ``{text,start,end}``.

    Native CTC / RNN-T / TDT models (NeMo, GigaAM, Kaldi, T-one) emit one
    timestamp per *token*; a new word begins at a token carrying a word-start
    marker. Each word's ``start`` is its first token's time and ``end`` is the
    next word's start (the last word ends at its final token's time).
    """
    pairs = list(zip(tokens, timestamps, strict=False))
    words: list[dict[str, Any]] = []
    text = ""
    start: float | None = None
    for tok, ts in pairs:
        if text and tok[:1] in _WORD_START:
            words.append({"text": text.strip(), "start": start or 0.0, "end": float(ts)})
            text, start = "", None
        if start is None:
            start = float(ts)
        text += tok.replace("▁", " ").replace("Ġ", " ")
    if text.strip():
        last = float(timestamps[-1]) if timestamps else (start or 0.0)
        words.append({"text": text.strip(), "start": start or 0.0, "end": last})
    return _enforce_monotonic([w for w in words if w["text"]])


def map_timings_to_text(aligned: list[dict[str, Any]], known_text: str) -> list[dict[str, Any]]:
    """Relabel the aligner's timed words with OUR ``known_text`` words.

    Sequence-aligns the two word streams (normalised) and transfers each
    aligned word's ``start``/``end`` onto the matching known word. Spans the
    aligner couldn't match (``replace``) are time-distributed proportionally;
    pure ``insert`` known words get a zero-length stamp at the boundary. The
    result is exactly ``known_text``'s words, in order, with monotonic times.
    """
    known = known_text.split()
    if not (known and aligned):
        return aligned
    sm = difflib.SequenceMatcher(a=[_norm(w["text"]) for w in aligned], b=[_norm(w) for w in known], autojunk=False)
    out: list[dict[str, Any]] = [{"text": k, "start": 0.0, "end": 0.0} for k in known]
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for off in range(j2 - j1):
                src = aligned[i1 + off]
                out[j1 + off] = {"text": known[j1 + off], "start": float(src["start"]), "end": float(src["end"])}
            continue
        # replace / insert / delete: time-distribute the aligned span (if any)
        # across the known span. `delete` (no known words) is a no-op here.
        span = aligned[i1:i2]
        start = float(span[0]["start"]) if span else (float(aligned[i1 - 1]["end"]) if i1 > 0 else 0.0)
        end = float(span[-1]["end"]) if span else start
        count = j2 - j1
        for off in range(count):
            frac_s = off / count
            frac_e = (off + 1) / count
            out[j1 + off] = {
                "text": known[j1 + off],
                "start": start + (end - start) * frac_s,
                "end": start + (end - start) * frac_e,
            }
    return _enforce_monotonic(out)


class WordAligner:
    """Lazy CPU word-timestamp aligner. Thread-safe model build under a lock."""

    def __init__(self, model_name: str = DEFAULT_ALIGN_MODEL) -> None:
        self._model_name = model_name
        self._model: Any = None
        self._lock = threading.Lock()

    def _ensure_model(self) -> Any:  # noqa: ANN401 — onnx-asr adapter is untyped
        if self._model is not None:
            return self._model
        with self._lock:
            if self._model is None:
                import onnx_asr  # heavy; import lazily

                logger.info("WordAligner: loading %s (CPU)", self._model_name)
                self._model = onnx_asr.load_model(
                    self._model_name, providers=["CPUExecutionProvider"]
                ).with_timestamps()
        return self._model

    def align(self, wav_path: str, known_text: str = "") -> list[dict[str, Any]]:
        """Return per-word timings ``[{"text", "start", "end"}]`` for ``wav_path``.

        When ``known_text`` is given, the returned words are exactly its words
        (timed by mapping the aligner's output onto them — no transcription
        drift). Otherwise the aligner's own transcription is returned. Empty
        list on any failure (missing file, decode error) — highlighting is a
        best-effort enhancement, never fatal.

        (A teacher-forced single-pass variant was prototyped but benchmarked
        slower on typical short clips — the audio encoder dominates and the
        autoregressive decode is already cheap — so we keep the straightforward
        re-transcribe-and-map path. See the Whisper timestamp speed research.)
        """
        try:
            model = self._ensure_model()
            result = model.recognize(wav_path, return_word_timestamps=True)
        except Exception:
            logger.exception("WordAligner.align failed for %s", wav_path)
            return []
        words = [
            {"text": w.text, "start": float(w.start), "end": float(w.end)}
            for w in (getattr(result, "words", None) or [])
        ]
        if known_text.strip():
            return map_timings_to_text(words, known_text)
        return words
