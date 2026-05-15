"""HuggingFace cache probe for ``onnx-community/*`` models.

Surfaces three states per catalog model so the UI can render appropriate
badges next to the picker:

- ``cached``: all ``*.onnx`` weight files are present and complete
- ``partial``: the snapshot directory exists but at least one file is
  missing or an ``.incomplete`` marker is still on disk (download was
  interrupted; huggingface_hub will resume from this point next time)
- ``not_cached``: no snapshot directory at all

The probe runs in O(N_models * file_listing) and is cheap enough to
re-run on every settings panel open. Push updates from the swap workers
keep the state fresh between probes.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

try:
    from huggingface_hub import constants as hf_constants
except ImportError:  # pragma: no cover — onnx-asr always pulls hf_hub
    hf_constants = None  # type: ignore[assignment]


CacheState = Literal["cached", "partial", "not_cached"]


@dataclass(frozen=True)
class ModelCacheState:
    """Cache state for a single model.

    ``downloaded_bytes`` and ``total_bytes`` are 0 for ``not_cached``.
    For ``partial`` they're best-effort (sum of files on disk vs sum of
    expected file sizes from huggingface_hub's resolved blobs). For
    ``cached`` they're equal and represent the total size of weight files.
    """

    state: CacheState
    downloaded_bytes: int = 0
    total_bytes: int = 0

    @property
    def progress(self) -> float:
        """Fraction in [0.0, 1.0]. 1.0 when ``cached``."""
        if self.state == "cached":
            return 1.0
        if self.total_bytes <= 0:
            return 0.0
        return min(1.0, self.downloaded_bytes / self.total_bytes)


def _hub_cache_dir() -> Path | None:
    """Return the HF hub cache root, or None if huggingface_hub isn't installed."""
    if hf_constants is None:
        return None
    return Path(hf_constants.HF_HUB_CACHE)


def _model_snapshot_dir(cache_root: Path, hf_repo_id: str) -> Path:
    """Path of the snapshot directory for ``hf_repo_id`` within the HF cache.

    HF stores repos under ``models--<org>--<repo>``. The snapshots directory
    holds one subdir per revision; we look at the latest by modification
    time (the resolver normally pins a single revision per model).
    """
    safe = "models--" + hf_repo_id.replace("/", "--")
    return cache_root / safe / "snapshots"


def probe_cache_state(hf_repo_id: str) -> ModelCacheState:
    """Probe the HF cache for ``hf_repo_id`` and return its state.

    Never raises — on any IO error we conservatively report ``not_cached``
    so the UI prompts a fresh download. The expected weight files we care
    about are ``*.onnx`` (the model graph) plus its ``*.onnx_data`` if
    present (for >2GB exports); other small metadata files are ignored
    for the purposes of "is this usable?".
    """
    cache_root = _hub_cache_dir()
    if cache_root is None:
        return ModelCacheState(state="not_cached")

    snapshots_dir = _model_snapshot_dir(cache_root, hf_repo_id)
    if not snapshots_dir.exists():
        return ModelCacheState(state="not_cached")

    # Pick the most recently mtime'd snapshot — matches HF's "latest revision"
    # behaviour without us having to crack open refs/.
    try:
        revisions = [d for d in snapshots_dir.iterdir() if d.is_dir()]
    except OSError:
        return ModelCacheState(state="not_cached")
    if not revisions:
        return ModelCacheState(state="not_cached")

    snapshot = max(revisions, key=lambda d: d.stat().st_mtime)

    # Walk the snapshot recursively, collect every .onnx weight file. Each
    # entry in a snapshot is a symlink into ../blobs; resolve to read the
    # actual byte count off the blob.
    weight_files: list[Path] = []
    for child in snapshot.rglob("*.onnx"):
        if child.is_file() or child.is_symlink():
            weight_files.append(child)
    for child in snapshot.rglob("*.onnx_data"):
        if child.is_file() or child.is_symlink():
            weight_files.append(child)

    if not weight_files:
        # Snapshot directory exists but no weights inside — interrupted
        # before any file landed.
        return ModelCacheState(state="not_cached")

    # Sum resolved file sizes. Missing target = partial.
    downloaded = 0
    for f in weight_files:
        try:
            real = f.resolve(strict=True)
        except (FileNotFoundError, OSError):
            return ModelCacheState(state="partial", downloaded_bytes=downloaded, total_bytes=0)
        try:
            downloaded += real.stat().st_size
        except OSError:
            continue

    # Look for ``.incomplete`` markers under the blobs dir — HF writes those
    # while a download is in flight.
    blobs_dir = snapshots_dir.parent / "blobs"
    if blobs_dir.exists():
        try:
            for entry in blobs_dir.iterdir():
                if entry.name.endswith(".incomplete"):
                    return ModelCacheState(
                        state="partial",
                        downloaded_bytes=downloaded,
                        total_bytes=downloaded + entry.stat().st_size,
                    )
        except OSError:
            pass

    return ModelCacheState(state="cached", downloaded_bytes=downloaded, total_bytes=downloaded)
