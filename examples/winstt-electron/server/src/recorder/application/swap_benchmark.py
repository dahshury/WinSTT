"""End-to-end performance benchmark for live model swaps.

Captures per-phase wall-clock timings, process RSS deltas, and CPU
utilisation across a single swap. The output is a single structured
``logger.info`` line, easy to grep:

    [swap-benchmark] kind=main name=onnx-community/whisper-base
      outcome=completed total=4321ms
      phases=[unload=42ms gc=8ms load=4187ms commit=1ms]
      rss_delta=[after_unload=-1402MB after_load=+812MB net=+812MB]
      cpu_pct=68.4

The benchmark is intentionally cheap: ``psutil`` snapshots are taken at
explicit checkpoints (not on a sampling thread), so it adds no
background overhead. When ``psutil`` isn't installed the memory and CPU
fields are reported as ``n/a`` — the timing data is still useful.
"""

from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterator

try:  # pragma: no cover — import-guarded fallback
    import psutil
except ImportError:  # pragma: no cover
    psutil = None

logger = logging.getLogger(__name__)


class SwapBenchmark:
    """Records phase timings + memory/CPU snapshots for a single model swap.

    Construct one per swap, call ``phase(name)`` around each step, and
    invoke ``sample_memory(label)`` at checkpoints where RSS matters
    (typically: before unload, after unload+gc, after load). Call
    ``log(outcome)`` exactly once at the end — it prints the full row.

    Args:
        kind: ``"main"`` or ``"realtime"`` — surfaced in the log row.
        name: HF model id being loaded.
    """

    def __init__(self, kind: str, name: str) -> None:
        self._kind = kind
        self._name = name
        self._phases: dict[str, float] = {}
        self._memory_bytes: dict[str, int] = {}
        self._total_start = time.perf_counter()
        self._proc = psutil.Process() if psutil is not None else None
        # Prime psutil's CPU counter. The first call to cpu_percent()
        # returns 0.0 because it has no reference point; subsequent calls
        # report the average over the elapsed interval. We discard this
        # priming call so the final log() reads "% over the entire swap".
        if self._proc is not None:
            self._proc.cpu_percent(interval=None)
        # Baseline memory captured at construction so callers don't have
        # to remember to do it themselves before the first phase.
        self.sample_memory("before")

    @contextmanager
    def phase(self, name: str) -> Iterator[None]:
        """Time a single phase. Re-entry on the same name overwrites the prior reading."""
        t0 = time.perf_counter()
        try:
            yield
        finally:
            self._phases[name] = (time.perf_counter() - t0) * 1000.0

    def sample_memory(self, label: str) -> None:
        """Snapshot process RSS under ``label``. No-op when psutil is missing."""
        if self._proc is None:
            return
        self._memory_bytes[label] = self._proc.memory_info().rss

    def _cpu_pct_str(self) -> str:
        if self._proc is None:
            return "n/a"
        return f"{self._proc.cpu_percent(interval=None):.1f}"

    def _phases_str(self) -> str:
        return " ".join(f"{k}={v:.0f}ms" for k, v in self._phases.items())

    def log(self, outcome: str) -> None:
        """Emit the structured benchmark line. ``outcome`` is a free-form
        tag (``"completed"`` / ``"failed_restored"`` / ``"failed_no_transcriber"`` / ``"cancelled"``)."""
        total_ms = (time.perf_counter() - self._total_start) * 1000.0
        phases_str = self._phases_str()
        rss_str = self._format_rss_deltas()
        cpu_str = self._cpu_pct_str()
        logger.info(
            "[swap-benchmark] kind=%s name=%s outcome=%s total=%.0fms phases=[%s] rss_delta=[%s] cpu_pct=%s",
            self._kind,
            self._name,
            outcome,
            total_ms,
            phases_str,
            rss_str,
            cpu_str,
        )

    def _format_rss_deltas(self) -> str:
        """Report RSS at each labelled checkpoint as a signed MB delta vs ``before``.

        Returns ``n/a`` when psutil wasn't available or no samples landed.
        """
        baseline = self._memory_bytes.get("before")
        if baseline is None:
            return "n/a"
        parts = self._rss_delta_parts(baseline)
        return " ".join(parts) if parts else "n/a"

    def _rss_delta_parts(self, baseline: int) -> list[str]:
        """Signed-MB delta strings for every checkpoint other than ``before``."""
        return [
            f"{label}={(rss - baseline) / (1024.0 * 1024.0):+.0f}MB"
            for label, rss in self._memory_bytes.items()
            if label != "before"
        ]
