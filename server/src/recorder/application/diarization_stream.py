from __future__ import annotations

import logging
import threading
import time
from typing import TYPE_CHECKING

import numpy as np
from typing_extensions import override

from src.building_blocks.types import AudioArray
from src.building_blocks.worker import Worker

if TYPE_CHECKING:
    from src.recorder.domain.ports.diarizer import IDiarizer
    from src.recorder.domain.speaker_timeline import SpeakerTimeline

logger = logging.getLogger(__name__)

#: utterr cadence (rt_timeline_pyannote.py): 1.0s window every 0.1s. These are
#: defaults — the loop paces at ``stride`` but never backs up: if a diarize
#: pass outlasts the stride it just runs again on the *latest* window, so
#: effective stride degrades gracefully under load (utterr drops the same way).
_WINDOW_SECONDS = 1.0
_STRIDE_SECONDS = 0.1
#: Ring buffer cap. A few windows is plenty — we only ever diarize the most
#: recent ``window`` samples; older audio is intentionally dropped (the
#: overlapping windows still cover every instant). Keeps memory O(1) under a
#: multi-hour Listen session.
_BUFFER_WINDOWS = 4


class DiarizationStreamWorker(Worker):
    """Continuous, off-thread speaker diarization for Listen mode.

    Adopts utterr's principle (continuous short rolling windows + persistent
    online clustering) using onnx-asr's torch-free ``SessionDiarizer`` (which
    already keeps session-stable speaker ids across ``diarize()`` calls). Audio
    is teed in via :meth:`add_audio`; the worker thread diarizes the trailing
    ``window`` every ``stride`` and merges the result into a shared
    :class:`SpeakerTimeline`. This replaces the old synchronous
    ``_maybe_emit_speaker_segments`` blob-diarize that blocked the recorder
    loop and produced one 44s decision instead of a streaming timeline.
    """

    def __init__(
        self,
        diarizer: IDiarizer,
        timeline: SpeakerTimeline,
        *,
        sample_rate: int = 16000,
        window_seconds: float = _WINDOW_SECONDS,
        stride_seconds: float = _STRIDE_SECONDS,
    ) -> None:
        super().__init__()
        self._diarizer = diarizer
        self._timeline = timeline
        self._sample_rate = sample_rate
        self._window_samples = max(1, int(window_seconds * sample_rate))
        self._stride_seconds = stride_seconds
        self._buffer = np.zeros(0, dtype=np.float32)
        self._ingested_samples = 0
        self._lock = threading.Lock()
        self._max_buffer = self._window_samples * _BUFFER_WINDOWS

    def add_audio(self, audio: AudioArray) -> None:
        """Tee point. ``audio`` is float32 mono in [-1, 1] at ``sample_rate``.

        Non-blocking and never grows without bound: the ring buffer is capped
        to a few windows; older samples are dropped (only the most recent
        window is ever diarized). ``_ingested_samples`` tracks absolute session
        position so window→absolute-time math stays exact regardless of drops.
        """
        flat = np.asarray(audio, dtype=np.float32).ravel()
        if flat.size == 0:
            return
        with self._lock:
            self._ingested_samples += int(flat.size)
            self._buffer = self._appended(self._buffer, flat, self._max_buffer)

    @staticmethod
    def _appended(buffer: AudioArray, flat: AudioArray, max_buffer: int) -> AudioArray:
        """Append ``flat`` onto ``buffer`` and clamp to the trailing ``max_buffer`` samples.

        Factored out of :meth:`add_audio` so the ring-buffer append+cap math stays
        below the complexity gate; behaviour is identical to the inline version.
        """
        buf = np.concatenate((buffer, flat)) if buffer.size else flat.copy()
        if buf.size > max_buffer:
            buf = buf[-max_buffer:]
        return buf

    def _take_window(self) -> tuple[AudioArray, float] | None:
        """Snapshot the trailing window + its absolute start time, or ``None``
        when less than a full window has been ingested yet."""
        with self._lock:
            if self._buffer.size < self._window_samples:
                return None
            window = self._buffer[-self._window_samples :].copy()
            window_start = (self._ingested_samples - self._window_samples) / self._sample_rate
        return window, window_start

    def _process_once(self) -> bool:
        """Diarize the latest window and merge into the timeline.

        Returns ``True`` if a window was processed. Diarization failures are
        swallowed (the diarizer is fail-soft) so the loop never dies on a bad
        window. Factored out of :meth:`_run` so it is unit-testable without
        threads or wall-clock timing.
        """
        taken = self._take_window()
        if taken is None:
            return False
        window, window_start = taken
        try:
            segments = self._diarizer.diarize(window)
        except Exception:
            logger.exception("[diarize-stream] window diarize failed; skipping")
            return True
        self._timeline.merge(segments, window_start)
        return True

    @override
    def _run(self) -> None:
        while not self.should_stop:
            # Pace at the stride. When a diarize pass outlasts the stride the
            # sleep is still paid but the next window is simply the freshest
            # available — effective stride self-adjusts under load instead of
            # building a backlog (only the most recent window is ever taken).
            self._process_once()
            time.sleep(self._stride_seconds)
