"""Live host resource snapshot for resource-aware model fitness checks.

Unlike ``system_info`` (static totals, cached once at process start),
this module is honest about *current* utilization — how much RAM is
available right now, how busy the CPU is, and how much VRAM each GPU
has free. The model picker uses this to flag candidates that won't fit
given everything that's already loaded (other apps, the OS page cache,
and — crucially — the dictation model that's currently in memory).

Two design choices worth flagging:

1. **TTL cache, not lifetime cache.** ``get_live_resources()`` is cached
   for ~1 s so a picker that re-renders 40 rows doesn't fire 40 NVML
   probes. Anything older than the TTL is rebuilt from scratch. The
   picker also exposes a refresh button that bypasses the cache.
2. **Best-effort everywhere.** Missing psutil, missing NVIDIA driver,
   malformed output, timeouts — every probe falls back to a sensible
   "I don't know" sentinel rather than raising. The renderer treats
   missing fields as "no warning possible" and renders neutral.

GPU probe strategy (cross-platform):

* **Linux + NVIDIA** — call NVML via ``pynvml`` and trust
  ``nvmlDeviceGetMemoryInfo().free``. Accurate; no driver-model
  quirks to work around.
* **Windows + NVIDIA** — same NVML calls, but use the **v2** memory
  API so the OS-reserved chunk surfaces separately. In WDDM mode (the
  default for consumer GeForce cards) the Windows GPU scheduler
  reserves working-set VRAM that NVML's v1 ``used`` field includes —
  yet Windows releases that reservation under pressure, so it's
  effectively allocatable. We report ``free_vram_bytes = v2.free +
  v2.reserved`` to match Task Manager and DXGI's
  ``QueryVideoMemoryInfo`` Budget, which is what the user actually
  sees and what determines whether a fresh CUDA allocation will
  succeed. On Linux ``reserved`` is typically near-zero, so the
  same expression collapses to NVML's plain ``free``.
* **macOS** — no NVIDIA driver has shipped since macOS 10.14 (2019).
  ``nvmlInit()`` raises immediately, we return an empty tuple, and
  the fit-assessor routes the candidate through the RAM-based CPU
  budget — which is the correct verdict on Apple Silicon's unified
  memory model anyway.
* **AMD / Intel** — no probe yet; falls through the same empty-tuple
  path as macOS. Can be layered on later (``rocm-smi`` on Linux,
  Windows PDH counters on Win) without touching the NVIDIA path.
"""

from __future__ import annotations

import contextlib
import logging
import sys
import threading
import time
from dataclasses import dataclass
from types import ModuleType

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LiveGpuInfo:
    """Per-GPU live snapshot from NVML.

    ``free_vram_bytes`` is the "effectively allocatable" headroom — on
    Windows that's NVML v2 ``free + reserved`` (the reserved chunk is
    released on demand by the GPU scheduler); on Linux it collapses to
    NVML's plain ``free`` since the v2 reserved field is near-zero
    there. ``used_vram_bytes`` is always ``total - free`` so the
    invariant ``total == used + free`` holds for renderers.
    """

    name: str
    total_vram_bytes: int
    used_vram_bytes: int
    free_vram_bytes: int
    utilization_percent: int  # 0..100; -1 if unknown


@dataclass(frozen=True)
class LiveResources:
    """Snapshot of host resources at call time."""

    ram_total_bytes: int
    ram_available_bytes: int
    cpu_count_logical: int
    cpu_count_physical: int
    cpu_percent: float  # 0..100 across all cores; 0.0 if unknown
    gpus: tuple[LiveGpuInfo, ...]


_psutil_primed = False
_psutil_prime_lock = threading.Lock()


def _prime_cpu_percent() -> None:
    global _psutil_primed
    if _psutil_primed:
        return
    with _psutil_prime_lock:
        if _psutil_primed:
            return
        try:
            import psutil

            psutil.cpu_percent(interval=None)
        except Exception:
            logger.debug("psutil cpu_percent prime failed", exc_info=True)
        _psutil_primed = True


_CACHE_TTL_SECONDS = 1.0
_cache_lock = threading.Lock()
_cached_snapshot: LiveResources | None = None
_cached_at: float = 0.0


def _ram_snapshot() -> tuple[int, int]:
    """Return ``(total_bytes, available_bytes)`` from psutil, or ``(0, 0)``."""
    try:
        import psutil
    except ImportError:
        logger.debug("psutil not installed — RAM live snapshot skipped")
        return (0, 0)
    try:
        vm = psutil.virtual_memory()
        return (int(vm.total), int(vm.available))
    except Exception:
        logger.exception("psutil.virtual_memory() raised")
        return (0, 0)


def _cpu_counts() -> tuple[int, int]:
    """Return ``(logical, physical)`` core counts, or ``(0, 0)``."""
    try:
        import psutil
    except ImportError:
        return (0, 0)
    logical = psutil.cpu_count(logical=True) or 0
    physical = psutil.cpu_count(logical=False) or 0
    return (int(logical), int(physical))


def _cpu_percent() -> float:
    """Non-blocking CPU% sample. Returns 0.0 on probe failure or first call."""
    try:
        import psutil
    except ImportError:
        return 0.0
    _prime_cpu_percent()
    try:
        value = psutil.cpu_percent(interval=None)
    except Exception:
        logger.debug("psutil.cpu_percent() raised", exc_info=True)
        return 0.0
    return float(value)


def _is_windows() -> bool:
    """Indirected so tests can patch the platform check without touching ``sys.platform``."""
    return sys.platform == "win32"


def _gpu_snapshot() -> tuple[LiveGpuInfo, ...]:
    """Probe each NVIDIA GPU for live memory + utilization via NVML.

    Returns an empty tuple when ``pynvml`` is missing, NVML init fails
    (no NVIDIA driver), or the device count is zero. Per-device errors
    skip just that device — we never raise from this module.
    """
    try:
        import pynvml
    except ImportError:
        logger.debug("pynvml not installed — GPU live snapshot skipped")
        return ()

    try:
        pynvml.nvmlInit()
    except Exception as e:
        logger.debug("nvmlInit() failed (no NVIDIA driver?): %s", e)
        return ()

    try:
        return _probe_gpus_locked(pynvml)
    finally:
        with contextlib.suppress(Exception):
            pynvml.nvmlShutdown()


def _probe_gpus_locked(pynvml: ModuleType) -> tuple[LiveGpuInfo, ...]:
    """Inner probe loop. Assumes ``nvmlInit()`` already succeeded."""
    try:
        count = int(pynvml.nvmlDeviceGetCount())
    except Exception:
        logger.debug("nvmlDeviceGetCount() raised", exc_info=True)
        return ()

    treat_reserved_as_free = _is_windows()
    gpus: list[LiveGpuInfo] = []
    for index in range(count):
        gpu = _probe_one_gpu(index, pynvml, treat_reserved_as_free=treat_reserved_as_free)
        if gpu is not None:
            gpus.append(gpu)
    return tuple(gpus)


def _probe_one_gpu(index: int, pynvml: ModuleType, *, treat_reserved_as_free: bool) -> LiveGpuInfo | None:
    """Probe a single GPU. Returns ``None`` on per-device errors.

    Uses NVML's v2 memory API when available (driver >= R510, ~2022)
    to separate the OS-reserved chunk from user-allocated bytes. The
    v1 API lumps them together as ``used`` which is exactly the
    over-count we're trying to undo on Windows WDDM.
    """
    try:
        handle = pynvml.nvmlDeviceGetHandleByIndex(index)
        name = _decode_name(pynvml.nvmlDeviceGetName(handle))
        total, _user_used, unallocated, reserved = _read_memory_info(handle, pynvml)
    except Exception:
        logger.debug("Failed to probe GPU %d", index, exc_info=True)
        return None

    free = unallocated + reserved if treat_reserved_as_free else unallocated
    used = max(0, total - free)

    utilization = _safe_utilization(handle, pynvml)
    return LiveGpuInfo(
        name=name,
        total_vram_bytes=total,
        used_vram_bytes=used,
        free_vram_bytes=free,
        utilization_percent=utilization,
    )


def _read_memory_info(handle: object, pynvml: ModuleType) -> tuple[int, int, int, int]:
    """Return ``(total, user_used, free, reserved)`` in bytes.

    Tries the v2 NVML API first (separates ``reserved`` from ``used``);
    falls back to v1 if the driver / pynvml is too old to support v2.
    On v1, ``reserved`` is reported as 0 and ``user_used`` collapses to
    ``v1.used`` (which includes any kernel reservation chunk).
    """
    v2_struct = getattr(pynvml, "nvmlMemory_v2", None)
    if v2_struct is not None:
        try:
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle, v2_struct)
            return (int(mem.total), int(mem.used), int(mem.free), int(getattr(mem, "reserved", 0)))
        except (TypeError, AttributeError):
            logger.debug("nvmlDeviceGetMemoryInfo v2 unavailable (bindings)", exc_info=True)
        except Exception:
            logger.debug("nvmlDeviceGetMemoryInfo v2 raised", exc_info=True)
    mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
    return (int(mem.total), int(mem.used), int(mem.free), 0)


def _decode_name(raw: object) -> str:
    """Driver versions before NVML 12 return bytes; newer ones return str."""
    if isinstance(raw, bytes):
        return raw.decode("utf-8", errors="replace")
    return str(raw)


def _safe_utilization(handle: object, pynvml: ModuleType) -> int:
    """Return GPU utilization percent, or -1 if unsupported."""
    try:
        rates = pynvml.nvmlDeviceGetUtilizationRates(handle)
        return int(rates.gpu)
    except Exception:
        return -1


def get_live_resources(*, force_refresh: bool = False) -> LiveResources:
    """Return a current snapshot of host resources, cached for ~1 s.

    Pass ``force_refresh=True`` from a manual "refresh" button to bypass
    the cache. Concurrent callers share the same snapshot — the lock
    ensures we don't fan out N NVML probes for one batch render.
    """
    global _cached_snapshot, _cached_at
    now = time.monotonic()
    with _cache_lock:
        if not force_refresh and _cached_snapshot is not None and now - _cached_at < _CACHE_TTL_SECONDS:
            return _cached_snapshot
        total_ram, avail_ram = _ram_snapshot()
        logical, physical = _cpu_counts()
        snapshot = LiveResources(
            ram_total_bytes=total_ram,
            ram_available_bytes=avail_ram,
            cpu_count_logical=logical,
            cpu_count_physical=physical,
            cpu_percent=_cpu_percent(),
            gpus=_gpu_snapshot(),
        )
        _cached_snapshot = snapshot
        _cached_at = now
        return snapshot


def reset_cache() -> None:
    """Drop the cached snapshot. Test-only helper — never called in production."""
    global _cached_snapshot, _cached_at, _psutil_primed
    with _cache_lock:
        _cached_snapshot = None
        _cached_at = 0.0
    _psutil_primed = False


def live_resources_dict(snapshot: LiveResources | None = None) -> dict[str, object]:
    """Serialise a snapshot to the wire format consumed by the renderer."""
    snap = snapshot if snapshot is not None else get_live_resources()
    return {
        "ram_total_bytes": snap.ram_total_bytes,
        "ram_available_bytes": snap.ram_available_bytes,
        "cpu_count_logical": snap.cpu_count_logical,
        "cpu_count_physical": snap.cpu_count_physical,
        "cpu_percent": snap.cpu_percent,
        "gpus": [
            {
                "name": g.name,
                "total_vram_bytes": g.total_vram_bytes,
                "used_vram_bytes": g.used_vram_bytes,
                "free_vram_bytes": g.free_vram_bytes,
                "utilization_percent": g.utilization_percent,
            }
            for g in snap.gpus
        ],
    }
