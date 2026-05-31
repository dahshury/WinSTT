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
    _evict_runtime_modules,
    activate,
    ensure_support_pack,
    is_installed,
    pack_filename,
    repair_and_reinstall,
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


def test_is_installed_rejects_double_nested_layout(tmp_path: Path) -> None:
    """The ``runtime/<pkg>/<pkg>/`` corruption pattern must be treated as not installed.

    Reproduces the in-the-wild failure where a prior install with
    ``ignore_errors=True`` left a leftover ``runtime/rpds/`` directory and
    ``shutil.move`` deposited the new copy at ``runtime/rpds/rpds/``,
    making ``rpds`` resolve as a namespace package without ``HashTrieMap``.
    """
    import json

    rt = tmp_path / "runtime"
    rt.mkdir()
    (rt / "kokoro_onnx").mkdir()
    (rt / "kokoro_onnx" / "__init__.py").write_text("", encoding="utf-8")
    (rt / "rpds").mkdir()
    (rt / "rpds" / "rpds").mkdir()  # the double-nest
    (rt / "rpds" / "rpds" / "__init__.py").write_text("", encoding="utf-8")
    (rt / support_pack._SENTINEL).write_text(
        json.dumps({"pack_filename": pack_filename(), "sha256": "x"}), encoding="utf-8"
    )

    assert is_installed(rt) is False


def test_ensure_raises_on_rmtree_failure(
    tmp_path: Path,
    patched_download: bytes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When clearing an existing dst fails, surface a clear error instead of corrupting layout."""
    rt = tmp_path / "runtime"
    rt.mkdir()
    (rt / "kokoro_onnx").mkdir()  # pre-existing so the install loop has to clear it

    real_rmtree = support_pack.shutil.rmtree

    def failing_rmtree(path, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        # Only fail on the install-loop call (clearing a dst directory
        # name inside rt — e.g. `kokoro_onnx`). The post-r1 code creates
        # its own staging dir under rt (``winstt-ttspack-…``) whose
        # cleanup must succeed, otherwise we crash inside the
        # ``TemporaryDirectory.__exit__`` instead of letting the
        # install-loop's ``RuntimeError`` surface.
        p = Path(path)
        if p.is_relative_to(rt) and not p.name.startswith("winstt-ttspack-"):
            raise OSError("simulated lock")
        return real_rmtree(path, *args, **kwargs)

    monkeypatch.setattr(support_pack.shutil, "rmtree", failing_rmtree)

    with pytest.raises(RuntimeError, match="Could not replace existing"):
        ensure_support_pack(rt)


def test_repair_and_reinstall_wipes_sentinel_and_redownloads(tmp_path: Path, patched_download: bytes) -> None:
    """``repair_and_reinstall`` must clear the sentinel and trigger a fresh extract."""
    rt = tmp_path / "runtime"
    rt.mkdir()
    ensure_support_pack(rt)
    assert is_installed(rt) is True

    # Simulate corruption by deleting the file the fake pack ships, then repair.
    (rt / "kokoro_onnx" / "__init__.py").unlink()
    repair_and_reinstall(rt)

    assert (rt / "kokoro_onnx" / "__init__.py").exists()
    assert is_installed(rt) is True


def test_evict_runtime_modules_drops_matching_entries(tmp_path: Path) -> None:
    """Modules whose ``__file__`` is under runtime_dir get popped from sys.modules."""
    import sys
    from types import ModuleType

    rt = (tmp_path / "rt").resolve()
    rt.mkdir()
    fake = ModuleType("winstt_fake_evict")
    fake.__file__ = str(rt / "winstt_fake_evict" / "__init__.py")
    sys.modules["winstt_fake_evict"] = fake
    try:
        _evict_runtime_modules(rt)
        assert "winstt_fake_evict" not in sys.modules
    finally:
        sys.modules.pop("winstt_fake_evict", None)
