"""Download Kokoro ONNX model + voicepacks at runtime.

The model files are too big to ship inside the installer (~190 MB combined
for fp16 + all voices), so we fetch on demand into ``%LOCALAPPDATA%/winstt/tts/kokoro/``
the first time the user enables TTS.

Public surface:
    - ``resolve_cache_dir(override)`` → absolute path to the cache directory
    - ``KOKORO_FP16_URL`` / ``KOKORO_VOICES_URL`` — pinned upstream URLs
    - ``download_with_progress(url, target, on_progress, should_pause, should_cancel)`` —
      streaming HTTP download with the same progress callback shape used by
      the STT model downloader, so the renderer can reuse its progress UI.
      Returns one of ``"completed"`` (file finished, atomic rename done) or
      ``"paused"`` (caller asked to pause; ``.partial`` preserved and the
      next call resumes via HTTP Range). Cancel still raises
      :class:`InterruptedError` after unlinking the partial.
    - ``DownloadOutcome`` — the literal return type.
"""

from __future__ import annotations

import contextlib
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Literal

# Pinned to the v1.0 release. The fp16 ONNX is the recommended variant per
# the research report (163 MB, near-fp32 quality). Kept as module-level
# constants so packaging scripts can mirror them into a release bundle.
KOKORO_FP16_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.fp16.onnx"
KOKORO_VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"


class DownloadPaused(Exception):
    """Raised inside warm-up paths to signal "user paused this install".

    Lets the call chain (``KokoroSynthesizer._ensure_loaded`` →
    ``KokoroSynthesizer.warm_up``) report a pause without threading a
    return value through a ``-> None`` port method. Distinct from
    :class:`InterruptedError` (which means cancel — discard partials and
    abort) and :class:`RuntimeError` (which means a real failure that
    should surface as an error banner).
    """


#: Return value of ``download_with_progress`` / ``ensure_assets``. ``"completed"``
#: means the file is fully on disk; ``"paused"`` means the caller's
#: ``should_pause()`` returned True and the partial download was preserved
#: for resume on the next invocation. Cancel surfaces as
#: :class:`InterruptedError`, not a return value, because it must abort
#: every nested operation (sha verify, extract, sentinel write) rather than
#: be threaded through.
DownloadOutcome = Literal["completed", "paused"]

ProgressFn = Callable[[float, int, int], None]
CancelFn = Callable[[], bool]
PauseFn = Callable[[], bool]


def resolve_cache_dir(override: str | None = None) -> Path:
    """Return the absolute cache directory, creating it if missing.

    On Windows the default is ``%LOCALAPPDATA%/winstt/tts/kokoro``; on
    POSIX it falls back to ``~/.cache/winstt/tts/kokoro``. The ``override``
    arg lets callers point at a portable install directory.
    """
    if override:
        path = Path(override).expanduser().resolve()
    else:
        appdata = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        if appdata:
            path = Path(appdata) / "winstt" / "tts" / "kokoro"
        else:
            path = Path.home() / ".cache" / "winstt" / "tts" / "kokoro"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _partial_for(target: Path) -> Path:
    """Sibling ``.partial`` path used as the streaming write target."""
    return target.with_suffix(target.suffix + ".partial")


def download_with_progress(
    url: str,
    target: Path,
    on_progress: ProgressFn | None = None,
    should_cancel: CancelFn | None = None,
    should_pause: PauseFn | None = None,
    chunk_size: int = 1 << 16,
) -> DownloadOutcome:
    """Stream ``url`` into ``target`` with progress, resume, pause + cancel.

    Atomic on success — writes to ``target.partial`` first then renames.
    Resumes a prior ``.partial`` via a ``Range:`` request when one is
    present (servers that don't honour Range get a fresh 200 and we
    restart cleanly). Returns ``"paused"`` when ``should_pause()`` returns
    True mid-stream — the ``.partial`` is preserved and the next call
    resumes from there. Raises :class:`InterruptedError` if
    ``should_cancel()`` returns True; the partial is unlinked before
    raising so the next call starts fresh.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = _partial_for(target)
    resume_from = partial.stat().st_size if partial.exists() else 0

    headers: dict[str, str] = {"User-Agent": "WinSTT/0.1"}
    if resume_from > 0:
        headers["Range"] = f"bytes={resume_from}-"

    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            # If the server ignored Range (200 instead of 206), reset.
            status = getattr(resp, "status", 200)
            if resume_from > 0 and status != 206:
                resume_from = 0
                partial.unlink(missing_ok=True)
            content_length = int(resp.headers.get("Content-Length") or 0)
            total = resume_from + content_length if content_length else 0
            downloaded = resume_from
            mode = "ab" if resume_from > 0 else "wb"
            with partial.open(mode) as out:
                while True:
                    if should_cancel is not None and should_cancel():
                        partial.unlink(missing_ok=True)
                        raise InterruptedError(f"Download cancelled: {url}")
                    if should_pause is not None and should_pause():
                        # Leave .partial in place for the next call to resume.
                        return "paused"
                    chunk = resp.read(chunk_size)
                    if not chunk:
                        break
                    out.write(chunk)
                    downloaded += len(chunk)
                    if on_progress is not None:
                        progress = downloaded / total if total else 0.0
                        on_progress(progress, downloaded, total)
    except urllib.error.URLError as exc:
        # Network blips leave the .partial in place so a retry can resume
        # rather than start over. Cancel/pause own their own cleanup paths.
        raise RuntimeError(f"Failed to download {url}: {exc}") from exc

    partial.replace(target)
    if on_progress is not None:
        on_progress(1.0, downloaded, downloaded)
    return "completed"


def ensure_assets(
    cache_dir: Path,
    model_filename: str,
    voices_filename: str,
    on_progress: ProgressFn | None = None,
    should_cancel: CancelFn | None = None,
    should_pause: PauseFn | None = None,
) -> DownloadOutcome:
    """Ensure both model + voices files exist on disk. Downloads any missing.

    Returns ``"completed"`` when both files are present, ``"paused"`` if
    the user paused mid-download — partial state is preserved on disk and
    the next call resumes from there. Existing files are not re-validated;
    a corrupt download will surface as an ONNX session-create error and
    the user can delete the file to retry.
    """
    model_path = cache_dir / model_filename
    voices_path = cache_dir / voices_filename
    if not model_path.exists():
        outcome = download_with_progress(KOKORO_FP16_URL, model_path, on_progress, should_cancel, should_pause)
        if outcome == "paused":
            return outcome
    if not voices_path.exists():
        outcome = download_with_progress(KOKORO_VOICES_URL, voices_path, on_progress, should_cancel, should_pause)
        if outcome == "paused":
            return outcome
    return "completed"


def nuke_partials(*dirs: Path) -> None:
    """Delete every ``*.partial`` file directly inside the given directories.

    Used by the cancel-while-idle path: when the user pauses mid-install
    and then chooses Cancel, no warm-up loop is running to honour the
    cancel flag — so the server scrubs orphan partial downloads itself
    before reporting completion. Completed (non-``.partial``) files are
    left untouched on purpose: a user who finished the engine pack but
    cancelled during the model download shouldn't be forced to re-fetch
    the engine on their next attempt.
    """
    for directory in dirs:
        if not directory.is_dir():
            continue
        for entry in directory.iterdir():
            if entry.is_file() and entry.name.endswith(".partial"):
                # Best-effort — a stale lock will be cleaned up on the
                # next successful download (which overwrites .partial).
                with contextlib.suppress(OSError):
                    entry.unlink()


def wait_for_resume(should_pause: PauseFn, should_cancel: CancelFn, poll_seconds: float = 0.2) -> None:
    """Block until pause is released or cancel is requested.

    Currently unused by the streaming downloader (which exits cleanly on
    pause and resumes via Range on the next call), but exported for any
    future caller that wants to inline pause-handling without restarting
    the connection.
    """
    while should_pause() and not should_cancel():
        time.sleep(poll_seconds)
