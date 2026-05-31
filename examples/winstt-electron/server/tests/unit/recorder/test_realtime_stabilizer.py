"""Byte-faithful parity tests for RealtimeStabilizer vs RealtimeSTT.

Every test case mirrors the algorithm description in
``examples/RealtimeSTT/RealtimeSTT/audio_recorder.py:2440-2493`` and the
``_find_tail_match_in_text`` helper at lines 2732-2775. If any of these
fail, the stabilizer has diverged from the reference behavior and the
WinSTT live preview will flicker again.
"""

from __future__ import annotations

from itertools import pairwise

import pytest

from src.recorder.application.realtime_stabilizer import RealtimeStabilizer


class TestFindTailMatchInText:
    """Verbatim parity with audio_recorder.py:2732-2775."""

    def test_returns_minus_one_when_text1_shorter_than_match_len(self) -> None:
        assert RealtimeStabilizer._find_tail_match_in_text("short", "long enough text here") == -1

    def test_returns_minus_one_when_text2_shorter_than_match_len(self) -> None:
        assert RealtimeStabilizer._find_tail_match_in_text("long enough text here", "short") == -1

    def test_finds_tail_at_end_of_text2(self) -> None:
        # text1 last 10 = "uick brown"; text2 = "The quick brown fox jumps"
        # Match window "uick brown" lives at text2[5:15]; return end = 15.
        pos = RealtimeStabilizer._find_tail_match_in_text("The quick brown", "The quick brown fox jumps")
        assert pos == 15

    def test_identical_strings_return_end_position(self) -> None:
        # Whisper produced the same text twice — match at the very end.
        text = "The quick brown"
        pos = RealtimeStabilizer._find_tail_match_in_text(text, text)
        assert pos == len(text)

    def test_no_match_returns_minus_one(self) -> None:
        assert RealtimeStabilizer._find_tail_match_in_text("completely different", "nothing related text here") == -1

    def test_multiple_occurrences_returns_last(self) -> None:
        # text1 last 10 = "ABCDEFGHIJ"; place that twice in text2 — should
        # return the position of the LAST occurrence (greatest end index).
        text1 = "XXXXXXXXABCDEFGHIJ"
        text2 = "ABCDEFGHIJ_____ABCDEFGHIJ_tail"
        pos = RealtimeStabilizer._find_tail_match_in_text(text1, text2)
        # The last occurrence ends at index 25 (just before "_tail").
        assert pos == 25


class TestRealtimeStabilizerAlgorithm:
    """Parity with the stabilization algorithm in audio_recorder.py:2440-2493."""

    def test_first_update_emits_fresh_when_no_prior_state(self) -> None:
        s = RealtimeStabilizer()
        out = s.update("Hello world")
        # Cold start: no commonprefix possible (only 1 entry), safetext
        # empty, _find_tail_match returns -1, so fall through to fresh.
        assert out == "Hello world"

    def test_second_identical_update_locks_in_full_text(self) -> None:
        s = RealtimeStabilizer()
        s.update("The quick brown fox")
        out = s.update("The quick brown fox")
        # commonprefix matches both fully -> safetext == full string ->
        # tail-match returns end == len(text) -> safetext + fresh[end:] == full.
        assert out == "The quick brown fox"
        assert s.stable_safetext == "The quick brown fox"

    def test_growing_text_appends_new_tail(self) -> None:
        s = RealtimeStabilizer()
        s.update("The quick brown fox")
        out = s.update("The quick brown fox jumps over")
        # commonprefix = "The quick brown fox" (>= safetext "" so adopt).
        # tail match of "uick brown fox" inside "The quick brown fox jumps over"
        # returns 19. Output = safetext + fresh[19:] = "The quick brown fox jumps over".
        assert out == "The quick brown fox jumps over"
        assert s.stable_safetext == "The quick brown fox"

    def test_whisper_reranks_to_shorter_text_safetext_does_not_shrink(self) -> None:
        # The exact flicker pattern WinSTT exhibits today: Whisper reranks
        # the same audio to a shorter parse on the next call. RealtimeSTT's
        # monotonic safetext (only-grow rule) keeps the UI from regressing.
        s = RealtimeStabilizer()
        s.update("The quick brown fox jumps over")
        s.update("The quick brown fox jumps over")  # establish safetext
        out = s.update("The quick brown fox")
        assert s.stable_safetext == "The quick brown fox jumps over"
        # safetext is longer than the fresh; tail-match of "fox jumps " (or
        # similar) is not found inside "The quick brown fox" -> return -1
        # -> fall back to safetext.
        assert out == "The quick brown fox jumps over"

    def test_word_correction_in_tail_stabilizes_eventually(self) -> None:
        # User said "quick"; Whisper transcribed it as "quack" first then
        # corrected. The two-text commonprefix algorithm allows the
        # correction to propagate once a second consistent version arrives.
        s = RealtimeStabilizer()
        # storage=[A]; safetext=""
        s.update("The quack brown fox")
        # storage=[A,B]; commonprefix(A,B)="The qu"; safetext upgrades to "The qu".
        s.update("The quick brown fox")
        # tail-match of last 10 of "The qu" requires len("The qu") >= 10
        # -> length 6 < 10 -> returns -1 -> fall back to safetext "The qu".
        out = s.update("The quick brown fox")
        # storage=[B,B] -> commonprefix = full "The quick brown fox"; >= safetext "The qu" -> adopt
        assert s.stable_safetext == "The quick brown fox"
        assert out == "The quick brown fox"

    def test_reset_clears_state(self) -> None:
        s = RealtimeStabilizer()
        s.update("Some text")
        s.update("Some text more")
        assert s.stable_safetext != ""
        assert len(s.text_storage) > 0
        s.reset()
        assert s.stable_safetext == ""
        assert len(s.text_storage) == 0

    def test_empty_input_does_not_crash(self) -> None:
        s = RealtimeStabilizer()
        assert s.update("") == ""
        # Repeated empties: commonprefix("","") = "", >= safetext "" -> adopt
        # tail match: text1 short -> -1 -> fall back to safetext "" -> ""
        assert s.update("") == ""

    def test_whitespace_is_stripped(self) -> None:
        s = RealtimeStabilizer()
        out = s.update("  hello world  ")
        assert out == "hello world"

    def test_none_input_treated_as_empty(self) -> None:
        s = RealtimeStabilizer()
        # The contract accepts ``str | None`` for robustness against an
        # upstream transcriber returning ``None`` mid-swap.
        assert s.update(None) == ""  # type: ignore[arg-type]

    def test_realtime_long_sequence_safetext_monotonic_and_floors_output(self) -> None:
        # The invariants RealtimeSTT actually guarantees:
        #   (1) ``stable_safetext`` is monotonic — only ever grows.
        #   (2) emitted output is always ``>= len(stable_safetext)``.
        # Output CAN momentarily contract to exactly the safetext when
        # Whisper rewinds the fresh window, but it cannot fall below the
        # confirmed-stable prefix. This is the precise property that kills
        # the "big chunks removed and re-added" flicker pattern.
        s = RealtimeStabilizer()
        sequence = [
            "The",
            "The quick",
            "The quick brown",
            "The quick brown fox",
            "The quick brown",  # Whisper regression (drops "fox")
            "The quick brown fox jumps",
            "The quick brown fox jumps over",
            "The quick brown fox jumps over the",
            "The quick brown fox jumps over the lazy",
            "The quick brown fox jumps over the lazy dog",
        ]
        safetext_lens: list[int] = []
        outputs: list[str] = []
        for sentence in sequence:
            out = s.update(sentence)
            outputs.append(out)
            safetext_lens.append(len(s.stable_safetext))
            # Invariant 2: output never below the confirmed safetext.
            assert len(out) >= len(s.stable_safetext), f"output {out!r} shorter than safetext {s.stable_safetext!r}"
        # Invariant 1: safetext is monotonic non-decreasing.
        for prev, curr in pairwise(safetext_lens):
            assert curr >= prev, f"safetext regressed from len={prev} to len={curr}: outputs={outputs}"
        # The final emission is the full sentence.
        assert outputs[-1] == "The quick brown fox jumps over the lazy dog"


class TestRealtimeStabilizerVsAccumulatorIntegration:
    """The stabilizer must work with our watermark+accumulator design.

    Our realtime_publish_fresh assembles ``committed_prefix + " " +
    fresh_window_text`` and hands the full string to the stabilizer. The
    committed_prefix is already monotonic (frozen older chunks) so the
    stabilizer's commonprefix trivially keeps it and works only on the
    fresh tail. These cases verify that composition is sound.
    """

    def test_committed_prefix_passes_through_unchanged(self) -> None:
        s = RealtimeStabilizer()
        # First tick: only fresh, no commit yet.
        s.update("Hello world")
        s.update("Hello world this is fresh")  # safetext locks in "Hello world"
        # Now imagine a commit happened — assembled becomes
        # "Hello world this is fresh more incoming"
        out = s.update("Hello world this is fresh more incoming")
        # safetext was "Hello world", now commonprefix("Hello world this is fresh", "...more incoming")
        # = "Hello world this is fresh"; >= old safetext -> adopt.
        assert "Hello world this is fresh" in s.stable_safetext
        assert out.startswith("Hello world this is fresh")

    def test_short_safetext_falls_back_cleanly_when_tail_match_too_short(self) -> None:
        # Edge case from the algorithm: when safetext is shorter than 10
        # chars, _find_tail_match returns -1 and we fall back to safetext.
        s = RealtimeStabilizer()
        s.update("hi")
        s.update("hi there")
        # safetext = "hi" (commonprefix of "hi" and "hi there"); len 2 < 10
        # so on next call, tail-match returns -1.
        out = s.update("hi there friend")
        # Per algorithm: safetext non-empty + tail-match -1 -> return safetext.
        # But safetext just upgraded to "hi there" (commonprefix of "hi there", "hi there friend").
        assert s.stable_safetext == "hi there"
        # Because safetext is still < 10 chars, tail-match returns -1; we
        # return safetext.
        assert out == "hi there"


if __name__ == "__main__":  # pragma: no cover
    pytest.main([__file__, "-v"])
