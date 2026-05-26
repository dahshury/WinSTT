"""Deterministic fuzzy-dictionary corrector.

Port of Handy's ``apply_custom_words`` from
``examples/Handy/src-tauri/src/audio_toolkit/text.rs``. Given a raw
transcription and a list of canonical user-defined terms, this module
walks 1-3-word n-grams through the input and rewrites any window that
fuzz-matches a canonical term (Levenshtein normalized distance + Soundex
phonetic boost). The output preserves case from the first matched word
and any surrounding punctuation.

Why bother with a deterministic layer when we already have an LLM
modifier pipeline? Tokens are slow and expensive; for the common case
of "the model misheard a brand name" the fuzzy matcher is essentially
free and runs offline. The LLM pipeline still runs after this module so
anything we can't catch deterministically still gets a second chance
from the model.

Architecture: pure function, no I/O, no logging, no global state. Lives
under :mod:`src.recorder.text` so the application layer can import it
without violating the hexagonal "domain → application" direction.
"""

from __future__ import annotations

from jellyfish import soundex
from rapidfuzz.distance import Levenshtein

__all__ = ["apply_custom_words"]

# Default similarity threshold. Matches Handy's reference value (text.rs
# line 102). Lower thresholds reject more aggressively; raise this only
# if the matcher produces too many false negatives in practice.
DEFAULT_THRESHOLD: float = 0.18

# Phonetic boost factor — when Soundex codes match we multiply the
# Levenshtein score by this constant so phonetically equivalent strings
# clear the threshold even if their letter shapes diverge a lot. Mirrors
# Handy's ``levenshtein_score * 0.3`` line.
_PHONETIC_BOOST: float = 0.3

# Maximum candidate length the matcher will consider. Anything longer is
# almost certainly a multi-word stretch the n-gram windows have already
# scanned past; running Levenshtein on 50+ char strings adds latency for
# no payoff. Matches Handy's ``candidate.len() > 50`` guard.
_MAX_CANDIDATE_LEN: int = 50

# N-gram width range. Handy uses 1..=3 reversed (longest first) so a
# 3-word match wins over the 1-word fallback inside its window. We keep
# the same width range for parity.
_MAX_NGRAM_WIDTH: int = 3


def apply_custom_words(
    text: str,
    custom_words: list[str],
    threshold: float = DEFAULT_THRESHOLD,
) -> str:
    """Replace n-gram matches in ``text`` with canonical custom words.

    The algorithm mirrors Handy's Rust implementation 1:1:

    1. Pre-compute lowercase + space-stripped versions of each custom
       word once so the inner loop avoids reallocations.
    2. Split the input on whitespace into ``words``.
    3. For each cursor position, try the longest possible n-gram (3 →
       2 → 1) first. Strip punctuation from each word, lowercase, and
       concatenate without spaces — this lets the matcher see "Charge B"
       as a candidate for "ChargeBee".
    4. Score the candidate against every custom word using
       ``rapidfuzz.distance.Levenshtein.normalized_distance`` (the
       distance divided by ``max(len_a, len_b)``). If the Soundex codes
       match, multiply by 0.3 so phonetic near-misses count more.
    5. Accept the best match below ``threshold`` and below the running
       best score. On hit, preserve the case of the first n-gram word
       and re-emit the punctuation prefix/suffix.
    6. On a hit the cursor jumps forward by the n-gram width; on a miss
       only by one word.

    ``custom_words`` is the source of canonical replacements — its
    casing is preserved verbatim modulo the leading-uppercase /
    all-uppercase rules in :func:`_preserve_case_pattern`.

    Args:
        text: Raw transcription, possibly with punctuation.
        custom_words: Canonical spellings to bias toward. Empty list →
            ``text`` is returned unchanged.
        threshold: Maximum acceptable combined score. Lower = stricter.
            Defaults to :data:`DEFAULT_THRESHOLD` (0.18, same as Handy).

    Returns:
        ``text`` with each matched n-gram rewritten in place.
    """
    if not custom_words or not text:
        return text

    custom_words_lower = [w.lower() for w in custom_words]
    custom_words_nospace = [w.replace(" ", "") for w in custom_words_lower]

    words = text.split()
    if not words:
        return text

    result: list[str] = []
    i = 0
    while i < len(words):
        match_width = _try_match_at(words, i, custom_words, custom_words_nospace, threshold, result)
        i += match_width if match_width > 0 else 1
    return " ".join(result)


def _try_match_at(
    words: list[str],
    start: int,
    custom_words: list[str],
    custom_words_nospace: list[str],
    threshold: float,
    result: list[str],
) -> int:
    """Try the 3→2→1 n-gram cascade at ``start``, appending to ``result``.

    Returns the width of the matched n-gram, or ``0`` if no n-gram
    matched. On no-match the caller appends ``words[start]`` and
    advances by 1.
    """
    for width in range(_MAX_NGRAM_WIDTH, 0, -1):
        if start + width > len(words):
            continue
        ngram_words = words[start : start + width]
        ngram = _build_ngram(ngram_words)
        replacement = _find_best_match(ngram, custom_words, custom_words_nospace, threshold)
        if replacement is None:
            continue
        prefix, _ = _extract_punctuation(ngram_words[0])
        _, suffix = _extract_punctuation(ngram_words[width - 1])
        corrected = _preserve_case_pattern(ngram_words[0], replacement)
        result.append(f"{prefix}{corrected}{suffix}")
        return width
    result.append(words[start])
    return 0


def _build_ngram(words: list[str]) -> str:
    """Strip punctuation, lowercase, concatenate without spaces.

    This is the candidate string fed to the fuzzy matcher. Handy uses
    ``trim_matches(|c: char| !c.is_alphanumeric())`` which strips
    leading/trailing non-alphanumeric characters but keeps any
    alphanumeric content in the middle.
    """
    cleaned: list[str] = []
    for word in words:
        cleaned.append(_strip_non_alnum(word).lower())
    return "".join(cleaned)


def _strip_non_alnum(word: str) -> str:
    """Trim leading and trailing non-alphanumeric characters from ``word``.

    Matches Rust's ``str::trim_matches(|c| !c.is_alphanumeric())``.
    """
    start = 0
    end = len(word)
    while start < end and not word[start].isalnum():
        start += 1
    while end > start and not word[end - 1].isalnum():
        end -= 1
    return word[start:end]


def _find_best_match(
    candidate: str,
    custom_words: list[str],
    custom_words_nospace: list[str],
    threshold: float,
) -> str | None:
    """Best fuzzy match for ``candidate``, or ``None``.

    Returns the canonical custom word (preserving its source casing) of
    the best scoring entry below ``threshold``. Phonetic matches
    (Soundex code equality) receive a 0.3 boost — i.e. their effective
    score is multiplied by 0.3 — so they out-rank purely typographic
    matches at equivalent edit distance.
    """
    if not candidate or len(candidate) > _MAX_CANDIDATE_LEN:
        return None

    best_match: str | None = None
    best_score = float("inf")

    candidate_soundex = soundex(candidate)
    for i, custom_word_nospace in enumerate(custom_words_nospace):
        if not _length_compatible(candidate, custom_word_nospace):
            continue

        levenshtein_score = _normalized_levenshtein(candidate, custom_word_nospace)
        combined_score = _combine_with_phonetics(
            levenshtein_score,
            candidate_soundex,
            soundex(custom_word_nospace),
        )

        if combined_score < threshold and combined_score < best_score:
            best_match = custom_words[i]
            best_score = combined_score

    return best_match


def _length_compatible(candidate: str, custom_word_nospace: str) -> bool:
    """Reject pairs whose lengths differ by more than 25% (and ≥ 2 chars).

    Matches Handy's optimization comment: "max 25% length difference
    (prevents n-grams from matching significantly shorter custom words,
    e.g. 'openaigpt' vs 'openai')".
    """
    len_diff = abs(len(candidate) - len(custom_word_nospace))
    max_len = max(len(candidate), len(custom_word_nospace))
    max_allowed_diff = max(max_len * 0.25, 2.0)
    return len_diff <= max_allowed_diff


def _normalized_levenshtein(a: str, b: str) -> float:
    """Levenshtein distance divided by ``max(len(a), len(b))``.

    Yields a 0..1 score where 0 means "identical" and 1 means "nothing
    in common". Empty inputs map to 1.0 (treated as "no match" by the
    caller). Rapidfuzz already implements this directly.
    """
    if not a and not b:
        return 1.0
    return float(Levenshtein.normalized_distance(a, b))


def _combine_with_phonetics(levenshtein_score: float, code_a: str, code_b: str) -> float:
    """Boost ``levenshtein_score`` when Soundex codes match.

    Returns ``score * 0.3`` on a phonetic hit, ``score`` otherwise.
    Empty Soundex codes (jellyfish returns ``""`` for unmappable input)
    never overlap, matching how Handy's ``natural::phonetics::soundex``
    behaves on similarly degenerate inputs.
    """
    if code_a and code_b and code_a == code_b:
        return levenshtein_score * _PHONETIC_BOOST
    return levenshtein_score


def _preserve_case_pattern(original: str, replacement: str) -> str:
    """Apply ``original``'s case pattern to ``replacement``.

    Three patterns are recognised:

    * ``ALL UPPERCASE`` → return ``replacement.upper()``.
    * ``Titlecased`` (first char upper, rest mixed) → uppercase only the
      first character of ``replacement``.
    * Anything else → ``replacement`` verbatim (we trust the user's
      canonical spelling).
    """
    if original and original.isupper():
        return replacement.upper()
    if original and original[0].isupper():
        if not replacement:
            return replacement
        return replacement[0].upper() + replacement[1:]
    return replacement


def _extract_punctuation(word: str) -> tuple[str, str]:
    """Return the leading + trailing non-alphanumeric runs of ``word``.

    Mirrors Handy's ``extract_punctuation`` so an input like
    ``"hello,"`` keeps the trailing comma after replacement, and
    ``"(foo)"`` keeps the surrounding parens.
    """
    prefix_end = 0
    while prefix_end < len(word) and not word[prefix_end].isalnum():
        prefix_end += 1

    suffix_start = len(word)
    while suffix_start > prefix_end and not word[suffix_start - 1].isalnum():
        suffix_start -= 1

    return word[:prefix_end], word[suffix_start:]
