"""Live host resource snapshot for resource-aware model fitness checks.

Unlike ``system_info`` (static totals, cached once at process start),
this module is honest about *current* utilization — how much RAM is
available right now, how busy the CPU is, and how much VRAM each GPU
has free. The model picker uses this to flag candidates that won't fit
given everything that's already loaded (other apps, the OS page cache,
and — crucially — the dictation model that's currently in memory).

Two design choices worth flagging:

1. **TTL cache, not lifetime cache.** ``get_live_resources()`` is cached
   for ~1 s so a picker that re-renders 40 rows doesn't fire 40
   ``nvidia-smi`` subprocesses. Anything older than the TTL is rebuilt
   from scratch. The picker also exposes a refresh button that bypasses
   the cache.
2. **Best-effort everywhere.** Missing psutil, missing nvidia-smi,
   malformed output, timeouts — every probe falls back to a sensible
   "I don't know" sentinel rather than raising. The renderer treats
   missing fields as "no warning possible" and renders neutral.
"""

from __future__ import annotations

import logging
import subprocess
import threading
import time
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LiveGpuInfo:
    """Per-GPU live snapshot from ``nvidia-smi --query-gpu``.

    ``total_vram_bytes`` is re-reported here (not just in ``system_info``)
    so the renderer can compute free / used percentages from a single
    payload — saves an extra round trip and keeps the two values
    consistent with each other.
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


# ─── psutil priming ──────────────────────────────────────────────────────
# ``psutil.cpu_percent(interval=None)`` returns 0.0 on its first call (no
# prior sample to compare against). Prime once at import so subsequent
# ``interval=None`` calls report something meaningful. Failure to prime
# is non-fatal — the first real call just returns 0.0.

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


# ─── TTL cache ───────────────────────────────────────────────────────────
# Module-level single-slot cache. Multiple callers hitting the same picker
# render get the same snapshot without re-querying nvidia-smi.

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


def _gpu_snapshot() -> tuple[LiveGpuInfo, ...]:
    """Probe nvidia-smi for live per-GPU memory + utilization.

    Returns an empty tuple if nvidia-smi is absent, times out, or fails.
    Each successfully parsed row becomes a ``LiveGpuInfo``; malformed rows
    are skipped (we never raise from this module).
    """
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            timeout=5,
            check=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        logger.debug("nvidia-smi live probe failed: %s", e)
        return ()
    gpus: list[LiveGpuInfo] = []
    for line in result.stdout.strip().splitlines():
        parsed = _parse_gpu_row(line)
        if parsed is not None:
            gpus.append(parsed)
    return tuple(gpus)


def _parse_gpu_row(line: str) -> LiveGpuInfo | None:
    """Parse one CSV row from nvidia-smi. Returns ``None`` on malformed input."""
    parts = [p.strip() for p in line.split(",")]
    if len(parts) < 5:
        return None
    name = parts[0]
    try:
        total_mib = int(parts[1])
        used_mib = int(parts[2])
        free_mib = int(parts[3])
    except ValueError:
        return None
    try:
        utilization = int(parts[4])
    except ValueError:
        utilization = -1
    return LiveGpuInfo(
        name=name,
        total_vram_bytes=total_mib * 1024 * 1024,
        used_vram_bytes=used_mib * 1024 * 1024,
        free_vram_bytes=free_mib * 1024 * 1024,
        utilization_percent=utilization,
    )


def get_live_resources(*, force_refresh: bool = False) -> LiveResources:
    """Return a current snapshot of host resources, cached for ~1 s.

    Pass ``force_refresh=True`` from a manual "refresh" button to bypass
    the cache. Concurrent callers share the same snapshot — the lock
    ensures we don't fan out N nvidia-smi processes for one batch render.
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
