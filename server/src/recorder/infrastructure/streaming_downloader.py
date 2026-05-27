"""Per-(model, quantization) streaming downloader with byte-level pause/resume.

Wraps the generic :func:`src.synthesizer.infrastructure.asset_downloader.download_with_progress`
primitive — which already streams to ``.partial`` files, checks
``should_pause()`` / ``should_cancel()`` between chunks, and resumes via
HTTP Range from the partial file's current size — and replicates the
HuggingFace cache layout on disk so ``onnx_asr.load_model()`` finds the
files cached and skips its own download path.

Why not just call ``snapshot_download``? Because it runs the whole
download in one synchronous call with no hook for the user-facing
pause / cancel controls. We need byte-level pause mid-file (the user
might click Pause while a 1 GB encoder is at 200 MB and reasonably
expect the bytes already on disk to survive). The TTS asset downloader
solved this same problem with the ``should_pause()`` callback pattern;
this module reuses that primitive and adds HF-specific URL + cache
layout resolution.

Layout produced (matches HuggingFace's own cache):

    {HF_HUB_CACHE}/models--<org>--<repo>/
    ├── blobs/<etag>                          ← actual file content
    ├── snapshots/<commit_hash>/<filename>    ← symlink or copy → ../../blobs/<etag>
    └── refs/main                             ← text file with commit hash

The ``<etag>`` is the SHA-256 hash of the file content (LFS objects use
their LFS SHA-256, small files use git blob SHA-1). HuggingFace's
``get_hf_file_metadata()`` returns this for free along with the resolved
download URL — so we don't have to compute hashes ourselves.

Thread model: every active download runs on its own daemon ``Thread``.
A :class:`DownloadController` holds the per-download flags
(``pause_event`` / ``cancel_event``) and the running thread handle.
The asyncio event loop in ``server.py`` schedules progress events back
onto the audio queue via ``asyncio.run_coroutine_threadsafe``.
"""

from __future__ import annotations

import contextlib
import logging
import shutil
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from src.synthesizer.infrastructure.asset_downloader import download_with_progress

if TYPE_CHECKING:
    from huggingface_hub.file_download import HfFileMetadata

logger = logging.getLogger(__name__)


# Filenames onnx-asr's resolver pulls from a model repo. Mirrors
# `_refetch_hf_snapshot` in :mod:`onnxasr_transcriber` so we cache the
# same set the loader will look for. ``.onnx?data`` covers both the
# istupakov ``.onnx.data`` and onnx-community ``.onnx_data`` external-data
# conventions in one pattern.
_ONNX_PATTERNS: tuple[str, ...] = ("*.onnx", "*.onnx_data", "*.onnx.data")
_CONFIG_FILES: tuple[str, ...] = ("config.json", "config.yaml")


@dataclass
class DownloadFile:
    """One file in a per-quant download — its repo path + resolved metadata."""

    filename: str
    url: str
    etag: str
    commit_hash: str
    size: int


@dataclass
class DownloadController:
    """Per-(model, quantization) downloader handle.

    Owns the pause / cancel flags AND the background thread that runs
    the download loop. The flags are :class:`threading.Event` so the
    download worker can ``wait()`` cheaply during a pause without
    spinning a poll loop — the worker exits cleanly on pause (leaving
    ``.partial`` files in place) and re-runs from scratch on resume,
    skipping already-completed files.
    """

    model_id: str
    quantization: str
    pause_event: threading.Event = field(default_factory=threading.Event)
    cancel_event: threading.Event = field(default_factory=threading.Event)
    is_running: threading.Event = field(default_factory=threading.Event)
    _thread: threading.Thread | None = None
    _per_file_done: dict[str, int] = field(default_factory=dict)
    _per_file_total: dict[str, int] = field(default_factory=dict)
    _start_time: float = 0.0
    _current_file: str | None = None

    @property
    def key(self) -> tuple[str, str]:
        return (self.model_id, self.quantization)

    def request_pause(self) -> None:
        """Set the pause flag. Worker thread exits at the next chunk."""
        self.pause_event.set()

    def clear_pause(self) -> None:
        """Reset the pause flag so a fresh start() runs to completion."""
        self.pause_event.clear()

    def request_cancel(self) -> None:
        """Set cancel + pause (the latter wakes the chunk loop fast)."""
        self.cancel_event.set()
        self.pause_event.set()

    def is_paused(self) -> bool:
        return self.pause_event.is_set() and not self.cancel_event.is_set()


def _hub_cache_root() -> Path | None:
    """Return ``HF_HUB_CACHE`` as a ``Path``, or None if hf isn't installed."""
    try:
        from huggingface_hub import constants as hf_constants
    except ImportError:  # pragma: no cover — onnx-asr is a hard dep
        return None
    return Path(hf_constants.HF_HUB_CACHE)


def _repo_root(cache_root: Path, repo_id: str) -> Path:
    """HuggingFace's ``models--<org>--<repo>`` directory for ``repo_id``."""
    return cache_root / ("models--" + repo_id.replace("/", "--"))


def _matches_quantization(filename: str, quantization: str) -> bool:
    """True when ``filename`` is the requested quant's variant.

    Mirror of :func:`model_cache._file_quantization` — but inverted: given
    a filename + a target quant, return whether it belongs to that quant.
    The default precision is encoded as empty string and matches files
    with no quantization suffix (``encoder_model.onnx``).
    """
    # Strip whichever external-data suffix the producer uses so the quant
    # suffix is at the end of the stripped name.
    stem = filename
    for tail in (".onnx.data", ".onnx_data", ".onnx"):
        if stem.endswith(tail):
            stem = stem[: -len(tail)]
            break
    suffixes = ("q4f16", "bnb4", "int8", "fp16", "uint8", "q4")
    for suffix in suffixes:
        if stem.endswith("_" + suffix):
            return quantization == suffix
    return quantization == ""


def _select_files_for_quant(all_files: list[str], quantization: str) -> list[str]:
    """Pick the repo files we actually need for this quant.

    The selection matches onnx-asr's ``_refetch_hf_snapshot`` allow-patterns:
    every weights file matching the quant + the config sidecars (which are
    NOT quant-specific and are shared across all variants).
    """
    selected: list[str] = []
    for filename in all_files:
        is_onnx = any(filename.endswith(ext.lstrip("*")) for ext in _ONNX_PATTERNS)
        is_config = filename in _CONFIG_FILES or filename.endswith("/config.json") or filename.endswith("/config.yaml")
        if (is_onnx and _matches_quantization(filename, quantization)) or is_config:
            selected.append(filename)
    return selected


def _resolve_file_metadata(repo_id: str, filename: str) -> HfFileMetadata | None:
    """Resolve ``(commit_hash, etag, size, location)`` for one repo file.

    Returns None when the HF API isn't reachable or the file doesn't
    exist — the caller treats that as a hard failure (the download as a
    whole can't complete without the metadata).
    """
    try:
        from huggingface_hub import get_hf_file_metadata, hf_hub_url
    except ImportError:  # pragma: no cover
        return None
    url = hf_hub_url(repo_id, filename)
    try:
        return get_hf_file_metadata(url)
    except Exception:
        logger.exception("Failed to resolve HF metadata for %s/%s", repo_id, filename)
        return None


def _resolve_download_files(repo_id: str, quantization: str) -> list[DownloadFile] | None:
    """Enumerate + resolve every file we need to fetch for ``(repo, quant)``.

    Returns None on any unrecoverable failure (no HF, unreadable repo,
    missing metadata) — the caller emits a download-failed event.
    """
    try:
        from huggingface_hub import HfApi
    except ImportError:  # pragma: no cover
        return None
    try:
        all_files = HfApi().list_repo_files(repo_id)
    except Exception:
        logger.exception("Failed to list files for %s", repo_id)
        return None
    needed = _select_files_for_quant(all_files, quantization)
    resolved: list[DownloadFile] = []
    for filename in needed:
        meta = _resolve_file_metadata(repo_id, filename)
        if meta is None or meta.etag is None or meta.commit_hash is None:
            logger.warning("Skipping %s/%s — missing HF metadata", repo_id, filename)
            continue
        resolved.append(
            DownloadFile(
                filename=filename,
                url=meta.location,
                etag=meta.etag,
                commit_hash=meta.commit_hash,
                size=meta.size or 0,
            )
        )
    return resolved


def _blob_path(repo_root: Path, etag: str) -> Path:
    """Content-addressable blob path for this file in HF's cache."""
    return repo_root / "blobs" / etag


def _snapshot_path(repo_root: Path, commit_hash: str, filename: str) -> Path:
    """Named symlink inside HF's snapshots/<commit>/<filename>."""
    return repo_root / "snapshots" / commit_hash / filename


def _refs_path(repo_root: Path) -> Path:
    """The single text file storing the resolved branch's commit hash."""
    return repo_root / "refs" / "main"


def _link_snapshot_to_blob(snapshot: Path, blob: Path) -> None:
    """Create the snapshot symlink → blob (copy fallback on Windows).

    HuggingFace creates a relative symlink; on Windows without dev-mode
    that requires elevation, so we fall back to copying. Either way the
    snapshot file looks like a normal file to ``onnx_asr.load_model()``,
    which only reads it.
    """
    snapshot.parent.mkdir(parents=True, exist_ok=True)
    if snapshot.exists() or snapshot.is_symlink():
        with contextlib.suppress(OSError):
            snapshot.unlink()
    # Relative target keeps the cache portable across HF_HUB_CACHE moves.
    try:
        relative = Path("..") / ".." / "blobs" / blob.name
        snapshot.symlink_to(relative)
        return
    except OSError:
        # Windows without dev-mode + no admin → permission denied.
        # Copy is a strict superset of symlink semantics from a reader's POV.
        shutil.copy2(blob, snapshot)


def _write_ref(repo_root: Path, commit_hash: str) -> None:
    """Write refs/main with the commit hash, matching HF's own format."""
    refs = _refs_path(repo_root)
    refs.parent.mkdir(parents=True, exist_ok=True)
    refs.write_text(commit_hash, encoding="utf-8")


def _aggregate_progress_sink(
    controller: DownloadController,
    df: DownloadFile,
    progress_sink: Callable[[str, str, int, int, float], None],
) -> Callable[[float, int, int], None]:
    """Per-file ``on_progress`` adapter that rolls up into per-quant totals.

    ``download_with_progress`` fires one callback per chunk for the
    *current* file. We accumulate ``(downloaded, total)`` per filename
    in the controller's dicts so the rolled-up event the UI consumes
    reflects every file of the in-flight download, not just the file
    currently streaming.
    """

    def _on_chunk(_progress: float, downloaded: int, total: int) -> None:
        controller._per_file_done[df.filename] = downloaded
        # Use the metadata-reported size as the authoritative total — the
        # HTTP Content-Length only covers the still-to-fetch tail when
        # we're resuming via Range.
        controller._per_file_total[df.filename] = df.size or total
        agg_done = sum(controller._per_file_done.values())
        agg_total = sum(controller._per_file_total.values()) or 1
        elapsed = max(time.monotonic() - controller._start_time, 1e-6)
        speed = agg_done / elapsed
        progress_sink(
            controller.model_id,
            controller.quantization,
            agg_done,
            agg_total,
            speed,
        )

    return _on_chunk


def _download_one(
    controller: DownloadController,
    repo_root: Path,
    df: DownloadFile,
    progress_sink: Callable[[str, str, int, int, float], None],
) -> str:
    """Stream one repo file into the HF cache layout.

    Returns ``"completed"`` / ``"paused"`` / ``"cancelled"`` mirroring the
    underlying primitive. Cancel raises ``InterruptedError`` inside the
    primitive — we trap it here so the outer worker loop sees a normal
    return value.
    """
    blob = _blob_path(repo_root, df.etag)
    snapshot = _snapshot_path(repo_root, df.commit_hash, df.filename)
    if blob.exists():
        # Already cached — make sure the snapshot link is present too.
        _link_snapshot_to_blob(snapshot, blob)
        # Pretend we just downloaded the whole thing so the aggregator
        # picks up the completed bytes in the rollup.
        controller._per_file_done[df.filename] = df.size or blob.stat().st_size
        controller._per_file_total[df.filename] = df.size or blob.stat().st_size
        return "completed"

    blob.parent.mkdir(parents=True, exist_ok=True)
    on_chunk = _aggregate_progress_sink(controller, df, progress_sink)
    try:
        outcome = download_with_progress(
            df.url,
            blob,
            on_progress=on_chunk,
            should_cancel=controller.cancel_event.is_set,
            should_pause=controller.pause_event.is_set,
        )
    except InterruptedError:
        return "cancelled"
    if outcome == "completed":
        _link_snapshot_to_blob(snapshot, blob)
    return outcome


def _run_download(
    controller: DownloadController,
    repo_id: str,
    files: list[DownloadFile],
    progress_sink: Callable[[str, str, int, int, float], None],
    completion_sink: Callable[[str, str, str], None],
) -> None:
    """Worker thread body — iterate files in order, emit final outcome.

    Outcomes:
      * ``"completed"`` — every file ended in cache, refs/main written
      * ``"paused"``    — ``pause_event`` set; partial files preserved
      * ``"cancelled"`` — ``cancel_event`` set or any file raised
    """
    controller.is_running.set()
    controller._start_time = time.monotonic()
    cache_root = _hub_cache_root()
    if cache_root is None:
        completion_sink(controller.model_id, controller.quantization, "error")
        controller.is_running.clear()
        return
    repo_root = _repo_root(cache_root, repo_id)
    # Pre-seed the totals so the very first progress event reports the
    # right percentage instead of 0%/0 bytes.
    for df in files:
        controller._per_file_total.setdefault(df.filename, df.size or 0)
        controller._per_file_done.setdefault(df.filename, 0)

    outcome: str = "completed"
    try:
        for df in files:
            if controller.cancel_event.is_set():
                outcome = "cancelled"
                break
            controller._current_file = df.filename
            file_outcome = _download_one(controller, repo_root, df, progress_sink)
            if file_outcome == "paused":
                outcome = "paused"
                break
            if file_outcome == "cancelled":
                outcome = "cancelled"
                break
        if outcome == "completed":
            _write_ref(repo_root, files[0].commit_hash if files else "main")
    finally:
        controller.is_running.clear()
        completion_sink(controller.model_id, controller.quantization, outcome)


class StreamingDownloadRegistry:
    """One :class:`DownloadController` per ``(model_id, quantization)``.

    Lives on :class:`ServerState` (lazily constructed) so the WS command
    handlers can address an in-flight download by id without a global.
    """

    def __init__(self) -> None:
        self._controllers: dict[tuple[str, str], DownloadController] = {}
        self._lock = threading.Lock()

    def get_or_create(self, model_id: str, quantization: str) -> DownloadController:
        with self._lock:
            key = (model_id, quantization)
            existing = self._controllers.get(key)
            if existing is not None:
                return existing
            controller = DownloadController(model_id=model_id, quantization=quantization)
            self._controllers[key] = controller
            return controller

    def get(self, model_id: str, quantization: str) -> DownloadController | None:
        with self._lock:
            return self._controllers.get((model_id, quantization))

    def drop(self, model_id: str, quantization: str) -> None:
        with self._lock:
            self._controllers.pop((model_id, quantization), None)


def start_streaming_download(
    registry: StreamingDownloadRegistry,
    repo_id: str,
    model_id: str,
    quantization: str,
    progress_sink: Callable[[str, str, int, int, float], None],
    completion_sink: Callable[[str, str, str], None],
) -> DownloadController | None:
    """Public entry — kick off (or resume) a streaming download.

    Idempotent: calling twice while a download is running is a no-op
    (returns the existing controller). Calling after a pause restarts
    the worker thread, which will skip any files already in cache and
    resume the .partial on the file that was mid-stream.

    Returns the controller on success, None if HF metadata resolution
    failed (e.g. private repo, network outage). On None the caller
    should emit a download-failed event itself; this module doesn't
    surface user-facing errors directly so the WS handler controls the
    payload shape.
    """
    controller = registry.get_or_create(model_id, quantization)
    if controller.is_running.is_set():
        return controller
    files = _resolve_download_files(repo_id, quantization)
    if files is None or not files:
        return None
    # Clear the pause/cancel flags so a fresh start runs to completion
    # even after a previous pause/cancel.
    controller.pause_event.clear()
    controller.cancel_event.clear()
    thread = threading.Thread(
        target=_run_download,
        args=(controller, repo_id, files, progress_sink, completion_sink),
        name=f"stt-dl[{model_id}@{quantization or 'default'}]",
        daemon=True,
    )
    controller._thread = thread
    thread.start()
    return controller


def _cli_smoke_test() -> int:  # pragma: no cover — manual smoke test only
    """Tiny CLI: ``python -m streaming_downloader <repo> <quant>``.

    Used for ad-hoc verification on a developer machine. Not exercised
    by pytest because it hits the network.
    """
    if len(sys.argv) < 3:
        print("usage: streaming_downloader <repo_id> <quantization>")
        return 2

    registry = StreamingDownloadRegistry()

    def _progress(model: str, quant: str, done: int, total: int, speed: float) -> None:
        pct = (done / total) * 100 if total else 0
        print(f"{model}@{quant}: {pct:.1f}% ({done}/{total} bytes, {speed / 1024 / 1024:.2f} MB/s)")

    def _complete(model: str, quant: str, outcome: str) -> None:
        print(f"{model}@{quant}: {outcome}")

    controller = start_streaming_download(registry, sys.argv[1], sys.argv[1], sys.argv[2], _progress, _complete)
    if controller is None:
        print("Failed to resolve")
        return 1
    while controller.is_running.is_set():
        time.sleep(0.5)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_cli_smoke_test())
