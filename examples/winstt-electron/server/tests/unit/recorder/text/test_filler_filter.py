"""Tests for the locale-aware filler-word + stutter-collapse post-processor.

Mirrors the reference ``filter_*`` test cases so a future drift
between the two reference implementations is visible immediately.
"""

from __future__ import annotations

from src.recorder.text.filler_filter import (
    DEFAULT_FILLERS_FALLBACK,
    FILLERS_BY_LANG,
    collapse_stutters,
    filter_transcription_output,
    get_filler_words_for_language,
)


class TestGetFillerWordsForLanguage:
    def test_known_language(self) -> None:
        assert get_filler_words_for_language("en") == FILLERS_BY_LANG["en"]

    def test_language_with_region_normalizes_to_base(self) -> None:
        assert get_filler_words_for_language("pt-BR") == FILLERS_BY_LANG["pt"]
        assert get_filler_words_for_language("en_US") == FILLERS_BY_LANG["en"]

    def test_unknown_language_falls_back(self) -> None:
        assert get_filler_words_for_language("xx") == DEFAULT_FILLERS_FALLBACK

    def test_empty_language_falls_back(self) -> None:
        assert get_filler_words_for_language("") == DEFAULT_FILLERS_FALLBACK


class TestCollapseStutters:
    def test_empty_input(self) -> None:
        assert collapse_stutters("") == ""

    def test_no_repetition(self) -> None:
        assert collapse_stutters("hello world") == "hello world"

    def test_two_repetitions_preserved(self) -> None:
        # The threshold is 3+ — two-in-a-row is often legitimate ("no no").
        assert collapse_stutters("no no is fine") == "no no is fine"

    def test_three_repetitions_collapsed(self) -> None:
        assert collapse_stutters("I I I think so") == "I think so"

    def test_long_run_collapsed_to_one(self) -> None:
        assert collapse_stutters("w wh wh wh wh wh wh wh wh wh why") == "w wh why"

    def test_mixed_case_collapse(self) -> None:
        assert collapse_stutters("No NO no NO no") == "No"

    def test_longer_word_collapse(self) -> None:
        assert collapse_stutters("Check data doc doc doc doc documentation.") == "Check data doc documentation."

    def test_non_alpha_token_passes_through(self) -> None:
        # Punctuation-only and numeric tokens are not stutter artifacts.
        # Whether they happen to repeat is the user's problem to filter
        # downstream; this function shouldn't second-guess them.
        assert collapse_stutters("5 5 5 cents") == "5 5 5 cents"


class TestFilterTranscriptionOutput:
    def test_empty_input(self) -> None:
        assert filter_transcription_output("", "en") == ""

    def test_english_strips_um_and_uh(self) -> None:
        out = filter_transcription_output("So uhm I was thinking uh about this", "en")
        assert out == "So I was thinking about this"

    def test_english_case_insensitive(self) -> None:
        out = filter_transcription_output("UHM this is UH a test", "en")
        assert out == "this is a test"

    def test_english_strips_trailing_comma_with_filler(self) -> None:
        out = filter_transcription_output("Well, uhm, I think, uh. that's right", "en")
        assert out == "Well, I think, that's right"

    def test_collapses_multi_spaces(self) -> None:
        out = filter_transcription_output("Hello    world   test", "en")
        assert out == "Hello world test"

    def test_trims_outer_whitespace(self) -> None:
        out = filter_transcription_output("  Hello world  ", "en")
        assert out == "Hello world"

    def test_preserves_clean_sentence(self) -> None:
        out = filter_transcription_output("This is a completely normal sentence.", "en")
        assert out == "This is a completely normal sentence."

    def test_combined_fillers_and_stutters(self) -> None:
        out = filter_transcription_output("w wh wh wh wh wh wh wh wh wh why", "en")
        assert out == "w wh why"

    def test_short_word_stutters(self) -> None:
        out = filter_transcription_output("I I I I think so so so so", "en")
        assert out == "I think so"

    def test_portuguese_preserves_um(self) -> None:
        # "um" = "a/an" in PT; the pt table excludes it.
        out = filter_transcription_output("um gato bonito", "pt")
        assert out == "um gato bonito"

    def test_portuguese_region_tag_normalized(self) -> None:
        out = filter_transcription_output("um gato bonito", "pt-BR")
        assert out == "um gato bonito"

    def test_spanish_preserves_ha(self) -> None:
        # "ha" = "has" in ES; excluded from the es table.
        out = filter_transcription_output("ha sido un buen día", "es")
        assert out == "ha sido un buen día"

    def test_unknown_language_uses_fallback(self) -> None:
        # Fallback table strips "uh" and "uhm" but preserves "um".
        out = filter_transcription_output("uh I think uhm this works", "xx")
        assert out == "I think this works"

    def test_unknown_language_preserves_um(self) -> None:
        out = filter_transcription_output("um I think this works", "xx")
        assert out == "um I think this works"

    def test_custom_filler_words_override(self) -> None:
        out = filter_transcription_output("okay so I think right this works", "en", ["okay", "right"])
        assert out == "so I think this works"

    def test_empty_custom_list_disables_filter(self) -> None:
        # Explicit empty list = "skip filler removal entirely" while
        # still letting stutter collapse + whitespace tidy fire.
        out = filter_transcription_output("So uhm I was thinking uh about this", "en", [])
        assert out == "So uhm I was thinking uh about this"

    def test_empty_custom_list_still_collapses_stutters(self) -> None:
        out = filter_transcription_output("I I I think so", "en", [])
        assert out == "I think so"
