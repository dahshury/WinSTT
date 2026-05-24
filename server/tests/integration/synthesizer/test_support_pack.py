"""On-demand TTS support-pack install logic (no network).

Monkeypatches the HTTP downloader so we can exercise download →
sha256 verify → atomic extract → sentinel → idempotency → activation
without touching GitHub. This is the mechanism that lets ``kokoro_onnx``
import inside the frozen exe even though it ships zero TTS code.
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

from src.synthesizer.infrastructure import support_pack
from src.synthesizer.infrastructure.support_pack import (
    activate,
    ensure_support_pack,
    is_installed,
    pack_filename,
    resolve_runtime_dir,
)


def _fake_pack_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("kokoro_onnx/__init__.py", "VERSION = '0'\n")
        zf.writestr("espeakng_loader/__init__.py", "# bundled espeak-ng\n")
    return buf.getvalue()


@pytest.fixture
def patched_download(monkeypatch: pytest.MonkeyPatch) -> bytes:
    """Patch download_with_progress to serve a fake pack + its sha256 sidecar."""
    import hashlib

    pack = _fake_pack_bytes()
    sha = hashlib.sha256(pack).hexdigest()

    def fake_download(url, target, on_progress=None, should_cancel=None, chunk_size=1 << 16):  # noqa: ANN001, ANN202
        Path(target).parent.mkdir(parents=True, exist_ok=True)
        if url.endswith(".sha256"):
            Path(target).write_text(f"{sha}  {pack_filename()}\n", encoding="utf-8")
        else:
            Path(target).write_bytes(pack)
        if on_progress is not None:
            on_progress(1.0, len(pack), len(pack))

    monkeypatch.setattr(support_pack, "download_with_progress", fake_download)
    return pack


def test_resolve_runtime_dir_override(tmp_path: Path) -> None:
    rt = resolve_runtime_dir(str(tmp_path / "rt"))
    assert rt.is_dir() and rt.name == "rt"


def test_ensure_extracts_and_is_idempotent(tmp_path: Path, patched_download: bytes) -> None:
    rt = tmp_path / "runtime"
    rt.mkdir()

    assert is_installed(rt) is False
    ensure_support_pack(rt)

    assert (rt / "kokoro_onnx" / "__init__.py").read_text(encoding="utf-8") == "VERSION = '0'\n"
    assert (rt / "espeakng_loader").is_dir()
    assert is_installed(rt) is True

    # Second call must be a no-op (sentinel short-circuit) — delete a file
    # and confirm it is NOT re-extracted.
    (rt / "kokoro_onnx" / "__init__.py").unlink()
    ensure_support_pack(rt)
    assert not (rt / "kokoro_onnx" / "__init__.py").exists()


def test_sha_mismatch_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pack = _fake_pack_bytes()

    def bad_download(url, target, on_progress=None, should_cancel=None, chunk_size=1 << 16):  # noqa: ANN001, ANN202
        Path(target).parent.mkdir(parents=True, exist_ok=True)
        if url.endswith(".sha256"):
            Path(target).write_text(f"{'0' * 64}  {pack_filename()}\n", encoding="utf-8")
        else:
            Path(target).write_bytes(pack)

    monkeypatch.setattr(support_pack, "download_with_progress", bad_download)
    rt = tmp_path / "runtime"
    rt.mkdir()

    with pytest.raises(RuntimeError, match="integrity check failed"):
        ensure_support_pack(rt)
    assert is_installed(rt) is False


def test_activate_prepends_syspath(tmp_path: Path) -> None:
    import sys

    rt = tmp_path / "rt"
    rt.mkdir()
    activate(rt)
    assert sys.path[0] == str(rt)
    # Idempotent — no duplicate entry on a second call.
    activate(rt)
    assert sys.path.count(str(rt)) == 1
