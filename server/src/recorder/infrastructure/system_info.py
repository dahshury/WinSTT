"""Detect system resources for the model-fitness UI heuristic.

Reports total RAM (psutil) and, when an NVIDIA GPU is present, its name
and total VRAM (nvidia-smi). The renderer compares these against each
model's estimated memory footprint to flag uncomfortable choices in the
picker.

Resilient by design — every probe falls back to a "nothing detected"
shape so the UI keeps rendering even on minimal installs (psutil missing,
no GPU, nvidia-smi not on PATH). Detection is cached per process; the
hardware doesn't change at runtime.
"""

from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass
from functools import lru_cache

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class GpuInfo:
    """Per-GPU info from ``nvidia-smi --query-gpu``."""

    name: str
    total_vram_bytes: int


@dataclass(frozen=True)
class SystemInfo:
    """Snapshot of host resources at server start.

    ``gpus`` is ordered as nvidia-smi reports — the recorder always uses
    device index 0, but exposing the list lets the UI mention dual-GPU
    setups clearly. Empty list means no NVIDIA GPU detected; the renderer
    falls back to "CPU only" sizing.
    """

    total_ram_bytes: int
    gpus: tuple[GpuInfo, ...]


def _detect_ram_bytes() -> int:
    try:
        import psutil
    except ImportError:
        logger.warning("psutil not installed — RAM detection skipped")
        return 0
    try:
        return int(psutil.virtual_memory().total)
    except Exception:
        logger.exception("psutil.virtual_memory() raised")
        return 0


def _detect_gpus() -> tuple[GpuInfo, ...]:
    """Probe nvidia-smi for GPU name + total VRAM. Returns empty tuple if absent."""
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            timeout=5,
            check=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        logger.debug("nvidia-smi probe failed: %s", e)
        return ()
    gpus: list[GpuInfo] = []
    for line in result.stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 2:
            continue
        name = parts[0]
        try:
            # nvidia-smi reports memory.total in MiB by default.
            vram_mib = int(parts[1])
        except ValueError:
            continue
        gpus.append(GpuInfo(name=name, total_vram_bytes=vram_mib * 1024 * 1024))
    return tuple(gpus)


@lru_cache(maxsize=1)
def get_system_info() -> SystemInfo:
    """Detect and cache the host's resource snapshot (RAM + GPUs)."""
    return SystemInfo(
        total_ram_bytes=_detect_ram_bytes(),
        gpus=_detect_gpus(),
    )
