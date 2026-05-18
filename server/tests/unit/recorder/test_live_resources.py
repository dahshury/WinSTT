"""Unit tests for live_resources — psutil + NVML probes with mocks."""

from __future__ import annotations

from collections.abc import Generator
from dataclasses import dataclass
from typing import Any, cast
from unittest.mock import MagicMock, patch

import pytest

from src.recorder.infrastructure import live_resources as lr


@pytest.fixture(autouse=True)
def _reset_cache() -> Generator[None, None, None]:
    """Ensure each test starts with a clean cache + primed flag."""
    lr.reset_cache()
    yield
    lr.reset_cache()


@dataclass
class FakeVm:
    """Stand-in for ``psutil.virtual_memory()``."""

    total: int
    available: int


@dataclass
class FakeMemV1:
    """Stand-in for v1 ``nvmlDeviceGetMemoryInfo()`` (no ``reserved``)."""

    total: int
    used: int
    free: int


@dataclass
class FakeMemV2:
    """Stand-in for v2 ``nvmlDeviceGetMemoryInfo()`` (with ``reserved``)."""

    total: int
    used: int
    free: int
    reserved: int


@dataclass
class FakeUtil:
    """Stand-in for ``nvmlDeviceGetUtilizationRates()``."""

    gpu: int
    memory: int = 0


def _make_fake_pynvml(
    *,
    devices: list[dict[str, Any]] | None = None,
    init_error: type[Exception] | None = None,
    v2_supported: bool = True,
) -> MagicMock:
    """Build a stand-in ``pynvml`` module for sys.modules injection.

    Each device dict supports: ``name`` (str|bytes), ``total``, ``used``,
    ``free``, ``reserved`` (defaults to 0), ``util`` (defaults to 0).
    """
    fake = MagicMock(name="pynvml")

    class FakeNVMLError(Exception):
        pass

    fake.NVMLError = FakeNVMLError
    fake.nvmlMemory_v2 = "nvmlMemory_v2_sentinel" if v2_supported else None

    if init_error is not None:
        fake.nvmlInit.side_effect = init_error("simulated init failure")
    else:
        fake.nvmlInit.return_value = None
    fake.nvmlShutdown.return_value = None

    devs = devices or []
    fake.nvmlDeviceGetCount.return_value = len(devs)
    fake.nvmlDeviceGetHandleByIndex.side_effect = lambda i: ("handle", i)
    fake.nvmlDeviceGetName.side_effect = lambda h: devs[h[1]]["name"]

    def _get_mem(handle: tuple[str, int], version: object = None) -> FakeMemV1 | FakeMemV2:
        dev = devs[handle[1]]
        if version == "nvmlMemory_v2_sentinel" and v2_supported:
            return FakeMemV2(total=dev["total"], used=dev["used"], free=dev["free"], reserved=dev.get("reserved", 0))
        if version is not None and not v2_supported:
            raise TypeError("nvmlDeviceGetMemoryInfo() takes 1 positional argument")
        return FakeMemV1(total=dev["total"], used=dev["used"] + dev.get("reserved", 0), free=dev["free"])

    fake.nvmlDeviceGetMemoryInfo.side_effect = _get_mem
    fake.nvmlDeviceGetUtilizationRates.side_effect = lambda h: FakeUtil(gpu=devs[h[1]].get("util", 0))
    return fake


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


class TestGpuSnapshot:
    def test_no_pynvml(self) -> None:
        with patch.dict("sys.modules", {"pynvml": None}):
            assert lr._gpu_snapshot() == ()

    def test_nvml_init_fails(self) -> None:
        fake = _make_fake_pynvml(init_error=RuntimeError)
        with patch.dict("sys.modules", {"pynvml": fake}):
            assert lr._gpu_snapshot() == ()
        fake.nvmlInit.assert_called_once()
        fake.nvmlDeviceGetCount.assert_not_called()

    def test_device_count_zero(self) -> None:
        fake = _make_fake_pynvml(devices=[])
        with patch.dict("sys.modules", {"pynvml": fake}):
            assert lr._gpu_snapshot() == ()
        fake.nvmlShutdown.assert_called_once()

    def test_linux_path_uses_nvml_free_directly(self) -> None:
        """On Linux ``reserved`` is folded into ``used`` so the wire invariant holds."""
        fake = _make_fake_pynvml(
            devices=[
                {
                    "name": "RTX 4090",
                    "total": 24 * 1024**3,
                    "used": 4 * 1024**3,
                    "free": 20 * 1024**3,
                    "reserved": 50 * 1024**2,
                    "util": 17,
                }
            ]
        )
        with patch.dict("sys.modules", {"pynvml": fake}), patch.object(lr, "_is_windows", return_value=False):
            gpus = lr._gpu_snapshot()
        assert len(gpus) == 1
        g = gpus[0]
        assert g.name == "RTX 4090"
        assert g.total_vram_bytes == 24 * 1024**3
        assert g.free_vram_bytes == 20 * 1024**3
        assert g.used_vram_bytes == g.total_vram_bytes - g.free_vram_bytes
        assert g.utilization_percent == 17

    def test_windows_path_adds_reserved_back_to_free(self) -> None:
        """Windows: reserved chunk is released on pressure → treat as free."""
        total = 12 * 1024**3
        fake = _make_fake_pynvml(
            devices=[
                {
                    "name": "RTX 3080 Ti",
                    "total": total,
                    "used": 5 * 1024**3,
                    "free": 3 * 1024**3,
                    "reserved": 4 * 1024**3,
                }
            ]
        )
        with patch.dict("sys.modules", {"pynvml": fake}), patch.object(lr, "_is_windows", return_value=True):
            gpus = lr._gpu_snapshot()
        assert len(gpus) == 1
        g = gpus[0]
        assert g.total_vram_bytes == total
        assert g.free_vram_bytes == 7 * 1024**3
        assert g.used_vram_bytes == 5 * 1024**3

    def test_v2_unsupported_falls_back_to_v1(self) -> None:
        """Older drivers without v2 API → use v1 (reserved=0, used includes reservation)."""
        fake = _make_fake_pynvml(
            devices=[
                {
                    "name": "GTX 1080",
                    "total": 8 * 1024**3,
                    "used": 3 * 1024**3,
                    "free": 5 * 1024**3,
                    "reserved": 0,
                }
            ],
            v2_supported=False,
        )
        with patch.dict("sys.modules", {"pynvml": fake}), patch.object(lr, "_is_windows", return_value=True):
            gpus = lr._gpu_snapshot()
        assert gpus[0].free_vram_bytes == 5 * 1024**3
        assert gpus[0].used_vram_bytes == 3 * 1024**3

    def test_per_device_error_skips_only_that_device(self) -> None:
        """One broken GPU shouldn't drop the rest of a multi-GPU host."""
        fake = _make_fake_pynvml(
            devices=[
                {"name": "GPU 0", "total": 1024, "used": 256, "free": 768},
                {"name": "BROKEN", "total": 1024, "used": 256, "free": 768},
                {"name": "GPU 2", "total": 2048, "used": 1024, "free": 1024},
            ]
        )
        original_get_mem = fake.nvmlDeviceGetMemoryInfo.side_effect

        def _selective_mem(handle: tuple[str, int], version: object = None) -> FakeMemV1 | FakeMemV2:
            if handle[1] == 1:
                raise fake.NVMLError("device fell off the bus")
            return cast("FakeMemV1 | FakeMemV2", original_get_mem(handle, version))

        fake.nvmlDeviceGetMemoryInfo.side_effect = _selective_mem
        with patch.dict("sys.modules", {"pynvml": fake}), patch.object(lr, "_is_windows", return_value=False):
            gpus = lr._gpu_snapshot()
        assert [g.name for g in gpus] == ["GPU 0", "GPU 2"]

    def test_name_decoded_when_bytes(self) -> None:
        """Older NVML returns bytes; we decode to str."""
        fake = _make_fake_pynvml(
            devices=[{"name": b"NVIDIA GeForce RTX 3060", "total": 12 * 1024**3, "used": 0, "free": 12 * 1024**3}]
        )
        with patch.dict("sys.modules", {"pynvml": fake}), patch.object(lr, "_is_windows", return_value=False):
            gpus = lr._gpu_snapshot()
        assert gpus[0].name == "NVIDIA GeForce RTX 3060"

    def test_utilization_unknown_becomes_negative_one(self) -> None:
        fake = _make_fake_pynvml(devices=[{"name": "GPU", "total": 1024, "used": 0, "free": 1024}])
        fake.nvmlDeviceGetUtilizationRates.side_effect = fake.NVMLError("not supported")
        with patch.dict("sys.modules", {"pynvml": fake}), patch.object(lr, "_is_windows", return_value=False):
            gpus = lr._gpu_snapshot()
        assert gpus[0].utilization_percent == -1

    def test_shutdown_runs_even_when_device_count_raises(self) -> None:
        fake = _make_fake_pynvml(devices=[{"name": "x", "total": 1, "used": 0, "free": 1}])
        fake.nvmlDeviceGetCount.side_effect = RuntimeError("driver borked")
        with patch.dict("sys.modules", {"pynvml": fake}), patch.object(lr, "_is_windows", return_value=False):
            gpus = lr._gpu_snapshot()
        assert gpus == ()
        fake.nvmlShutdown.assert_called_once()

    def test_wire_invariant_total_equals_used_plus_free(self) -> None:
        """The renderer relies on total == used + free; check both platform paths."""
        for is_windows in (True, False):
            fake = _make_fake_pynvml(
                devices=[
                    {
                        "name": "GPU",
                        "total": 16 * 1024**3,
                        "used": 6 * 1024**3,
                        "free": 8 * 1024**3,
                        "reserved": 2 * 1024**3,
                    }
                ]
            )
            with patch.dict("sys.modules", {"pynvml": fake}), patch.object(lr, "_is_windows", return_value=is_windows):
                gpus = lr._gpu_snapshot()
            g = gpus[0]
            msg = f"invariant broken (windows={is_windows})"
            assert g.total_vram_bytes == g.used_vram_bytes + g.free_vram_bytes, msg


class TestTtlCache:
    def test_cache_returns_same_snapshot_within_ttl(self) -> None:
        fake_psutil = MagicMock()
        fake_psutil.virtual_memory.return_value = FakeVm(total=8 * 1024**3, available=4 * 1024**3)
        fake_psutil.cpu_count.side_effect = lambda logical=True: 4 if logical else 2
        fake_psutil.cpu_percent.return_value = 25.0
        fake_pynvml = _make_fake_pynvml(devices=[])
        with (
            patch.dict("sys.modules", {"psutil": fake_psutil, "pynvml": fake_pynvml}),
            patch.object(lr, "_is_windows", return_value=False),
        ):
            first = lr.get_live_resources()
            second = lr.get_live_resources()
            assert first is second
            assert fake_pynvml.nvmlInit.call_count == 1

    def test_force_refresh_bypasses_cache(self) -> None:
        fake_psutil = MagicMock()
        fake_psutil.virtual_memory.return_value = FakeVm(total=8 * 1024**3, available=4 * 1024**3)
        fake_psutil.cpu_count.side_effect = lambda logical=True: 4 if logical else 2
        fake_psutil.cpu_percent.return_value = 25.0
        fake_pynvml = _make_fake_pynvml(devices=[])
        with (
            patch.dict("sys.modules", {"psutil": fake_psutil, "pynvml": fake_pynvml}),
            patch.object(lr, "_is_windows", return_value=False),
        ):
            lr.get_live_resources()
            lr.get_live_resources(force_refresh=True)
            assert fake_pynvml.nvmlInit.call_count == 2

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
        fake_pynvml = _make_fake_pynvml(devices=[])
        with (
            patch.dict("sys.modules", {"psutil": fake_psutil, "pynvml": fake_pynvml}),
            patch.object(lr, "_is_windows", return_value=False),
        ):
            wire = lr.live_resources_dict()
        assert "ram_total_bytes" in wire
        assert wire["gpus"] == []


class TestPsutilPriming:
    def test_prime_swallows_exceptions(self) -> None:
        fake = MagicMock()
        fake.cpu_percent.side_effect = RuntimeError("boom on prime")
        with patch.dict("sys.modules", {"psutil": fake}):
            lr._prime_cpu_percent()
            lr._prime_cpu_percent()
            assert lr._psutil_primed is True

    def test_prime_skipped_when_psutil_missing(self) -> None:
        with patch.dict("sys.modules", {"psutil": None}):
            lr._prime_cpu_percent()
            assert lr._psutil_primed is True
