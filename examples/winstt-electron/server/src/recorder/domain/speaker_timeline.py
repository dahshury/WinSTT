from __future__ import annotations

import threading
from dataclasses import dataclass, field

from src.recorder.domain.events import SpeakerSegment

#: Absolute-time speaker spans kept in the rolling timeline. Older spans than
#: this many seconds behind the newest are pruned so a multi-hour Listen
#: session can't grow the timeline without bound.
_RETAIN_SECONDS = 600.0


@dataclass
class SpeakerTimeline:
    """Session-global speaker timeline built from a continuous diarization
    stream.

    The continuous worker diarizes short rolling *windows*; each window yields
    window-relative :class:`SpeakerSegment` ranges. :meth:`merge` shifts them
    to absolute session time and appends them. Because the windows overlap
    (utterr-style 1.0s @ 0.1s), the same instant is covered by many segments
    with possibly conflicting speakers — :meth:`dominant_speaker` resolves a
    query range by total per-speaker overlap (the same vote utterr's splitter
    uses), so a short committed transcription line gets one stable label.

    Speaker ids are already session-stable: the underlying ``SessionDiarizer``
    keeps persistent centroids across ``diarize()`` calls until ``reset()``.
    All public methods are thread-safe (the worker writes, ``text()`` reads).
    """

    _segments: list[SpeakerSegment] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _latest_end: float = 0.0

    def merge(self, segments: tuple[SpeakerSegment, ...], window_start_seconds: float) -> None:
        """Shift window-relative segments to absolute time and append them.

        ``window_start_seconds`` is the absolute session time of sample 0 of
        the window that produced ``segments``. Empty windows (silence) are a
        no-op. Prunes spans older than :data:`_RETAIN_SECONDS` behind the
        newest end so memory stays bounded under continuous loopback.
        """
        if not segments:
            return
        with self._lock:
            self._append_shifted(segments, window_start_seconds)
            self._prune_old()

    def _append_shifted(self, segments: tuple[SpeakerSegment, ...], window_start_seconds: float) -> None:
        """Append window-relative ``segments`` shifted to absolute session time.

        Caller must hold ``self._lock``. Zero-width spans are skipped.
        """
        for seg in segments:
            start = window_start_seconds + seg.start
            end = window_start_seconds + seg.end
            if end <= start:
                continue
            self._segments.append(SpeakerSegment(start=start, end=end, speaker=seg.speaker))
            self._latest_end = max(self._latest_end, end)

    def _prune_old(self) -> None:
        """Drop spans older than :data:`_RETAIN_SECONDS` behind the newest end.

        Caller must hold ``self._lock``.
        """
        cutoff = self._latest_end - _RETAIN_SECONDS
        if cutoff > 0:
            self._segments = self._retained(cutoff)

    def _retained(self, cutoff: float) -> list[SpeakerSegment]:
        """Spans whose end is at or after ``cutoff``. Caller must hold the lock."""
        return [s for s in self._segments if s.end >= cutoff]

    def dominant_speaker(self, start: float, end: float) -> int | None:
        """Speaker with the most total overlap in ``[start, end)``.

        Returns ``None`` when no diarized segment intersects the range (the
        renderer then leaves that line uncolored rather than guessing).
        """
        if end <= start:
            return None
        with self._lock:
            totals = self._overlap_totals(start, end)
        if not totals:
            return None
        return max(totals, key=lambda spk: totals[spk])

    def _overlap_totals(self, start: float, end: float) -> dict[int, float]:
        """Per-speaker total overlap with ``[start, end)``. Caller holds the lock."""
        totals: dict[int, float] = {}
        for s in self._segments:
            lo = max(start, s.start)
            hi = min(end, s.end)
            if hi > lo:
                totals[s.speaker] = totals.get(s.speaker, 0.0) + (hi - lo)
        return totals

    def segments_in_range(self, start: float, end: float) -> list[SpeakerSegment]:
        """All timeline spans intersecting ``[start, end)``, clipped to it and
        sorted by start — the input to ``assign_speakers_to_words`` (P3)."""
        if end <= start:
            return []
        with self._lock:
            hits = self._clip_hits(start, end)
        hits.sort(key=lambda s: (s.start, s.end))
        return hits

    def _clip_hits(self, start: float, end: float) -> list[SpeakerSegment]:
        """Spans intersecting ``[start, end)``, clipped to it. Caller holds the lock."""
        return [
            SpeakerSegment(start=max(start, s.start), end=min(end, s.end), speaker=s.speaker)
            for s in self._segments
            if min(end, s.end) > max(start, s.start)
        ]

    def recent_segments(self, duration: float) -> tuple[SpeakerSegment, ...]:
        """Speaker spans covering the most recent ``duration`` seconds,
        re-based so the window starts at 0.

        This is what a just-committed Listen line needs: the line is the last
        ``duration`` s of audio, and the renderer/`splitTextBySpeaker` expects
        segment times *relative to the line start* (callbacks.py contract).
        ``_latest_end`` is "now" (the newest diarized window end), so the line
        maps to ``[_latest_end - duration, _latest_end]``. Empty when the
        timeline has nothing yet (diarization still warming) — the renderer
        then leaves the line uncolored instead of guessing.
        """
        if duration <= 0:
            return ()
        with self._lock:
            origin = self._latest_end - duration
            out = self._rebased(origin, duration)
        out.sort(key=lambda s: (s.start, s.end))
        return tuple(out)

    def _rebased(self, origin: float, duration: float) -> list[SpeakerSegment]:
        """Spans re-based so ``origin`` maps to 0, clipped to ``[0, duration]``.

        Caller must hold ``self._lock``.
        """
        out: list[SpeakerSegment] = []
        for s in self._segments:
            lo = max(origin, s.start) - origin
            hi = min(self._latest_end, s.end) - origin
            if hi > lo:
                out.append(SpeakerSegment(start=max(0.0, lo), end=min(duration, hi), speaker=s.speaker))
        return out

    def reset(self) -> None:
        """Drop all spans — used when diarization is (re)activated so a new
        session doesn't inherit the previous one's timeline."""
        with self._lock:
            self._segments.clear()
            self._latest_end = 0.0
