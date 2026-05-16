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

import re
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


#: Known onnx quantization suffixes onnx-community/optimum emit. Longest-match
#: first so ``_q4f16`` isn't mis-parsed as ``_q4``.
_QUANT_SUFFIXES: tuple[str, ...] = ("q4f16", "bnb4", "int8", "fp16", "uint8", "q4")
_QUANT_RE = re.compile(r"_(" + "|".join(_QUANT_SUFFIXES) + r")$")


def _file_quantization(weight_file: Path) -> str:
    """Return the quantization suffix encoded in an onnx weight filename.

    ``encoder_model_int8.onnx`` → ``"int8"``; ``encoder_model.onnx`` → ``""``
    (the default, un-suffixed export). ``.onnx_data`` external-data files use
    the same stem convention so we strip that ext too.
    """
    name = weight_file.name
    if name.endswith(".onnx_data"):
        name = name[: -len(".onnx_data")]
    elif name.endswith(".onnx"):
        name = name[: -len(".onnx")]
    match = _QUANT_RE.search(name)
    return match.group(1) if match else ""


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


def _latest_snapshot(hf_repo_id: str) -> tuple[Path, Path] | None:
    """Resolve ``(snapshot_dir, blobs_dir)`` for the latest cached revision.

    Returns None when the repo isn't cached / can't be read — callers map
    that to ``not_cached``. Picks the most recently mtime'd snapshot, which
    matches HF's "latest revision" behaviour without cracking open refs/.
    """
    cache_root = _hub_cache_dir()
    if cache_root is None:
        return None
    snapshots_dir = _model_snapshot_dir(cache_root, hf_repo_id)
    if not snapshots_dir.exists():
        return None
    try:
        revisions = [d for d in snapshots_dir.iterdir() if d.is_dir()]
    except OSError:
        return None
    if not revisions:
        return None
    snapshot = max(revisions, key=lambda d: d.stat().st_mtime)
    return snapshot, snapshots_dir.parent / "blobs"


def _collect_weight_files(snapshot: Path) -> list[Path]:
    """Every ``*.onnx`` / ``*.onnx_data`` entry under ``snapshot`` (symlinks ok)."""
    weight_files: list[Path] = []
    for pattern in ("*.onnx", "*.onnx_data"):
        for child in snapshot.rglob(pattern):
            if child.is_file() or child.is_symlink():
                weight_files.append(child)
    return weight_files


def _state_from_weight_files(weight_files: list[Path], blobs_dir: Path) -> ModelCacheState:
    """Compute a cache state from a set of weight files + the repo blobs dir.

    Empty input → ``not_cached``. A weight whose symlink target is missing,
    or any ``.incomplete`` marker in ``blobs_dir``, → ``partial``. Otherwise
    ``cached`` with the summed on-disk byte count.
    """
    if not weight_files:
        return ModelCacheState(state="not_cached")

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


def probe_cache_state(hf_repo_id: str) -> ModelCacheState:
    """Probe the HF cache for ``hf_repo_id`` and return its overall state.

    Never raises — on any IO error we conservatively report ``not_cached``
    so the UI prompts a fresh download. "Overall" means *any* weight variant
    present; use :func:`probe_cache_state_by_quantization` for per-precision.
    """
    resolved = _latest_snapshot(hf_repo_id)
    if resolved is None:
        return ModelCacheState(state="not_cached")
    snapshot, blobs_dir = resolved
    return _state_from_weight_files(_collect_weight_files(snapshot), blobs_dir)


def probe_cache_state_by_quantization(hf_repo_id: str, quantizations: list[str]) -> dict[str, ModelCacheState]:
    """Per-precision cache state: which quantization variants are on disk.

    A model's default export and its ``int8`` / ``fp16`` / … variants are
    separate downloads. The picker needs to know *each* one's state so it
    doesn't claim a model is "Downloaded" when only one precision landed.
    Unrequested / absent variants map to ``not_cached``.
    """
    resolved = _latest_snapshot(hf_repo_id)
    if resolved is None:
        return {q: ModelCacheState(state="not_cached") for q in quantizations}
    snapshot, blobs_dir = resolved

    by_quant: dict[str, list[Path]] = {q: [] for q in quantizations}
    for weight_file in _collect_weight_files(snapshot):
        quant = _file_quantization(weight_file)
        if quant in by_quant:
            by_quant[quant].append(weight_file)

    return {q: _state_from_weight_files(files, blobs_dir) for q, files in by_quant.items()}
