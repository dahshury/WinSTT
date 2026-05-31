"""Tests for :class:`DiarizationStreamWorker`.

Timing is sample-count based (not wall clock), so the window→absolute-time
math is fully deterministic. The thread loop is exercised once for the
lifecycle; everything else drives ``_process_once`` / ``add_audio`` directly.
"""

from __future__ import annotations

import time

import numpy as np

from src.recorder.application.diarization_stream import DiarizationStreamWorker
from src.recorder.domain.events import SpeakerSegment
from src.recorder.domain.speaker_timeline import SpeakerTimeline
from tests.fakes.fake_diarizer import FakeDiarizer


def _audio(n: int) -> np.ndarray:
    return np.full(n, 0.1, dtype=np.float32)


class TestDiarizationStreamWorker:
    def _make(
        self, diarizer: FakeDiarizer, *, window_seconds: float = 1.0, stride: float = 0.0
    ) -> tuple[DiarizationStreamWorker, SpeakerTimeline]:
        tl = SpeakerTimeline()
        w = DiarizationStreamWorker(
            diarizer, tl, sample_rate=16000, window_seconds=window_seconds, stride_seconds=stride
        )
        return w, tl

    def test_add_audio_empty_is_noop(self) -> None:
        w, _tl = self._make(FakeDiarizer())
        w.add_audio(np.zeros(0, dtype=np.float32))
        assert w._take_window() is None  # nothing buffered

    def test_take_window_none_until_full(self) -> None:
        w, _tl = self._make(FakeDiarizer())
        w.add_audio(_audio(8000))  # < 16000 (1.0s @ 16k)
        assert w._take_window() is None

    def test_take_window_returns_trailing_window_and_abs_start(self) -> None:
        w, _tl = self._make(FakeDiarizer())
        w.add_audio(_audio(16000))  # exactly one window, ingested=16000
        taken = w._take_window()
        assert taken is not None
        window, window_start = taken
        assert window.shape == (16000,)
        assert window_start == 0.0
        w.add_audio(_audio(1600))  # ingested=17600 → window starts at 0.1s
        taken2 = w._take_window()
        assert taken2 is not None
        assert round(taken2[1], 4) == 0.1

    def test_add_audio_drop_oldest_caps_buffer(self) -> None:
        w, _tl = self._make(FakeDiarizer())
        # 4 windows is the cap (_BUFFER_WINDOWS); feed 10 windows worth.
        for _ in range(10):
            w.add_audio(_audio(16000))
        assert w._buffer.size == 16000 * 4  # capped
        assert w._ingested_samples == 16000 * 10  # absolute position still exact

    def test_process_once_false_when_not_full(self) -> None:
        w, tl = self._make(FakeDiarizer())
        w.add_audio(_audio(4000))
        assert w._process_once() is False
        assert tl.dominant_speaker(0.0, 100.0) is None

    def test_process_once_merges_shifted_segments(self) -> None:
        diar = FakeDiarizer(segments=(SpeakerSegment(start=0.0, end=1.0, speaker=3),))
        w, tl = self._make(diar)
        w.add_audio(_audio(16000))  # window at abs 0.0
        w.add_audio(_audio(16000))  # ingested=32000 → newest window starts at 1.0s
        assert w._process_once() is True
        assert diar.diarize_calls == 1
        # Segment 0..1 from a window starting at 1.0s → absolute 1.0..2.0.
        assert tl.dominant_speaker(1.0, 2.0) == 3

    def test_process_once_swallows_diarize_failure(self) -> None:
        diar = FakeDiarizer(raises=RuntimeError("boom"))
        w, tl = self._make(diar)
        w.add_audio(_audio(16000))
        assert w._process_once() is True  # processed (failure swallowed)
        assert tl.dominant_speaker(0.0, 100.0) is None

    def test_thread_lifecycle_processes_and_stops(self) -> None:
        diar = FakeDiarizer(segments=(SpeakerSegment(start=0.0, end=0.5, speaker=0),))
        w, tl = self._make(diar, stride=0.005)
        w.start()
        w.add_audio(_audio(16000))
        deadline = time.time() + 5.0
        while diar.diarize_calls == 0 and time.time() < deadline:
            time.sleep(0.01)
        w.stop(timeout=5.0)
        assert diar.diarize_calls >= 1
        assert tl.dominant_speaker(0.0, 0.5) == 0
        assert not w.is_alive
