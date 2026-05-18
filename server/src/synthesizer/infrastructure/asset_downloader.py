"""Download Kokoro ONNX model + voicepacks at runtime.

The model files are too big to ship inside the installer (~190 MB combined
for fp16 + all voices), so we fetch on demand into ``%LOCALAPPDATA%/winstt/tts/kokoro/``
the first time the user enables TTS.

Public surface:
    - ``resolve_cache_dir(override)`` → absolute path to the cache directory
    - ``KOKORO_FP16_URL`` / ``KOKORO_VOICES_URL`` — pinned upstream URLs
    - ``download_with_progress(url, target, on_progress, should_cancel)`` —
      streaming HTTP download with the same progress callback shape used by
      the STT model downloader, so the renderer can reuse its progress UI.
"""

from __future__ import annotations

import os
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path

# Pinned to the v1.0 release. The fp16 ONNX is the recommended variant per
# the research report (163 MB, near-fp32 quality). Kept as module-level
# constants so packaging scripts can mirror them into a release bundle.
KOKORO_FP16_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.fp16.onnx"
KOKORO_VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"

ProgressFn = Callable[[float, int, int], None]
CancelFn = Callable[[], bool]


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


def download_with_progress(
    url: str,
    target: Path,
    on_progress: ProgressFn | None = None,
    should_cancel: CancelFn | None = None,
    chunk_size: int = 1 << 16,
) -> None:
    """Stream ``url`` into ``target`` with progress + cooperative cancellation.

    Atomic on success — writes to ``target.partial`` first then renames.
    Raises ``InterruptedError`` if ``should_cancel()`` returns True mid-stream
    (mirrors the STT downloader's cancel semantics).
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".partial")

    req = urllib.request.Request(url, headers={"User-Agent": "WinSTT/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            downloaded = 0
            with partial.open("wb") as out:
                while True:
                    if should_cancel is not None and should_cancel():
                        partial.unlink(missing_ok=True)
                        raise InterruptedError(f"Download cancelled: {url}")
                    chunk = resp.read(chunk_size)
                    if not chunk:
                        break
                    out.write(chunk)
                    downloaded += len(chunk)
                    if on_progress is not None:
                        progress = downloaded / total if total else 0.0
                        on_progress(progress, downloaded, total)
    except urllib.error.URLError as exc:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"Failed to download {url}: {exc}") from exc

    partial.replace(target)
    if on_progress is not None:
        on_progress(1.0, downloaded, downloaded)


def ensure_assets(
    cache_dir: Path,
    model_filename: str,
    voices_filename: str,
    on_progress: ProgressFn | None = None,
    should_cancel: CancelFn | None = None,
) -> tuple[Path, Path]:
    """Ensure both model + voices files exist on disk. Downloads any missing.

    Returns ``(model_path, voices_path)``. Existing files are not re-validated;
    a corrupt download will surface as an ONNX session-create error and the
    user can delete the file to retry.
    """
    model_path = cache_dir / model_filename
    voices_path = cache_dir / voices_filename
    if not model_path.exists():
        download_with_progress(KOKORO_FP16_URL, model_path, on_progress, should_cancel)
    if not voices_path.exists():
        download_with_progress(KOKORO_VOICES_URL, voices_path, on_progress, should_cancel)
    return model_path, voices_path
