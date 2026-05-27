"""Locale-aware filler-word stripping + stutter collapse.

Port of Handy's ``filter_transcription_output`` from
``examples/Handy/src-tauri/src/audio_toolkit/text.rs``. Runs after the
fuzzy dictionary corrector and before the per-sentence cleanup
(capitalisation, trailing period). Two transforms in one pass:

1. **Filler-word removal.** A locale-keyed table of disfluency tokens
   (English ``"uh"`` / ``"um"`` / ``"hmm"`` / etc., German ``"äh"``,
   etc.) is compiled to case-insensitive word-boundary regexes; matches
   are replaced with empty strings. Tokens that are real words in other
   languages (Portuguese ``"um"`` = "a/an"; Spanish ``"ha"`` = "has")
   are deliberately excluded from those locales' tables.

2. **Stutter collapse.** Three-or-more consecutive repetitions of the
   same alphabetic word (case-insensitive) collapse to a single
   instance. Mirrors the Whisper "wh wh wh what" / "I I I I think"
   artifact seen on noisy or low-SNR inputs.

The function is pure, idempotent, and locale-aware via a two-letter
base-language extraction (``"pt-BR"`` ↔ ``"pt"``). When ``lang`` is
unknown the fallback list is conservative — it strips obvious
disfluencies (``"uh"``, ``"hmm"``) but omits tokens that have
ambiguous semantics across languages (``"um"``, ``"eh"``, ``"ha"``).

The English coverage notably **excludes** ``"a"``, ``"the"``, and other
content words even though Whisper sometimes outputs them spuriously —
removing them would corrupt legitimate sentences far more often than
the spurious case justifies.
"""

from __future__ import annotations

import re

__all__ = [
    "DEFAULT_FILLERS_FALLBACK",
    "FILLERS_BY_LANG",
    "collapse_stutters",
    "filter_transcription_output",
    "get_filler_words_for_language",
]


# Per-language disfluency tables. Mirrors
# ``examples/Handy/src-tauri/src/audio_toolkit/text.rs::get_filler_words_for_language``.
# Key on the BASE language code (e.g. "en", "pt"); the locale parser
# strips the region tag before lookup so "en-US" and "pt-BR" route to
# the right table. Languages whose canonical fillers conflict with real
# words (Portuguese "um", Spanish "ha") deliberately omit those tokens.
FILLERS_BY_LANG: dict[str, tuple[str, ...]] = {
    "en": (
        "uh",
        "um",
        "uhm",
        "umm",
        "uhh",
        "uhhh",
        "ah",
        "hmm",
        "hm",
        "mmm",
        "mm",
        "mh",
        "eh",
        "ehh",
        "ha",
    ),
    "es": ("ehm", "mmm", "hmm", "hm"),
    "pt": ("ahm", "hmm", "mmm", "hm"),
    "fr": ("euh", "hmm", "hm", "mmm"),
    "de": ("äh", "ähm", "hmm", "hm", "mmm"),
    "it": ("ehm", "hmm", "mmm", "hm"),
    "cs": ("ehm", "hmm", "mmm", "hm"),
    "pl": ("hmm", "mmm", "hm"),
    "tr": ("hmm", "mmm", "hm"),
    "ru": ("хм", "ммм", "hmm", "mmm"),
    "uk": ("хм", "ммм", "hmm", "mmm"),
    "ar": ("hmm", "mmm"),
    "ja": ("hmm", "mmm"),
    "ko": ("hmm", "mmm"),
    "vi": ("hmm", "mmm", "hm"),
    "zh": ("hmm", "mmm"),
}


# Conservative cross-language fallback for unknown / unsupported
# language codes. Strips obvious disfluencies but omits tokens that
# carry meaning in any language we don't know about (``"um"``,
# ``"eh"``, ``"ha"``). Matches the Rust ``_`` arm.
DEFAULT_FILLERS_FALLBACK: tuple[str, ...] = (
    "uh",
    "uhm",
    "umm",
    "uhh",
    "uhhh",
    "ah",
    "hmm",
    "hm",
    "mmm",
    "mm",
    "mh",
    "ehh",
)


_MULTI_SPACE_RE = re.compile(r"\s{2,}")


def get_filler_words_for_language(lang: str) -> tuple[str, ...]:
    """Return the disfluency tuple for ``lang`` (base code lookup).

    ``"en"`` / ``"en-US"`` / ``"en_GB"`` all route to the ``"en"``
    table; unknown codes fall through to
    :data:`DEFAULT_FILLERS_FALLBACK`. Empty / falsy input also returns
    the fallback so callers don't have to pre-validate.
    """
    if not lang:
        return DEFAULT_FILLERS_FALLBACK
    base = re.split(r"[-_]", lang, maxsplit=1)[0]
    return FILLERS_BY_LANG.get(base, DEFAULT_FILLERS_FALLBACK)


def collapse_stutters(text: str) -> str:
    """Collapse 3+ consecutive identical alphabetic words to one.

    "I I I I think so so so so" → "I think so". Non-alphabetic tokens
    (punctuation, numbers, mixed) pass through untouched so
    ``"... ... ..."`` and ``"5 5 5"`` aren't collapsed (rarely a
    transcription artifact, often legitimate). Case-insensitive
    comparison but the kept token preserves its original casing.
    """
    words = text.split()
    if not words:
        return text
    result: list[str] = []
    i = 0
    while i < len(words):
        word = words[i]
        word_lower = word.lower()
        if word_lower.isalpha():
            count = 1
            while i + count < len(words) and words[i + count].lower() == word_lower:
                count += 1
            if count >= 3:
                result.append(word)
                i += count
                continue
        result.append(word)
        i += 1
    return " ".join(result)


def _compile_filler_patterns(fillers: tuple[str, ...] | list[str]) -> list[re.Pattern[str]]:
    """Compile each filler word into a case-insensitive word-boundary regex.

    The trailing ``[,.]?`` swallows a comma or period that immediately
    follows the disfluency so ``"Well, um, I think"`` collapses cleanly
    to ``"Well, I think"`` rather than ``"Well, , I think"``. Mirrors
    Handy's ``r"(?i)\\b{word}\\b[,.]?"`` pattern.
    """
    return [re.compile(rf"(?i)\b{re.escape(word)}\b[,.]?") for word in fillers if word]


def filter_transcription_output(
    text: str,
    lang: str,
    custom_filler_words: list[str] | None = None,
) -> str:
    """Strip fillers + collapse stutters + tidy whitespace.

    Args:
        text: Raw transcription text from the model.
        lang: BCP-47 / Whisper language code (``"en"``, ``"pt-BR"``,
            ``""``). Region tags are stripped before table lookup.
        custom_filler_words: Optional override.

            * ``None`` — use the per-language table from
              :func:`get_filler_words_for_language`.
            * ``[]`` (empty list) — disable filler removal entirely
              (stutter collapse + whitespace tidy still run). Lets
              users opt out per-locale without rewriting the whole
              feature flag.
            * non-empty list — use exactly these words instead of the
              language defaults.

    Returns:
        The cleaned text, with collapsed multiple spaces and trimmed
        leading / trailing whitespace.
    """
    if not text:
        return text
    if custom_filler_words is None:
        fillers: tuple[str, ...] | list[str] = get_filler_words_for_language(lang)
    else:
        fillers = custom_filler_words
    filtered = text
    for pattern in _compile_filler_patterns(fillers):
        filtered = pattern.sub("", filtered)
    filtered = collapse_stutters(filtered)
    filtered = _MULTI_SPACE_RE.sub(" ", filtered)
    return filtered.strip()
