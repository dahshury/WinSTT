"""Unit tests for the deterministic custom-word fuzzy corrector.

Mirrors the ``#[cfg(test)]`` block in
the reference text-matching tests so we can claim
algorithmic parity with the reference implementation. The exact
assertion shapes (``contains``, ``not contains``, full string equality)
are kept where the reference used them — the matcher is greedy and the
non-equality assertions tolerate minor remainder-word artefacts.
"""

from __future__ import annotations

import pytest

from src.recorder.text.dictionary import (
    DEFAULT_THRESHOLD,
    _build_ngram,
    _combine_with_phonetics,
    _extract_punctuation,
    _find_best_match,
    _length_compatible,
    _normalized_levenshtein,
    _preserve_case_pattern,
    _strip_non_alnum,
    apply_custom_words,
)


class TestApplyCustomWordsReferenceParity:
    """Tests ported verbatim from text.rs::tests."""

    def test_exact_match(self) -> None:
        result = apply_custom_words("hello world", ["Hello", "World"], 0.5)
        assert result == "Hello World"

    def test_fuzzy_match(self) -> None:
        result = apply_custom_words("helo wrold", ["hello", "world"], 0.5)
        assert result == "hello world"

    def test_empty_custom_words(self) -> None:
        result = apply_custom_words("hello world", [], 0.5)
        assert result == "hello world"

    def test_ngram_two_words(self) -> None:
        # The Rust test only asserts presence of ChargeBee + absence of
        # "Charge B" so we keep the same loose assertions — the greedy
        # 3-gram cascade may absorb a leading function word.
        text = "il cui nome è Charge B, che permette"
        result = apply_custom_words(text, ["ChargeBee"], 0.5)
        assert "ChargeBee," in result
        assert "Charge B" not in result

    def test_ngram_three_words(self) -> None:
        result = apply_custom_words("use Chat G P T for this", ["ChatGPT"], 0.5)
        assert "ChatGPT" in result

    def test_prefers_longer_ngram(self) -> None:
        result = apply_custom_words("Open AI GPT model", ["OpenAI", "GPT"], 0.5)
        assert result == "OpenAI GPT model"

    def test_ngram_preserves_case_all_upper(self) -> None:
        result = apply_custom_words("CHARGE B is great", ["ChargeBee"], 0.5)
        assert "CHARGEBEE" in result

    def test_ngram_with_spaces_in_custom(self) -> None:
        # Custom word containing a literal space should still match its
        # space-stripped form against the split-word n-gram.
        result = apply_custom_words("using Mac Book Pro", ["MacBook Pro"], 0.5)
        assert "MacBook" in result

    def test_trailing_number_not_doubled(self) -> None:
        # Guards against the "GPT-44" double-count bug — trailing alphanumerics
        # are part of the candidate body (build_ngram strips only the leading /
        # trailing NON-alphanumerics), so extract_punctuation must not re-emit
        # them as a suffix.
        result = apply_custom_words("use GPT4 for this", ["GPT-4"], 0.5)
        assert "GPT-44" not in result, f"got double-counted result: {result}"


class TestApplyCustomWordsEdgeCases:
    """Cases the reference test suite doesn't cover but are easy to regress on."""

    def test_empty_input(self) -> None:
        assert apply_custom_words("", ["Hello"], 0.5) == ""

    def test_whitespace_only_input(self) -> None:
        # ``str.split()`` with no separator drops whitespace-only inputs to
        # an empty word list — we should return the original text untouched
        # rather than collapsing it to "".
        assert apply_custom_words("   ", ["Hello"], 0.5) == "   "

    def test_no_match_returns_original(self) -> None:
        text = "the quick brown fox"
        assert apply_custom_words(text, ["Anthropic"], 0.5) == text

    def test_default_threshold_is_018(self) -> None:
        assert DEFAULT_THRESHOLD == 0.18

    def test_default_threshold_accepts_identicals(self) -> None:
        # Zero edit distance always clears the threshold (Soundex boost
        # immaterial since 0 x 0.3 is still 0).
        assert apply_custom_words("hello world", ["Hello", "World"]) == "Hello World"

    def test_default_threshold_accepts_phonetic_near_miss(self) -> None:
        # "helo"/"hello" share Soundex H400 — 0.2 Levenshtein x 0.3 boost
        # = 0.06 which clears 0.18.
        assert apply_custom_words("helo wrold", ["hello", "world"]) == "hello world"

    def test_default_threshold_rejects_unrelated(self) -> None:
        # "anthropic" vs "openai" has no phonetic overlap AND a big
        # Levenshtein gap — must stay rejected at the default.
        assert apply_custom_words("anthropic ai", ["OpenAI"]) == "anthropic ai"

    def test_phonetic_only_match(self) -> None:
        # Words with the same Soundex but high Levenshtein only clear the
        # 0.18 default thanks to the phonetic boost (x 0.3). "Robert" and
        # "Rupert" share Soundex code R163.
        result = apply_custom_words("rupert", ["Robert"])
        assert result == "Robert"

    def test_length_diff_blocks_short_substring(self) -> None:
        # Reference comment: "prevents n-grams from matching significantly
        # shorter custom words, e.g. 'openaigpt' vs 'openai'". The 25%
        # rule is wide enough for similar lengths but rejects the absurd
        # length-mismatch case.
        result = apply_custom_words("openaigpt", ["openai"], 0.5)
        assert result == "openaigpt"

    def test_length_diff_allows_small_strings(self) -> None:
        # The "≥ 2 chars" floor means single-char differences on short
        # words are always allowed even though they'd exceed 25%.
        result = apply_custom_words("ai", ["AI"], 0.5)
        assert result == "AI"

    def test_threshold_boundary_rejects(self) -> None:
        # At threshold = 0 only identicals match — fuzzy candidates are
        # rejected even when their Levenshtein score is small.
        result = apply_custom_words("helo", ["hello"], threshold=0.0)
        assert result == "helo"

    def test_threshold_boundary_accepts(self) -> None:
        # At threshold = 1.0 anything that passes the length-diff gate
        # gets accepted — this is the "maximally permissive" knob users
        # are warned against in the docs.
        result = apply_custom_words("xyzx", ["xyz"], threshold=1.0)
        assert result == "xyz"

    def test_punctuation_preserved(self) -> None:
        # Leading "(" and trailing "." should re-appear around the
        # replacement; the canonical Foo stays in the middle.
        result = apply_custom_words("(foo).", ["Foo"], 0.5)
        assert result == "(Foo)."

    def test_punctuation_only_word_absorbed_by_greedy_match(self) -> None:
        # A standalone punctuation token contributes nothing to the
        # n-gram body, so the greedy 2-gram cascade matches "hello ,"
        # against "hello" and absorbs the comma. This mirrors the reference
        # implementation — the n-gram pass is intentionally greedy.
        result = apply_custom_words("hello , world", ["Hello", "World"], 0.5)
        assert result == "Hello World"

    def test_standalone_punctuation_after_no_match(self) -> None:
        # When the preceding words don't match anything, the standalone
        # punctuation token can't form an n-gram body either — it falls
        # through to the no-match arm and passes verbatim.
        result = apply_custom_words("nothing , here", ["OpenAI"], 0.5)
        assert result == "nothing , here"

    def test_titlecased_first_word(self) -> None:
        # Original starts with an uppercase letter ⇒ replacement gets
        # capitalised even if the canonical form was lowercase.
        result = apply_custom_words("Helo world", ["hello"], 0.5)
        assert result.startswith("Hello")

    def test_preserves_long_candidates_via_skip(self) -> None:
        # Candidates over the 50-char cap must short-circuit to "no match"
        # — they're handed back untouched.
        long_word = "a" * 60
        result = apply_custom_words(long_word, ["Anthropic"], 0.5)
        assert result == long_word


class TestBuildNgram:
    def test_strips_surrounding_punct(self) -> None:
        assert _build_ngram(["(Hello,"]) == "hello"

    def test_keeps_alnum_in_middle(self) -> None:
        # Internal punctuation (hyphen between alphanumerics) is kept by
        # ``_strip_non_alnum`` since it only trims the outer edges.
        assert _build_ngram(["GPT-4"]) == "gpt-4"

    def test_concatenates_multi_word(self) -> None:
        assert _build_ngram(["Charge", "Bee"]) == "chargebee"

    def test_empty_words(self) -> None:
        assert _build_ngram([]) == ""

    def test_word_with_no_alnum(self) -> None:
        # All-punctuation words contribute nothing to the n-gram body.
        assert _build_ngram(["..."]) == ""


class TestPreserveCasePattern:
    def test_all_uppercase(self) -> None:
        assert _preserve_case_pattern("HELLO", "world") == "WORLD"

    def test_titlecased(self) -> None:
        assert _preserve_case_pattern("Hello", "world") == "World"

    def test_lowercase_keeps_replacement_verbatim(self) -> None:
        # The replacement is the canonical form — when the original is
        # already lowercase we trust whatever casing the user wrote.
        assert _preserve_case_pattern("hello", "WORLD") == "WORLD"

    def test_empty_original(self) -> None:
        assert _preserve_case_pattern("", "world") == "world"

    def test_empty_replacement_titlecased(self) -> None:
        # No characters to capitalise — return as-is.
        assert _preserve_case_pattern("Hello", "") == ""


class TestExtractPunctuation:
    def test_no_punctuation(self) -> None:
        assert _extract_punctuation("hello") == ("", "")

    def test_leading_and_trailing(self) -> None:
        assert _extract_punctuation("!hello?") == ("!", "?")

    def test_repeated(self) -> None:
        assert _extract_punctuation("...hello...") == ("...", "...")

    def test_all_punctuation(self) -> None:
        # An all-punct token has prefix == word and an empty suffix —
        # the suffix loop stops at the prefix boundary so neither slice
        # double-counts.
        prefix, suffix = _extract_punctuation("???")
        assert prefix == "???"
        assert suffix == ""

    def test_empty_string(self) -> None:
        assert _extract_punctuation("") == ("", "")


class TestStripNonAlnum:
    def test_trims_both_sides(self) -> None:
        assert _strip_non_alnum("!hello?") == "hello"

    def test_keeps_internal(self) -> None:
        assert _strip_non_alnum("GPT-4") == "GPT-4"

    def test_all_punctuation_collapses(self) -> None:
        assert _strip_non_alnum("...") == ""


class TestLengthCompatible:
    def test_identical_lengths(self) -> None:
        assert _length_compatible("hello", "world")

    def test_within_25_percent(self) -> None:
        # 6 vs 8 → diff 2 ≤ max(2, 8 * 0.25 = 2) ✓
        assert _length_compatible("hellos", "hellosx!")

    def test_two_char_floor_helps_short_strings(self) -> None:
        # 2 vs 3 → diff 1 ≤ max(2, 3 * 0.25 = 0.75) ✓ (floor wins)
        assert _length_compatible("ai", "GPT")

    def test_rejects_large_diff(self) -> None:
        # 5 vs 15 → diff 10 > max(2, 15 * 0.25 = 3.75) ✗
        assert not _length_compatible("hello", "hello world!!!!")


class TestNormalizedLevenshtein:
    def test_identical(self) -> None:
        assert _normalized_levenshtein("abc", "abc") == 0.0

    def test_completely_different(self) -> None:
        assert _normalized_levenshtein("abc", "xyz") == 1.0

    def test_one_edit(self) -> None:
        # One edit on a 5-char string → 1/5 = 0.2.
        assert _normalized_levenshtein("hello", "hallo") == pytest.approx(0.2)

    def test_both_empty(self) -> None:
        # No content at all — return 1.0 so the caller treats it as
        # "no match" rather than dividing by zero.
        assert _normalized_levenshtein("", "") == 1.0


class TestCombineWithPhonetics:
    def test_no_boost_on_mismatch(self) -> None:
        assert _combine_with_phonetics(0.5, "R163", "B620") == 0.5

    def test_boost_on_match(self) -> None:
        # 0.5 x 0.3 = 0.15.
        assert _combine_with_phonetics(0.5, "R163", "R163") == pytest.approx(0.15)

    def test_no_boost_on_empty_codes(self) -> None:
        # Two empty codes don't count as a phonetic hit even though they're
        # equal — Soundex returns "" only for input it can't map at all,
        # so equating empties would over-boost arbitrary garbage.
        assert _combine_with_phonetics(0.5, "", "") == 0.5

    def test_no_boost_on_one_empty(self) -> None:
        assert _combine_with_phonetics(0.5, "", "R163") == 0.5


class TestFindBestMatch:
    def test_picks_lower_score(self) -> None:
        # Two candidates; the one with the smaller Levenshtein wins.
        result = _find_best_match("hello", ["Hi", "Hello"], ["hi", "hello"], 0.5)
        assert result == "Hello"

    def test_returns_none_for_empty_candidate(self) -> None:
        assert _find_best_match("", ["Hello"], ["hello"], 0.5) is None

    def test_returns_none_for_too_long_candidate(self) -> None:
        # 51-char candidate exceeds _MAX_CANDIDATE_LEN.
        candidate = "a" * 51
        assert _find_best_match(candidate, ["Anthropic"], ["anthropic"], 0.5) is None

    def test_no_match_below_threshold(self) -> None:
        # "anthropic" vs "openai" — no plausible Levenshtein hit and no
        # phonetic overlap below 0.18.
        assert _find_best_match("anthropic", ["OpenAI"], ["openai"], 0.18) is None
