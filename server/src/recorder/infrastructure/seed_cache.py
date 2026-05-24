"""First-run seeder: copy the bundled offline base model into the HF cache.

The installer ships a pre-downloaded HuggingFace cache tree for the
offline base model (``onnx-community/whisper-tiny`` at ``q4``) so the app
transcribes out of the box with **zero network**. Every larger / other
model still downloads on demand.

The bundled tree is a verbatim ``models--<org>--<repo>`` HF cache layout
(``blobs/`` + ``snapshots/`` + ``refs/``). On first server start we copy
any bundled repo that isn't already present in the user's real
``HF_HUB_CACHE`` so:

* onnx-asr's resolver finds the snapshot offline (``refs/main`` pins the
  commit, ``snapshots/<commit>/`` holds the weights), and
* :mod:`src.recorder.infrastructure.model_cache` reports it ``cached``.

Best-effort and idempotent: an existing repo dir is never overwritten
(the user may have downloaded a newer revision), and any IO error is
swallowed — a failed seed just means the model downloads normally if a
network is available.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

try:
    from huggingface_hub import constants as hf_constants
except ImportError:  # pragma: no cover — onnx-asr always pulls hf_hub
    hf_constants = None  # type: ignore[assignment]

#: Directory name datas are bundled under (see ``packaging/stt-server.spec``).
_SEED_DIR_NAME = "seed-cache"


def _frozen_root() -> Path | None:
    """The PyInstaller bundle data root, or None when running from source.

    PyInstaller (onedir) sets ``sys.frozen`` and ``sys._MEIPASS`` to the
    ``_internal`` directory where ``datas`` are extracted.
    """
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
    return None


def bundled_seed_dir() -> Path | None:
    """Locate the bundled seed-cache directory, or None if not shipped.

    Frozen: ``<_MEIPASS>/seed-cache``. From source (dev/CI before a build):
    ``server/packaging/seed-cache`` if a prior ``seed_models`` run vendored
    it. Returns None when neither exists so callers no-op gracefully.
    """
    frozen = _frozen_root()
    if frozen is not None:
        candidate = frozen / _SEED_DIR_NAME
        return candidate if candidate.is_dir() else None
    # src/recorder/infrastructure/seed_cache.py → server/
    server_root = Path(__file__).resolve().parents[3]
    candidate = server_root / "packaging" / _SEED_DIR_NAME
    return candidate if candidate.is_dir() else None


def hf_cache_root() -> Path | None:
    """User's HF hub cache root, or None if huggingface_hub is absent."""
    if hf_constants is None:
        return None
    return Path(hf_constants.HF_HUB_CACHE)


def seed_bundled_models(
    *,
    bundled_dir: Path | None = None,
    hf_cache: Path | None = None,
) -> list[str]:
    """Copy every bundled ``models--*`` repo not yet in the HF cache.

    Returns the list of repo dir names that were seeded (empty when there
    was nothing to do). Never raises: any failure is swallowed and the
    affected repo simply isn't seeded.
    """
    src_root = bundled_dir if bundled_dir is not None else bundled_seed_dir()
    dst_root = hf_cache if hf_cache is not None else hf_cache_root()
    if src_root is None or dst_root is None or not src_root.is_dir():
        return []

    seeded: list[str] = []
    try:
        repo_dirs = [d for d in src_root.iterdir() if d.is_dir() and d.name.startswith("models--")]
    except OSError:
        return []

    for repo_src in repo_dirs:
        repo_dst = dst_root / repo_src.name
        if repo_dst.exists():
            # Never clobber a real cache — the user may hold a newer or
            # additional revision than the one we shipped.
            continue
        try:
            dst_root.mkdir(parents=True, exist_ok=True)
            # symlinks=False: materialize a self-contained, plain-file copy
            # so the seed works without Windows symlink privilege and
            # ``Path.resolve(strict=True)`` (model_cache) finds real files.
            shutil.copytree(repo_src, repo_dst, symlinks=False)
            seeded.append(repo_src.name)
        except OSError:
            # Partial copy: clear it so a later online download starts clean
            # rather than resuming from a half-seeded tree.
            shutil.rmtree(repo_dst, ignore_errors=True)
            continue

    return seeded
