"""On-demand TTS support pack: download, verify, extract, activate.

The kokoro-onnx stack is never frozen into ``stt-server.exe`` (see the
excludes in ``packaging/stt-server.spec``). It ships as a small archive
built by ``packaging/build_tts_pack.py`` and uploaded to a pinned GitHub
release. The first time a user enables TTS — and only after they confirm
the download in the UI — this module fetches the pack, verifies its
sha256, extracts it into ``%LOCALAPPDATA%/winstt/tts/runtime/`` and
prepends that directory to ``sys.path`` so ``import kokoro_onnx`` works
**inside the same frozen process** (no sidecar exe, no subprocess).

To the user this is indistinguishable from a model download — it just
also carries the engine code. kokoro-onnx wires espeak-ng itself from the
bundled ``espeakng_loader`` once it's importable, so activation is purely
``sys.path`` + an import-cache invalidation.

Idempotent: a sentinel written after a verified extract short-circuits
every subsequent call. Best-effort integrity: the ``.sha256`` sidecar is
verified when reachable; a missing sidecar logs a warning but doesn't
block the feature.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import logging
import os
import shutil
import sys
import sysconfig
import tempfile
import zipfile
from pathlib import Path

from src.synthesizer.infrastructure.asset_downloader import (
    CancelFn,
    ProgressFn,
    download_with_progress,
)

logger = logging.getLogger(__name__)

#: Pinned release that carries the support pack. The pack only changes
#: when the kokoro-onnx dependency closure changes (rare), so it's pinned
#: independently of the per-app-version release — same pattern as the
#: Kokoro model URLs. Override the whole URL with ``WINSTT_TTS_PACK_URL``
#: (and optionally ``WINSTT_TTS_PACK_SHA256_URL``) for testing / mirrors.
#:
#: Hosted on the PUBLIC ``dahshury/winstt-assets`` repo, NOT the private
#: ``dahshury/winstt2`` app repo: ``download_with_progress`` uses tokenless
#: urllib, and GitHub returns HTTP 404 for asset URLs on private repos to
#: unauthenticated clients. See ``project_private_repo_breaks_pack_distribution``.
_PACK_RELEASE_BASE = "https://github.com/dahshury/winstt-assets/releases/download/tts-pack-v1"

#: Approximate confirm-dialog total: engine pack (~29 MB compressed) +
#: Kokoro fp16 model (~163 MB) + voicepacks (~27 MB). Live progress bars
#: report exact ``Content-Length`` during the download; this is only the
#: up-front "this will download ~N MB" hint.
ENGINE_PACK_BYTES = 30_000_000
KOKORO_MODEL_BYTES = 163_000_000
KOKORO_VOICES_BYTES = 27_000_000
ESTIMATED_INSTALL_BYTES = ENGINE_PACK_BYTES + KOKORO_MODEL_BYTES + KOKORO_VOICES_BYTES

#: Written into the runtime dir after a verified extract. Presence + a
#: matching pack filename means "installed, skip".
_SENTINEL = ".winstt-tts-pack.json"


def pack_filename() -> str:
    """Archive name for *this* interpreter, e.g. ``winstt-tts-pack-cp312-win_amd64.zip``.

    Must match ``packaging/build_tts_pack.py``'s naming so the frozen exe
    pulls the asset built against its own Python/ABI.
    """
    py = f"cp{sys.version_info.major}{sys.version_info.minor}"
    plat = sysconfig.get_platform().replace("-", "_").replace(".", "_")
    return f"winstt-tts-pack-{py}-{plat}.zip"


def pack_url() -> str:
    """Resolved pack download URL (``WINSTT_TTS_PACK_URL`` wins)."""
    override = os.environ.get("WINSTT_TTS_PACK_URL")
    if override:
        return override
    return f"{_PACK_RELEASE_BASE}/{pack_filename()}"


def _pack_sha_url() -> str:
    override = os.environ.get("WINSTT_TTS_PACK_SHA256_URL")
    if override:
        return override
    return f"{pack_url()}.sha256"


def resolve_runtime_dir(override: str | None = None) -> Path:
    """Absolute dir the pack extracts into (sibling of the kokoro cache).

    ``%LOCALAPPDATA%/winstt/tts/runtime`` on Windows, ``~/.cache`` on POSIX.
    """
    if override:
        path = Path(override).expanduser().resolve()
    else:
        appdata = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        base = Path(appdata) if appdata else Path.home() / ".cache"
        path = base / "winstt" / "tts" / "runtime"
    path.mkdir(parents=True, exist_ok=True)
    return path


def is_installed(runtime_dir: Path) -> bool:
    """True when a prior verified extract for this interpreter's pack is present.

    Also rejects the double-nested layout (``runtime/<pkg>/<pkg>/``) that
    can result when a prior install raced a locked ``.pyd``: an earlier
    ``shutil.rmtree(dst, ignore_errors=True)`` would silently no-op and
    ``shutil.move`` would then deposit the new package *inside* the
    leftover one. Python imports the outer dir as a namespace package and
    the native extension is unreachable (``ImportError: cannot import name
    'HashTrieMap' from 'rpds'``). Detecting that here forces a clean
    re-extract instead of trusting a sentinel that lies.
    """
    sentinel = runtime_dir / _SENTINEL
    if not sentinel.is_file() or not (runtime_dir / "kokoro_onnx").is_dir():
        return False
    try:
        meta = json.loads(sentinel.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if meta.get("pack_filename") != pack_filename():
        return False
    return not any(child.is_dir() and (child / child.name).is_dir() for child in runtime_dir.iterdir())


def _read_remote_sha256(should_cancel: CancelFn | None) -> str | None:
    """Fetch + parse the ``.sha256`` sidecar, or None if unreachable."""
    with tempfile.TemporaryDirectory(prefix="winstt-ttssha-") as tmp:
        sha_path = Path(tmp) / "pack.sha256"
        try:
            download_with_progress(_pack_sha_url(), sha_path, None, should_cancel)
        except RuntimeError:
            logger.warning("TTS pack sha256 sidecar unreachable — proceeding without integrity check")
            return None
        token = sha_path.read_text(encoding="utf-8").strip().split()
        return token[0].lower() if token else None


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_support_pack(
    runtime_dir: Path,
    on_progress: ProgressFn | None = None,
    should_cancel: CancelFn | None = None,
) -> None:
    """Download + verify + extract the pack into ``runtime_dir`` if absent.

    No-op when already installed. Raises ``RuntimeError`` on download /
    integrity / extraction failure (the caller surfaces it as a
    ``tts_failed`` event). ``InterruptedError`` propagates on cancel.
    """
    if is_installed(runtime_dir):
        return

    expected_sha = _read_remote_sha256(should_cancel)
    with tempfile.TemporaryDirectory(prefix="winstt-ttspack-") as tmp:
        archive = Path(tmp) / pack_filename()
        download_with_progress(pack_url(), archive, on_progress, should_cancel)

        if expected_sha is not None:
            actual = _sha256(archive)
            if actual != expected_sha:
                raise RuntimeError(
                    f"TTS pack integrity check failed (expected {expected_sha[:12]}…, got {actual[:12]}…)"
                )

        # Extract into a fresh staging dir, then swap atomically so a
        # crashed extract never leaves a half-populated runtime that
        # ``is_installed`` would wrongly trust.
        staging = Path(tmp) / "extracted"
        try:
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(staging)
        except (zipfile.BadZipFile, OSError) as exc:
            raise RuntimeError(f"TTS pack extraction failed: {exc}") from exc

        for child in staging.iterdir():
            dst = runtime_dir / child.name
            if dst.exists():
                # NEVER silently swallow: a half-removed dir leaves
                # ``shutil.move(src_dir, existing_dir)`` falling back to
                # "move INTO existing", which deposits the new package
                # under ``runtime/<pkg>/<pkg>/`` and corrupts every
                # subsequent import (see ``is_installed`` note).
                try:
                    if dst.is_dir():
                        shutil.rmtree(dst)
                    else:
                        dst.unlink()
                except OSError as exc:
                    raise RuntimeError(
                        f"Could not replace existing {dst.name} in TTS runtime "
                        f"({exc}). A previous server process may be holding the "
                        "file open — restart the app and try enabling TTS again."
                    ) from exc
            shutil.move(str(child), str(dst))

    (runtime_dir / _SENTINEL).write_text(
        json.dumps({"pack_filename": pack_filename(), "sha256": expected_sha}),
        encoding="utf-8",
    )
    logger.info("TTS support pack installed → %s", runtime_dir)


def activate(runtime_dir: Path) -> None:
    """Make the extracted pack importable in this process.

    Prepends ``runtime_dir`` to ``sys.path`` (idempotent) and invalidates
    the import caches so a fresh ``import kokoro_onnx`` resolves into it.
    """
    rt = str(runtime_dir)
    if rt not in sys.path:
        sys.path.insert(0, rt)
    importlib.invalidate_caches()


def _evict_runtime_modules(runtime_dir: Path) -> None:
    """Pop ``sys.modules`` entries whose code lives under ``runtime_dir``.

    Needed before retrying an import after a failed install: a namespace
    package previously cached under e.g. ``sys.modules['rpds']`` shadows
    the freshly-extracted regular package and the import keeps failing.
    Pure-Python modules drop cleanly; native ``.pyd`` files stay loaded
    in the OS, but their cached module entry is what blocks re-import.
    """
    rt = str(runtime_dir.resolve()).lower()
    to_drop: list[str] = []
    for name, mod in list(sys.modules.items()):
        candidates: list[str] = []
        file_attr = getattr(mod, "__file__", None)
        if isinstance(file_attr, str):
            candidates.append(file_attr)
        spec = getattr(mod, "__spec__", None)
        locs = getattr(spec, "submodule_search_locations", None) if spec else None
        if locs:
            candidates.extend(str(loc) for loc in locs)
        for loc in candidates:
            if loc and loc.lower().startswith(rt):
                to_drop.append(name)
                break
    for name in to_drop:
        sys.modules.pop(name, None)


def repair_and_reinstall(
    runtime_dir: Path,
    on_progress: ProgressFn | None = None,
    should_cancel: CancelFn | None = None,
) -> None:
    """Force a clean re-download after detecting a corrupt pack at runtime.

    Used by the synthesizer's auto-recovery path: when ``import
    kokoro_onnx`` raises ``ImportError``, that's almost always a sign the
    runtime layout is corrupt (e.g., the double-nested ``rpds/rpds/``
    pattern). Removing the sentinel makes ``is_installed`` return False,
    evicting modules clears any namespace-package cache from the first
    failed attempt, and then ``ensure_support_pack`` re-extracts cleanly.
    The caller still has to ``activate()`` + retry the import.
    """
    sentinel = runtime_dir / _SENTINEL
    sentinel.unlink(missing_ok=True)
    _evict_runtime_modules(runtime_dir)
    ensure_support_pack(runtime_dir, on_progress=on_progress, should_cancel=should_cancel)
