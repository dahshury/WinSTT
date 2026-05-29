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

import contextlib
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

try:
    from huggingface_hub import constants as hf_constants
except ImportError:  # pragma: no cover — onnx-asr always pulls hf_hub
    hf_constants = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)

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
# Accept either ``_`` or ``.`` as the separator between the stem and the
# quant label. ``onnx-community`` exports use ``_`` (``encoder_model_int8.onnx``);
# alphacep / Vosk exports use ``.`` (``encoder.int8.onnx``). The `_`-only
# regex used to misclassify Vosk's int8 files as default precision, which
# made the per-quant cache probe paint a "downloaded" badge on a quant
# whose bytes weren't actually on disk.
_QUANT_RE = re.compile(r"[._](" + "|".join(_QUANT_SUFFIXES) + r")$")


def _file_quantization(weight_file: Path) -> str:
    """Return the quantization suffix encoded in an onnx weight filename.

    ``encoder_model_int8.onnx`` → ``"int8"``; ``encoder.int8.onnx`` →
    ``"int8"`` (alphacep / Vosk uses ``.`` as separator);
    ``encoder_model.onnx`` → ``""`` (the default, un-suffixed export).
    External-data sidecars use either ``.onnx_data`` (onnx-community
    convention) or ``.onnx.data`` (istupakov NeMo convention); both are
    stripped so the same stem-based quant lookup applies.
    ``model.onnx.data`` → ``""``, ``model.int8.onnx.data`` → ``"int8"``.
    """
    name = weight_file.name
    if name.endswith(".onnx.data"):
        name = name[: -len(".onnx.data")]
    elif name.endswith(".onnx_data"):
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


def resolve_hf_repo(model_name: str | None) -> str | None:
    """Map an onnx-asr alias to a real HF ``org/repo`` id.

    Catalog entries for the NeMo / GigaAM / canonical ``whisper-base``
    families use onnx-asr's short aliases (e.g. ``nemo-canary-1b-v2``)
    rather than a slashed HF repo id; onnx-asr's resolver maps those at
    load time and the cache probe needs the same mapping to find the
    snapshot on disk. Pass-through if the name is already ``org/repo``.
    Returns ``None`` for empty input or unmapped aliases.
    """
    if not model_name:
        return None
    if "/" in model_name:
        return model_name
    try:
        from onnx_asr.resolver import model_repos
    except ImportError:  # pragma: no cover — onnx_asr is a hard dependency
        return None
    return model_repos.get(model_name)


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
    """Every ``*.onnx`` / ``*.onnx_data`` / ``*.onnx.data`` entry under ``snapshot``.

    Symlinks count — HF cache resolves blobs via symlink so following these
    is required to size the real file on disk. Both external-data tail
    conventions are matched (``foo.onnx_data`` and ``foo.onnx.data``) since
    different upstream exporters disagree on the separator.
    """
    weight_files: list[Path] = []
    for pattern in ("*.onnx", "*.onnx_data", "*.onnx.data"):
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


def delete_cache(hf_repo_id: str) -> bool:
    """Remove every cached file for ``hf_repo_id`` from the HF hub cache.

    Wipes the entire ``models--<org>--<repo>`` tree — snapshots, blobs,
    refs, and any in-flight ``.incomplete`` markers — so a subsequent
    download starts fresh instead of resuming from the partial bytes.

    Returns True when the directory existed and was removed (or partially
    removed); False when there was nothing on disk to delete. Never
    raises — the UI calls this from a control command and must always
    get a deterministic reply, so OS-level errors are swallowed and we
    proceed as if the cache had been cleared. The next cache probe will
    surface any residue as ``partial`` and the user can retry.
    """
    cache_root = _hub_cache_dir()
    if cache_root is None:
        return False
    safe = "models--" + hf_repo_id.replace("/", "--")
    repo_dir = cache_root / safe
    if not repo_dir.exists():
        return False
    import shutil

    shutil.rmtree(repo_dir, ignore_errors=True)
    return True


def delete_cache_by_quantization(hf_repo_id: str, quantization: str) -> bool:
    """Remove ONLY the weight files matching ``quantization`` from the HF cache
    of ``hf_repo_id`` — leaves every other quant of the same repo intact.

    Per-quant delete is the trash-icon affordance on the picker: the user
    can wipe a 4 GB ``fp16`` Cohere variant without nuking the 600 MB
    ``q4`` they actually use. The whole-repo :func:`delete_cache` wipes
    everything (including the snapshot tree + blobs); this one walks the
    snapshot, filters weight files by :func:`_file_quantization`, deletes
    the symlink target blob, then unlinks the snapshot symlink.

    Returns True when at least one matching file was found and removed
    (so the UI can broadcast cache invalidation); False when there was
    nothing matching on disk. Never raises — like :func:`delete_cache`,
    OS errors are swallowed and the next cache probe surfaces residue.

    Orphan-blob GC: on Windows without developer-mode the streaming
    downloader's :func:`_link_snapshot_to_blob` falls back from symlink
    to ``shutil.copy2``. That leaves the snapshot file unable to point
    back at its source blob, so :func:`_remove_weight_and_blob` can only
    delete the snapshot copy — the blob is left behind. Next re-download
    sees ``blob.exists()`` and short-circuits to ``"completed"``, which
    is what makes the picker badge flip green instantly with no progress.
    To prevent that, after the per-file removal we sweep ``blobs/`` and
    delete any entry not still referenced by a remaining snapshot
    symlink. On copy-fallback platforms that referenced set is empty —
    so every blob is reclaimed and the next download starts fresh.
    """
    resolved = _latest_snapshot(hf_repo_id)
    if resolved is None:
        return False
    snapshot, blobs_dir = resolved
    matching = [
        weight_file
        for weight_file in _collect_weight_files(snapshot)
        if _file_quantization(weight_file) == quantization
    ]
    if not matching:
        # Still attempt the orphan sweep — a previous delete on a
        # copy-fallback host may have left blobs behind even when no
        # weight files remain for this quant.
        _gc_orphan_blobs(snapshot.parent, blobs_dir)
        return False
    removed_any = False
    for weight_file in matching:
        removed_any |= _remove_weight_and_blob(weight_file, blobs_dir)
    _gc_orphan_blobs(snapshot.parent, blobs_dir)
    return removed_any


def _gc_orphan_blobs(snapshots_root: Path, blobs_dir: Path) -> None:
    """Delete blobs not referenced by any remaining snapshot symlink.

    A snapshot file references its blob via a relative symlink (real
    symlink on POSIX / dev-mode Windows). Walk every snapshot, collect
    each readable symlink target's basename, and unlink any blob whose
    name isn't in that set. Skips ``.partial`` / ``.incomplete`` markers
    so concurrent in-flight downloads aren't disturbed.

    On copy-fallback hosts no snapshot is a symlink, so the referenced
    set is empty and every blob is GC'd — which is the correct outcome
    there because the copy is the authoritative file and the blob is a
    pure duplicate wasting disk + tricking the next re-download into a
    no-op "completed".
    """
    if not blobs_dir.exists():
        return
    referenced: set[str] = set()
    if snapshots_root.exists():
        try:
            snap_dirs = [d for d in snapshots_root.iterdir() if d.is_dir()]
        except OSError:
            snap_dirs = []
        for snap_dir in snap_dirs:
            for snap_file in snap_dir.rglob("*"):
                if not snap_file.is_symlink():
                    continue
                try:
                    target = snap_file.readlink()
                    resolved_target = target if target.is_absolute() else (snap_file.parent / target).resolve()
                    referenced.add(resolved_target.name)
                except OSError:
                    continue
    try:
        entries = list(blobs_dir.iterdir())
    except OSError:
        return
    for entry in entries:
        if not entry.is_file():
            continue
        if entry.name.startswith(".") or entry.name.endswith((".partial", ".incomplete")):
            continue
        if entry.name in referenced:
            continue
        with contextlib.suppress(OSError):
            entry.unlink()


def _remove_weight_and_blob(weight_file: Path, blobs_dir: Path) -> bool:
    """Unlink ``weight_file`` and its blob target. Best-effort, never raises.

    HF's cache layout stores file content in ``blobs/<sha>`` and the
    snapshot's named file is a symlink into ``blobs``. To reclaim disk
    space we need to delete both the symlink and the underlying blob.
    """
    blob_target: Path | None = None
    try:
        if weight_file.is_symlink():
            target = weight_file.readlink()
            blob_target = target if target.is_absolute() else (weight_file.parent / target).resolve()
    except OSError:
        blob_target = None
    try:
        weight_file.unlink()
    except OSError:
        return False
    if blob_target is not None and blob_target.exists() and _is_under(blob_target, blobs_dir):
        with contextlib.suppress(OSError):
            blob_target.unlink()
    return True


def _is_under(child: Path, parent: Path) -> bool:
    """Best-effort containment check that survives missing parents."""
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except (OSError, ValueError):
        return False


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


# ── Authoritative "would a load download anything?" check ──────────────────
#
# The ``*.onnx`` glob above is a fast HEURISTIC: it sees weight files, not the
# COMPLETE file set a given family needs to load. A model can have its int8
# ``*.onnx`` weights on disk but be missing ``vocab.txt`` / ``tokens.txt`` /
# ``config.json`` / a second decoder graph / the ``.onnx_data`` sidecar — in
# which case the badge paints "Downloaded" but the swap silently fetches the
# rest in the background. To make the picker's verdict match what a real swap
# does **for every family**, we ask the loader's OWN resolver to resolve the
# full set offline. If it can't, a load would download → the UI must not claim
# "cached".


def onnx_asr_would_download(onnx_model_name: str, quantization: str | None) -> bool | None:
    """Would loading ``(onnx_model_name, quantization)`` via onnx-asr fetch bytes?

    Delegates to onnx-asr's own ``Resolver.resolve_model`` in OFFLINE mode —
    the same ``_get_model_files`` + ``config.json`` + ``.onnx?data`` sidecar set
    it feeds to ``snapshot_download`` at load time. This is the only way to keep
    the picker's "downloaded" verdict in lock-step with what an actual swap
    fetches across every family without re-deriving each one's file layout here
    (NeMo = encoder+decoder+vocab; Whisper = encoder+decoder+tokenizer+vocab+…;
    Kaldi/Vosk = the ``am/`` + ``graph/`` tree; …). The resolver's glob
    patterns (``model?int8.onnx``) also absorb the ``.``-vs-``_`` separator
    difference a hand-rolled probe gets wrong.

    Returns:
        * ``True``  — at least one required file is missing → a load downloads.
        * ``False`` — every required file resolves offline → the load is silent.
        * ``None``  — undeterminable (onnx-asr absent, unknown model type, or an
          unexpected error); callers keep their heuristic verdict.

    Never hits the network: the resolver is built ``offline=True`` so its
    download fallback re-raises instead of fetching.
    """
    try:
        from onnx_asr.loader import create_asr_resolver
    except Exception:  # pragma: no cover — onnx-asr is a hard dependency
        return None
    try:
        resolver = create_asr_resolver(model=onnx_model_name, offline=True)
        resolver.resolve_model(quantization=quantization or None)
    except FileNotFoundError:
        # onnx-asr's ModelFileNotFoundError and huggingface_hub's
        # LocalEntryNotFoundError both subclass FileNotFoundError → a required
        # file (or the config.json the resolver reads to pick a model type)
        # isn't cached, so a load would download it.
        return True
    except Exception:
        # ModelNotSupportedError / InvalidModelTypeInConfigError / a corrupt
        # snapshot / etc. — we can't speak for this id; let the heuristic stand.
        logger.debug("onnx-asr offline resolve inconclusive for %s", onnx_model_name, exc_info=True)
        return None
    return False


def would_download_on_load(
    onnx_model_name: str | None,
    *,
    local_path: str | None,
    quantization: str | None,
) -> bool | None:
    """Unified "would a swap to this model+quant fetch bytes from HF?" verdict.

    Every catalog family now loads through onnx-asr's resolver (SenseVoice
    included — it has its own ``SenseVoiceCtc`` model class in the fork), so a
    single authoritative check covers them all:

    * **Custom local bundle** (``local_path`` set) — files already on disk;
      onnx-asr loads via ``path=`` with no network. → ``False``.
    * **Everything else** — onnx-asr's offline resolver (authoritative).

    ``None`` means "couldn't tell" — callers keep their heuristic verdict.
    """
    if local_path:
        return False
    if not onnx_model_name:
        return None
    return onnx_asr_would_download(onnx_model_name, quantization)
