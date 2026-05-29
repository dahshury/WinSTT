"""Realtime preview text stabilizer (byte-faithful port of RealtimeSTT).

Whisper is stateless and beam search reranks on changing tail context, so
feeding it a growing audio buffer produces text that contradicts the
previous output for the SAME prefix audio. RealtimeSTT's ``audio_recorder``
(``examples/RealtimeSTT/RealtimeSTT/audio_recorder.py``, lines 2440-2493)
fixes this entirely at the TEXT layer (not by trimming the audio window):

  1. Append every fresh realtime transcription to ``text_storage``
     (a deque of length 2 — only the last two are needed).
  2. Compute ``os.path.commonprefix(text_storage[-2:])`` — the longest
     common prefix of the last two transcriptions.
  3. ``stable_safetext`` is MONOTONIC: it is only assigned a new prefix
     when the new prefix length is ``>=`` its current length. This makes
     it never shrink, even when Whisper rewrites earlier words.
  4. The output text fed to the live preview is ``stable_safetext +
     fresh[matching_pos:]``, where ``matching_pos`` is the position in
     ``fresh`` at which the last 10 characters of ``stable_safetext``
     appear (searched from the END of ``fresh`` so the most recent
     occurrence wins).

This class implements that algorithm with no I/O so it is trivially
unit-testable independent of any transcriber or thread.
"""

from __future__ import annotations

import collections
import os
from dataclasses import dataclass, field

_TAIL_MATCH_LEN = 10  # RealtimeSTT default; see audio_recorder.py:2740


@dataclass
class RealtimeStabilizer:
    """Stabilizes a stream of growing-window realtime transcriptions.

    Use one instance per recording. Call :meth:`reset` at the start of a
    new recording; call :meth:`update` with each fresh realtime
    transcription and emit the returned stabilized text to the UI.
    """

    text_storage: collections.deque[str] = field(
        default_factory=lambda: collections.deque(maxlen=2),
    )
    stable_safetext: str = ""

    def reset(self) -> None:
        """Wipe state at the start of a new recording."""
        self.text_storage.clear()
        self.stable_safetext = ""

    def update(self, fresh_text: str) -> str:
        """Ingest a new realtime transcription and return the stabilized text.

        ``fresh_text`` is the FULL assembled realtime text for this tick
        (e.g. ``committed_prefix + " " + fresh_window_text`` in the
        watermark+accumulator design). The returned string is the
        UI-safe, monotonic-anchored text to display.
        """
        fresh = self._normalize(fresh_text)
        self.text_storage.append(fresh)

        # 1. Detect the new stable prefix from the last two transcriptions
        #    (mirrors audio_recorder.py:2440-2457).
        self._update_stable_prefix()

        # 2. Merge: stable_safetext + fresh[matching_pos:]
        #    (mirrors audio_recorder.py:2461-2490).
        return self._merge(fresh)

    @staticmethod
    def _normalize(fresh_text: str) -> str:
        """Coerce a (possibly falsy) raw realtime text to its stripped form."""
        return (fresh_text or "").strip()

    def _update_stable_prefix(self) -> None:
        """Adopt the monotonic common prefix of the last two transcriptions.

        Mirrors audio_recorder.py:2440-2457. Monotonic: only adopt a new
        prefix when it is at least as long as the current safetext. Prevents
        flicker when a later transcription disagrees with an earlier one on
        words the user has already seen.
        """
        if len(self.text_storage) < 2:
            return
        last_two = list(self.text_storage)[-2:]
        prefix = os.path.commonprefix(last_two)
        if len(prefix) >= len(self.stable_safetext):
            self.stable_safetext = prefix

    def _merge(self, fresh: str) -> str:
        """Anchor ``fresh`` onto the stable safetext via tail-match overlap.

        Mirrors audio_recorder.py:2461-2490.
        """
        matching_pos = self._find_tail_match_in_text(self.stable_safetext, fresh)
        if matching_pos < 0:
            # No overlap: stable wins if non-empty, else fresh (cold start).
            return self.stable_safetext or fresh
        return self.stable_safetext + fresh[matching_pos:]

    @staticmethod
    def _find_tail_match_in_text(
        text1: str,
        text2: str,
        length_of_match: int = _TAIL_MATCH_LEN,
    ) -> int:
        """Return the index in ``text2`` where the last ``length_of_match`` chars of ``text1`` end.

        Searches ``text2`` from the END so the most recent occurrence wins
        (matches RealtimeSTT's behavior, audio_recorder.py:2732-2775).
        Returns ``-1`` if either string is shorter than ``length_of_match``
        or no occurrence is found.

        Concretely: with ``text1 = "The quick brown"`` (last 10 =
        ``"uick brown"``) and ``text2 = "The quick brown fox jumps"``, the
        return is ``15`` — the index at which the tail match ENDS in
        ``text2``, i.e. the cut point for the fresh suffix.
        """
        if min(len(text1), len(text2)) < length_of_match:
            return -1
        target = text1[-length_of_match:]
        # Scan text2 windows of length_of_match from right to left so the
        # match closest to the end of text2 is the one returned (this is
        # what makes the algorithm robust to recurring phrases).
        return RealtimeStabilizer._scan_windows_from_right(text2, target, length_of_match)

    @staticmethod
    def _scan_windows_from_right(text2: str, target: str, length_of_match: int) -> int:
        """Return the end index of the right-most window in ``text2`` equal to ``target``.

        Returns ``-1`` when no window matches. The caller guarantees both
        ``len(text2) >= length_of_match`` and ``len(target) == length_of_match``.
        """
        for i in range(len(text2) - length_of_match + 1):
            end = len(text2) - i
            window = text2[end - length_of_match : end]
            if window == target:
                return end
        return -1
