"""Deterministic fuzzy-dictionary corrector.

Given a raw transcription and a list of canonical user-defined terms,
this module walks 1-3-word n-grams through the input and rewrites any
window that fuzz-matches a canonical term (Levenshtein normalized
distance + Soundex phonetic boost). The output preserves case from the
first matched word and any surrounding punctuation.

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

# Default similarity threshold. Reference default 0.18. Lower thresholds
# reject more aggressively; raise this only if the matcher produces too
# many false negatives in practice.
DEFAULT_THRESHOLD: float = 0.18

# Phonetic boost factor — when Soundex codes match we multiply the
# Levenshtein score by this constant so phonetically equivalent strings
# clear the threshold even if their letter shapes diverge a lot
# (``levenshtein_score * 0.3``).
_PHONETIC_BOOST: float = 0.3

# Maximum candidate length the matcher will consider. Anything longer is
# almost certainly a multi-word stretch the n-gram windows have already
# scanned past; running Levenshtein on 50+ char strings adds latency for
# no payoff (the ``candidate.len() > 50`` guard).
_MAX_CANDIDATE_LEN: int = 50

# N-gram width range. Widths 1..3 are tried reversed (longest first) so a
# 3-word match wins over the 1-word fallback inside its window.
_MAX_NGRAM_WIDTH: int = 3


def apply_custom_words(
    text: str,
    custom_words: list[str],
    threshold: float = DEFAULT_THRESHOLD,
) -> str:
    """Replace n-gram matches in ``text`` with canonical custom words.

    The algorithm proceeds as follows:

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
            Defaults to :data:`DEFAULT_THRESHOLD` (0.18).

    Returns:
        ``text`` with each matched n-gram rewritten in place.
    """
    words = text.split()
    if any([not custom_words, not words]):
        return text

    custom_words_nospace = [w.lower().replace(" ", "") for w in custom_words]
    return _rewrite_words(words, custom_words, custom_words_nospace, threshold)


def _rewrite_words(
    words: list[str],
    custom_words: list[str],
    custom_words_nospace: list[str],
    threshold: float,
) -> str:
    """Drive the n-gram cursor over ``words`` and join the rewritten output.

    The cursor advances by the matched n-gram width on a hit and by a
    single word on a miss (see :func:`_advance_step`).
    """
    result: list[str] = []
    i = 0
    while i < len(words):
        match_width = _try_match_at(words, i, custom_words, custom_words_nospace, threshold, result)
        i += _advance_step(match_width)
    return " ".join(result)


def _advance_step(match_width: int) -> int:
    """Cursor delta for a given match width — the width on a hit, else 1."""
    return match_width if match_width > 0 else 1


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
        formatted = _format_width_match(words, start, width, custom_words, custom_words_nospace, threshold)
        if formatted is not None:
            result.append(formatted)
            return width
    result.append(words[start])
    return 0


def _format_width_match(
    words: list[str],
    start: int,
    width: int,
    custom_words: list[str],
    custom_words_nospace: list[str],
    threshold: float,
) -> str | None:
    """Format the punctuation-wrapped replacement for one n-gram width.

    Returns ``None`` when the window runs past the end of ``words`` or
    when no custom word matches the candidate, signalling the caller to
    try the next (narrower) width.
    """
    if start + width > len(words):
        return None
    ngram_words = words[start : start + width]
    ngram = _build_ngram(ngram_words)
    replacement = _find_best_match(ngram, custom_words, custom_words_nospace, threshold)
    if replacement is None:
        return None
    prefix, _ = _extract_punctuation(ngram_words[0])
    _, suffix = _extract_punctuation(ngram_words[width - 1])
    corrected = _preserve_case_pattern(ngram_words[0], replacement)
    return f"{prefix}{corrected}{suffix}"


def _build_ngram(words: list[str]) -> str:
    """Strip punctuation, lowercase, concatenate without spaces.

    This is the candidate string fed to the fuzzy matcher. Leading and
    trailing non-alphanumeric characters are stripped, but any
    alphanumeric content in the middle is kept.
    """
    cleaned: list[str] = []
    for word in words:
        cleaned.append(_strip_non_alnum(word).lower())
    return "".join(cleaned)


def _strip_non_alnum(word: str) -> str:
    """Trim leading and trailing non-alphanumeric characters from ``word``.

    Matches Rust's ``str::trim_matches(|c| !c.is_alphanumeric())``.
    """
    start = _first_alnum_index(word, 0, len(word))
    end = _last_alnum_boundary(word, start, len(word))
    return word[start:end]


def _first_alnum_index(word: str, lo: int, hi: int) -> int:
    """Index of the first alphanumeric char in ``word[lo:hi]`` (or ``hi``).

    Scans forward from ``lo``, skipping non-alphanumeric characters, and
    returns ``hi`` when the whole window is non-alphanumeric.
    """
    while lo < hi and not word[lo].isalnum():
        lo += 1
    return lo


def _last_alnum_boundary(word: str, lo: int, hi: int) -> int:
    """Exclusive end index past the last alphanumeric char in ``word[lo:hi]``.

    Scans backward from ``hi``, skipping trailing non-alphanumeric
    characters, and returns ``lo`` when the whole window is
    non-alphanumeric.
    """
    while hi > lo and not word[hi - 1].isalnum():
        hi -= 1
    return hi


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
    if any([not candidate, len(candidate) > _MAX_CANDIDATE_LEN]):
        return None
    return _scan_custom_words(candidate, custom_words, custom_words_nospace, threshold)


def _scan_custom_words(
    candidate: str,
    custom_words: list[str],
    custom_words_nospace: list[str],
    threshold: float,
) -> str | None:
    """Pick the lowest-scoring custom word below ``threshold`` for ``candidate``.

    Iterates the pre-stripped custom words, scores each (see
    :func:`_score_candidate`), and keeps the best canonical spelling that
    clears both ``threshold`` and the running best.
    """
    best_match: str | None = None
    best_score = float("inf")

    candidate_soundex = soundex(candidate)
    for i, custom_word_nospace in enumerate(custom_words_nospace):
        score = _score_candidate(candidate, candidate_soundex, custom_word_nospace)
        if all([score < threshold, score < best_score]):
            best_match = custom_words[i]
            best_score = score

    return best_match


def _score_candidate(candidate: str, candidate_soundex: str, custom_word_nospace: str) -> float:
    """Combined fuzzy score for one custom word, or ``inf`` if incompatible.

    Length-incompatible pairs short-circuit to ``inf`` so the caller's
    ``score < threshold`` comparison rejects them without computing
    Levenshtein or Soundex.
    """
    if not _length_compatible(candidate, custom_word_nospace):
        return float("inf")

    levenshtein_score = _normalized_levenshtein(candidate, custom_word_nospace)
    return _combine_with_phonetics(
        levenshtein_score,
        candidate_soundex,
        soundex(custom_word_nospace),
    )


def _length_compatible(candidate: str, custom_word_nospace: str) -> bool:
    """Reject pairs whose lengths differ by more than 25% (and ≥ 2 chars).

    A max 25% length difference prevents n-grams from matching
    significantly shorter custom words, e.g. 'openaigpt' vs 'openai'.
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
    never overlap, so degenerate inputs never trigger a phonetic boost.
    """
    if all([code_a, code_b, code_a == code_b]):
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
    if all([original, original.isupper()]):
        return replacement.upper()
    if _starts_uppercase(original):
        return _apply_title_case(replacement)
    return replacement


def _starts_uppercase(word: str) -> bool:
    """True when ``word`` is non-empty and its first character is uppercase."""
    return bool(word) and word[0].isupper()


def _apply_title_case(replacement: str) -> str:
    """Uppercase only the first character of ``replacement`` (empty → as-is)."""
    if not replacement:
        return replacement
    return replacement[0].upper() + replacement[1:]


def _extract_punctuation(word: str) -> tuple[str, str]:
    """Return the leading + trailing non-alphanumeric runs of ``word``.

    An input like ``"hello,"`` keeps the trailing comma after
    replacement, and ``"(foo)"`` keeps the surrounding parens.
    """
    prefix_end = _first_alnum_index(word, 0, len(word))
    suffix_start = _last_alnum_boundary(word, prefix_end, len(word))
    return word[:prefix_end], word[suffix_start:]
