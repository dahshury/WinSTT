"""Unit tests for live_resources — psutil + nvidia-smi probes with mocks."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from unittest.mock import MagicMock, patch

import pytest

from src.recorder.infrastructure import live_resources as lr


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    """Ensure each test starts with a clean cache + primed flag."""
    lr.reset_cache()
    yield
    lr.reset_cache()


@dataclass
class FakeVm:
    """Stand-in for ``psutil.virtual_memory()``."""

    total: int
    available: int


def _make_psutil(
    *,
    total: int = 32 * 1024**3,
    available: int = 16 * 1024**3,
    logical: int = 8,
    physical: int = 4,
    cpu_pct: float = 12.5,
) -> MagicMock:
    mock = MagicMock()
    mock.virtual_memory.return_value = FakeVm(total=total, available=available)
    mock.cpu_count.side_effect = lambda logical=True: (logical and 8) or 4

    def _cpu_count(logical: bool = True) -> int:
        # The MagicMock side_effect signature trick above is brittle —
        # use a real function instead.
        return (logical and 8) or 4

    mock.cpu_count = MagicMock(side_effect=_cpu_count)
    # Override after to keep test parameters honest:
    mock.cpu_count.side_effect = lambda logical=True: (8 if logical else 4) if (logical_default := True) else 0
    mock.cpu_count.side_effect = lambda logical=True: 8 if logical else 4
    mock.cpu_percent.return_value = cpu_pct
    return mock


def _stub_nvidia_smi(stdout: str = "", *, raises: type[Exception] | None = None) -> MagicMock:
    """Build a ``subprocess.run`` stand-in that returns canned nvidia-smi output."""
    if raises is not None:
        return MagicMock(side_effect=raises("simulated"))
    result = MagicMock()
    result.stdout = stdout
    return MagicMock(return_value=result)


# ─── _parse_gpu_row ─────────────────────────────────────────────────────


class TestParseGpuRow:
    def test_valid_row(self) -> None:
        row = "NVIDIA GeForce RTX 4090, 24564, 8000, 16564, 42"
        gpu = lr._parse_gpu_row(row)
        assert gpu is not None
        assert gpu.name == "NVIDIA GeForce RTX 4090"
        assert gpu.total_vram_bytes == 24564 * 1024 * 1024
        assert gpu.used_vram_bytes == 8000 * 1024 * 1024
        assert gpu.free_vram_bytes == 16564 * 1024 * 1024
        assert gpu.utilization_percent == 42

    def test_too_few_columns(self) -> None:
        # Only 4 columns instead of 5 → reject
        assert lr._parse_gpu_row("GPU, 1024, 512, 512") is None

    def test_malformed_total(self) -> None:
        assert lr._parse_gpu_row("GPU, NaN, 512, 512, 10") is None

    def test_malformed_utilization_kept_as_unknown(self) -> None:
        """A bad utilization column should not invalidate the whole row."""
        gpu = lr._parse_gpu_row("GPU, 1024, 512, 512, --")
        assert gpu is not None
        assert gpu.utilization_percent == -1


# ─── _ram_snapshot ──────────────────────────────────────────────────────


class TestRamSnapshot:
    def test_returns_zeros_when_psutil_missing(self) -> None:
        with patch.dict("sys.modules", {"psutil": None}):
            total, avail = lr._ram_snapshot()
            assert total == 0
            assert avail == 0

    def test_returns_psutil_values(self) -> None:
        fake = MagicMock()
        fake.virtual_memory.return_value = FakeVm(total=16 * 1024**3, available=8 * 1024**3)
        with patch.dict("sys.modules", {"psutil": fake}):
            total, avail = lr._ram_snapshot()
            assert total == 16 * 1024**3
            assert avail == 8 * 1024**3

    def test_swallows_psutil_exception(self) -> None:
        fake = MagicMock()
        fake.virtual_memory.side_effect = RuntimeError("boom")
        with patch.dict("sys.modules", {"psutil": fake}):
            total, avail = lr._ram_snapshot()
            assert total == 0
            assert avail == 0


# ─── _cpu_counts ────────────────────────────────────────────────────────


class TestCpuCounts:
    def test_returns_zeros_when_psutil_missing(self) -> None:
        with patch.dict("sys.modules", {"psutil": None}):
            assert lr._cpu_counts() == (0, 0)

    def test_returns_logical_physical(self) -> None:
        fake = MagicMock()
        fake.cpu_count.side_effect = lambda logical=True: 16 if logical else 8
        with patch.dict("sys.modules", {"psutil": fake}):
            assert lr._cpu_counts() == (16, 8)

    def test_handles_none_from_psutil(self) -> None:
        fake = MagicMock()
        fake.cpu_count.return_value = None
        with patch.dict("sys.modules", {"psutil": fake}):
            assert lr._cpu_counts() == (0, 0)


# ─── _cpu_percent ───────────────────────────────────────────────────────


class TestCpuPercent:
    def test_returns_zero_when_psutil_missing(self) -> None:
        with patch.dict("sys.modules", {"psutil": None}):
            assert lr._cpu_percent() == 0.0

    def test_returns_psutil_reading(self) -> None:
        fake = MagicMock()
        fake.cpu_percent.return_value = 37.5
        with patch.dict("sys.modules", {"psutil": fake}):
            assert lr._cpu_percent() == 37.5

    def test_swallows_psutil_exception(self) -> None:
        fake = MagicMock()
        fake.cpu_percent.side_effect = RuntimeError("boom")
        with patch.dict("sys.modules", {"psutil": fake}):
            assert lr._cpu_percent() == 0.0


# ─── _gpu_snapshot ──────────────────────────────────────────────────────


class TestGpuSnapshot:
    def test_no_nvidia_smi(self) -> None:
        with patch(
            "subprocess.run",
            _stub_nvidia_smi(raises=FileNotFoundError),
        ):
            assert lr._gpu_snapshot() == ()

    def test_nvidia_smi_timeout(self) -> None:
        with patch(
            "subprocess.run",
            MagicMock(side_effect=subprocess.TimeoutExpired(cmd="nvidia-smi", timeout=5)),
        ):
            assert lr._gpu_snapshot() == ()

    def test_nvidia_smi_nonzero_exit(self) -> None:
        with patch(
            "subprocess.run",
            MagicMock(side_effect=subprocess.CalledProcessError(1, "nvidia-smi")),
        ):
            assert lr._gpu_snapshot() == ()

    def test_single_gpu(self) -> None:
        stdout = "NVIDIA GeForce RTX 3090, 24576, 4096, 20480, 10\n"
        with patch("subprocess.run", _stub_nvidia_smi(stdout)):
            gpus = lr._gpu_snapshot()
        assert len(gpus) == 1
        assert gpus[0].name == "NVIDIA GeForce RTX 3090"
        assert gpus[0].total_vram_bytes == 24576 * 1024 * 1024
        assert gpus[0].used_vram_bytes == 4096 * 1024 * 1024
        assert gpus[0].free_vram_bytes == 20480 * 1024 * 1024
        assert gpus[0].utilization_percent == 10

    def test_multi_gpu(self) -> None:
        stdout = "NVIDIA A100, 81920, 40960, 40960, 75\nNVIDIA A100, 81920, 0, 81920, 0\n"
        with patch("subprocess.run", _stub_nvidia_smi(stdout)):
            gpus = lr._gpu_snapshot()
        assert len(gpus) == 2

    def test_skips_malformed_rows(self) -> None:
        stdout = "good gpu, 1024, 256, 768, 10\nbroken row\nanother good, 2048, 1024, 1024, 50\n"
        with patch("subprocess.run", _stub_nvidia_smi(stdout)):
            gpus = lr._gpu_snapshot()
        assert len(gpus) == 2
        assert gpus[0].name == "good gpu"
        assert gpus[1].name == "another good"


# ─── TTL cache ──────────────────────────────────────────────────────────


class TestTtlCache:
    def test_cache_returns_same_snapshot_within_ttl(self) -> None:
        fake_psutil = MagicMock()
        fake_psutil.virtual_memory.return_value = FakeVm(total=8 * 1024**3, available=4 * 1024**3)
        fake_psutil.cpu_count.side_effect = lambda logical=True: 4 if logical else 2
        fake_psutil.cpu_percent.return_value = 25.0
        run_mock = _stub_nvidia_smi("")
        with patch.dict("sys.modules", {"psutil": fake_psutil}), patch("subprocess.run", run_mock):
            first = lr.get_live_resources()
            second = lr.get_live_resources()
            assert first is second  # same object → cache hit
            # nvidia-smi probed once total
            assert run_mock.call_count == 1

    def test_force_refresh_bypasses_cache(self) -> None:
        fake_psutil = MagicMock()
        fake_psutil.virtual_memory.return_value = FakeVm(total=8 * 1024**3, available=4 * 1024**3)
        fake_psutil.cpu_count.side_effect = lambda logical=True: 4 if logical else 2
        fake_psutil.cpu_percent.return_value = 25.0
        run_mock = _stub_nvidia_smi("")
        with patch.dict("sys.modules", {"psutil": fake_psutil}), patch("subprocess.run", run_mock):
            lr.get_live_resources()
            lr.get_live_resources(force_refresh=True)
            assert run_mock.call_count == 2

    def test_serialiser_emits_expected_keys(self) -> None:
        snapshot = lr.LiveResources(
            ram_total_bytes=8,
            ram_available_bytes=4,
            cpu_count_logical=2,
            cpu_count_physical=1,
            cpu_percent=10.0,
            gpus=(
                lr.LiveGpuInfo(
                    name="g",
                    total_vram_bytes=100,
                    used_vram_bytes=40,
                    free_vram_bytes=60,
                    utilization_percent=50,
                ),
            ),
        )
        wire = lr.live_resources_dict(snapshot)
        assert wire["ram_total_bytes"] == 8
        assert wire["cpu_count_logical"] == 2
        assert wire["cpu_percent"] == 10.0
        assert isinstance(wire["gpus"], list)
        assert wire["gpus"][0]["name"] == "g"
        assert wire["gpus"][0]["used_vram_bytes"] == 40

    def test_serialiser_without_argument_calls_get_live(self) -> None:
        """live_resources_dict() with no arg should call get_live_resources()."""
        fake_psutil = MagicMock()
        fake_psutil.virtual_memory.return_value = FakeVm(total=1, available=1)
        fake_psutil.cpu_count.side_effect = lambda logical=True: 1
        fake_psutil.cpu_percent.return_value = 0.0
        with patch.dict("sys.modules", {"psutil": fake_psutil}), patch("subprocess.run", _stub_nvidia_smi("")):
            wire = lr.live_resources_dict()
        assert "ram_total_bytes" in wire
        assert wire["gpus"] == []


# ─── psutil priming ─────────────────────────────────────────────────────


class TestPsutilPriming:
    def test_prime_swallows_exceptions(self) -> None:
        fake = MagicMock()
        fake.cpu_percent.side_effect = RuntimeError("boom on prime")
        with patch.dict("sys.modules", {"psutil": fake}):
            # _prime_cpu_percent should not raise
            lr._prime_cpu_percent()
            # And mark as primed so a second call is a no-op
            lr._prime_cpu_percent()
            assert lr._psutil_primed is True

    def test_prime_skipped_when_psutil_missing(self) -> None:
        with patch.dict("sys.modules", {"psutil": None}):
            lr._prime_cpu_percent()
            assert lr._psutil_primed is True
