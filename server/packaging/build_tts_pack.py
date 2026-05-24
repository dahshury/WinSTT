"""Build the on-demand TTS support pack.

The kokoro-onnx TTS stack is **never** frozen into ``stt-server.exe``
(see the excludes in ``stt-server.spec``). Instead this script produces a
small archive of *only* the packages the exe doesn't already contain.
When a user enables TTS, the app downloads + extracts this pack into
``%LOCALAPPDATA%/winstt/tts/runtime/`` and the server prepends that dir
to ``sys.path`` before importing ``kokoro_onnx`` — same process, no
sidecar exe (see ``src/synthesizer/infrastructure/kokoro_synthesizer``).

Run from ``server/`` (CI runs it in the same job that freezes the exe so
the interpreter / ABI match exactly)::

    uv run python packaging/build_tts_pack.py --out packaging/dist-tts

Output:
* ``winstt-tts-pack-cp<XY>-<plat>.zip`` — packages at the archive root
* ``winstt-tts-pack-cp<XY>-<plat>.zip.sha256`` — hex digest sidecar
* ``manifest.json`` — filename, python/platform tag, sha256, byte size,
  file count, pruned packages (consumed by the release upload + the
  server's confirm-dialog size hint / integrity check)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import sysconfig
import tempfile
import time
import zipfile
from pathlib import Path

#: The only direct requirement — its transitive closure is resolved by uv.
_REQUIREMENT = "kokoro-onnx>=0.5.0"

#: Top-level import / dist names already present in the frozen exe (numpy,
#: onnxruntime and onnxruntime's own protobuf/flatbuffers/packaging).
#: Shipping them again would bloat the pack and risk an ABI clash with the
#: frozen copies that win on ``sys.path`` order anyway. Matched
#: case-insensitively against both package dirs and ``*.dist-info`` stems
#: (``-``/``_`` normalised).
_ALREADY_FROZEN: frozenset[str] = frozenset(
    {
        "numpy",
        "onnxruntime",
        "onnxruntime_gpu",
        "flatbuffers",
        "protobuf",
        "google",  # protobuf's namespace pkg — exe already has it via ORT
        "packaging",
        "pip",
        "setuptools",
        "wheel",
    }
)


def _tags() -> tuple[str, str]:
    """``(python_tag, platform_tag)`` e.g. ``("cp312", "win_amd64")``."""
    py = f"cp{sys.version_info.major}{sys.version_info.minor}"
    plat = sysconfig.get_platform().replace("-", "_").replace(".", "_")
    return py, plat


def _norm(name: str) -> str:
    return name.lower().replace("-", "_")


def _pip_install_target(staging: Path) -> None:
    """Resolve + install the TTS closure into ``staging`` for *this* interpreter."""
    cmd = [
        "uv",
        "pip",
        "install",
        "--target",
        str(staging),
        "--python",
        sys.executable,
        _REQUIREMENT,
    ]
    print(f"==> {' '.join(cmd)}")
    subprocess.run(cmd, check=True)


def _prune(staging: Path) -> list[str]:
    """Delete already-frozen packages + bytecode caches. Returns pruned names."""
    pruned: list[str] = []
    for child in sorted(staging.iterdir()):
        stem = child.name
        if stem.endswith(".dist-info"):
            stem = stem.rsplit("-", 2)[0] if "-" in stem else stem
        if child.name in {"__pycache__"} or _norm(stem) in _ALREADY_FROZEN:
            pruned.append(child.name)
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)
    # Strip *.pyc / __pycache__ everywhere — dead weight in a sys.path pack.
    for pyc in staging.rglob("*.pyc"):
        pyc.unlink(missing_ok=True)
    for cache in staging.rglob("__pycache__"):
        shutil.rmtree(cache, ignore_errors=True)
    return pruned


def _zip_dir(src: Path, dst_zip: Path) -> tuple[int, int]:
    """Zip ``src`` contents at the archive root. Returns (file_count, raw_bytes)."""
    files = sorted(p for p in src.rglob("*") if p.is_file())
    raw = 0
    with zipfile.ZipFile(dst_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for f in files:
            raw += f.stat().st_size
            zf.write(f, f.relative_to(src).as_posix())
    return len(files), raw


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the on-demand TTS support pack.")
    parser.add_argument("--out", required=True, type=Path, help="Output directory")
    args = parser.parse_args(argv)

    out: Path = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    py_tag, plat_tag = _tags()
    pack_name = f"winstt-tts-pack-{py_tag}-{plat_tag}.zip"
    pack_path = out / pack_name

    with tempfile.TemporaryDirectory(prefix="winstt-ttspack-") as tmp:
        staging = Path(tmp) / "site"
        staging.mkdir()
        _pip_install_target(staging)
        pruned = _prune(staging)
        print(f"==> pruned already-frozen: {', '.join(pruned) or '(none)'}")
        file_count, raw_bytes = _zip_dir(staging, pack_path)

    digest = _sha256(pack_path)
    zip_bytes = pack_path.stat().st_size
    (out / f"{pack_name}.sha256").write_text(f"{digest}  {pack_name}\n", encoding="utf-8")

    manifest = {
        "pack_filename": pack_name,
        "python_tag": py_tag,
        "platform_tag": plat_tag,
        "sha256": digest,
        "download_bytes": zip_bytes,
        "extracted_bytes": raw_bytes,
        "file_count": file_count,
        "pruned": pruned,
        "requirement": _REQUIREMENT,
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(
        f"==> pack: {pack_path} ({zip_bytes / 1e6:.1f} MB zip, {raw_bytes / 1e6:.1f} MB extracted, {file_count} files)"
    )
    print(f"==> sha256: {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
