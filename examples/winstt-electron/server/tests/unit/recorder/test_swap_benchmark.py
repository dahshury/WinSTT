"""Unit tests for the SwapBenchmark instrument.

Verifies phase timing, RSS deltas and the structured log line shape so a
future refactor doesn't silently drop the diagnostic data we wire into
``_swap_worker``.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING
from unittest.mock import MagicMock

import pytest

from src.recorder.application.swap_benchmark import SwapBenchmark

if TYPE_CHECKING:
    pass


class _StubProcess:
    """Stand-in for ``psutil.Process`` that returns scripted RSS / CPU values.

    Used to exercise the full memory-delta + CPU-percent code path
    deterministically — the real process metrics aren't stable enough
    for assertions inside a unit test.
    """

    def __init__(self, *, rss_sequence: list[int], cpu_sequence: list[float]) -> None:
        self._rss = list(rss_sequence)
        self._cpu = list(cpu_sequence)

    def memory_info(self) -> MagicMock:
        info = MagicMock()
        info.rss = self._rss.pop(0)
        return info

    def cpu_percent(self, interval: float | None = None) -> float:
        return self._cpu.pop(0)


def _install_stub_process(monkeypatch: pytest.MonkeyPatch, stub: _StubProcess) -> None:
    """Patch the module-level psutil so SwapBenchmark uses our stub.

    The benchmark imports psutil at module load and stashes the Process
    factory; we swap in a fake Process class whose constructor returns
    our pre-baked stub.
    """
    import src.recorder.application.swap_benchmark as bench_mod

    fake_psutil = MagicMock()
    fake_psutil.Process.return_value = stub
    monkeypatch.setattr(bench_mod, "psutil", fake_psutil)


class TestSwapBenchmarkPhases:
    def test_phase_records_elapsed_milliseconds(self) -> None:
        bench = SwapBenchmark("main", "x/y")
        with bench.phase("load"):
            time.sleep(0.01)
        # 10 ms ± slack — phase should be > 5 ms and < 200 ms on any sane runner.
        recorded = bench._phases["load"]
        assert recorded >= 5.0
        assert recorded < 200.0

    def test_phase_re_entry_overwrites(self) -> None:
        """The contract is 'one reading per name' — re-entering a phase
        overwrites the prior duration. Locks in the behaviour so a later
        refactor doesn't accidentally accumulate."""
        bench = SwapBenchmark("main", "x/y")
        with bench.phase("load"):
            time.sleep(0.01)
        first = bench._phases["load"]
        with bench.phase("load"):
            pass
        second = bench._phases["load"]
        assert second < first

    def test_phase_records_even_when_block_raises(self) -> None:
        """Phase timing must use a finally clause — failed swaps still
        report timings."""
        bench = SwapBenchmark("main", "x/y")
        with pytest.raises(RuntimeError), bench.phase("load"):
            raise RuntimeError("boom")
        assert "load" in bench._phases


class TestSwapBenchmarkMemory:
    def test_sample_memory_no_psutil_is_silent(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """When psutil isn't available, sample_memory becomes a no-op and
        log() falls back to ``rss_delta=[n/a]``."""
        import src.recorder.application.swap_benchmark as bench_mod

        monkeypatch.setattr(bench_mod, "psutil", None)
        bench = SwapBenchmark("main", "x/y")
        bench.sample_memory("after_load")
        # No samples landed → format helper reports n/a.
        assert bench._format_rss_deltas() == "n/a"

    def test_format_rss_deltas_signed_vs_baseline(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Deltas should be reported relative to the 'before' baseline
        captured in __init__ — positive when memory grew, negative when shrunk."""
        stub = _StubProcess(
            # __init__ samples "before"; then we sample after_unload + after_load.
            rss_sequence=[1_000_000_000, 200_000_000, 1_500_000_000],
            cpu_sequence=[0.0, 42.5],  # priming call + final call
        )
        _install_stub_process(monkeypatch, stub)
        bench = SwapBenchmark("main", "x/y")
        bench.sample_memory("after_unload")
        bench.sample_memory("after_load")
        out = bench._format_rss_deltas()
        # Decimal MiB conversion is intentional in the helper (1024**2),
        # so 800 MB ≈ -763 MiB and 500 MB ≈ +477 MiB after rounding.
        assert "after_unload=-763MB" in out
        assert "after_load=+477MB" in out

    def test_format_rss_deltas_returns_na_when_no_samples_beyond_baseline(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """With psutil available but no extra samples, the only entry is
        'before' — and that's excluded from the delta string."""
        stub = _StubProcess(rss_sequence=[1_000_000_000], cpu_sequence=[0.0])
        _install_stub_process(monkeypatch, stub)
        bench = SwapBenchmark("main", "x/y")
        assert bench._format_rss_deltas() == "n/a"


class TestSwapBenchmarkLog:
    def test_log_emits_single_structured_info_line(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        stub = _StubProcess(
            rss_sequence=[100_000_000, 50_000_000],
            cpu_sequence=[0.0, 73.2],
        )
        _install_stub_process(monkeypatch, stub)
        bench = SwapBenchmark("main", "onnx-community/whisper-base")
        with bench.phase("unload"):
            pass
        bench.sample_memory("after_unload")

        with caplog.at_level(logging.INFO, logger="src.recorder.application.swap_benchmark"):
            bench.log("completed")

        assert len(caplog.records) == 1
        msg = caplog.records[0].getMessage()
        assert "[swap-benchmark]" in msg
        assert "kind=main" in msg
        assert "name=onnx-community/whisper-base" in msg
        assert "outcome=completed" in msg
        assert "unload=" in msg
        # 50 MB - 100 MB ≈ -48 MB
        assert "after_unload=-48MB" in msg
        assert "cpu_pct=73.2" in msg

    def test_log_reports_na_cpu_when_psutil_missing(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        import src.recorder.application.swap_benchmark as bench_mod

        monkeypatch.setattr(bench_mod, "psutil", None)
        bench = SwapBenchmark("realtime", "x/y")
        with caplog.at_level(logging.INFO, logger="src.recorder.application.swap_benchmark"):
            bench.log("failed_no_transcriber")
        msg = caplog.records[0].getMessage()
        assert "cpu_pct=n/a" in msg
        assert "rss_delta=[n/a]" in msg
        assert "outcome=failed_no_transcriber" in msg
