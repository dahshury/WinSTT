"""Build-time vendor of the offline base model into a seed HF cache.

Run from ``server/`` before PyInstaller (see ``build.ps1``)::

    uv run python packaging/seed_models.py --out packaging/seed-cache --quant q4

Points ``HF_HUB_CACHE`` at ``--out`` and asks onnx-asr to resolve the
base model at the requested quantization. onnx-asr's resolver downloads
*exactly* the file set it needs (quant-scoped ``*.onnx`` + ``config.*`` +
``vocab.json`` + ``added_tokens.json``) into a standard
``models--<org>--<repo>`` cache tree. ``stt-server.spec`` bundles that
tree; :mod:`src.recorder.infrastructure.seed_cache` copies it into the
user's real HF cache on first run so STT works with zero network.

Idempotent: an already-populated seed dir for the repo is left untouched.
ORT session-build failures after a successful download are tolerated —
the cached files are what we vendor, not the in-memory model.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

#: The offline base model. Multilingual Whisper tiny — smallest export
#: that still does all 99 languages. q4 keeps the installer lean.
_BASE_MODEL = "onnx-community/whisper-tiny"


def _repo_cache_dir(cache_root: Path, hf_repo_id: str) -> Path:
    return cache_root / ("models--" + hf_repo_id.replace("/", "--"))


def _has_onnx(repo_dir: Path) -> bool:
    """True when at least one ``*.onnx`` weight landed under ``repo_dir``."""
    snapshots = repo_dir / "snapshots"
    return snapshots.is_dir() and any(snapshots.rglob("*.onnx"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Vendor the offline base model into a seed HF cache.")
    parser.add_argument("--out", required=True, type=Path, help="Seed cache output dir")
    parser.add_argument("--quant", default="q4", help="Quantization to vendor (default: q4)")
    parser.add_argument("--model", default=_BASE_MODEL, help=f"HF repo id (default: {_BASE_MODEL})")
    args = parser.parse_args(argv)

    out: Path = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    repo_dir = _repo_cache_dir(out, args.model)

    if _has_onnx(repo_dir):
        print(f"==> seed-cache already populated for {args.model} — skipping")
        return 0

    # Scope every HF cache write to the seed dir for this process only.
    os.environ["HF_HUB_CACHE"] = str(out)
    os.environ["HF_HOME"] = str(out)

    print(f"==> seeding {args.model} (quantization={args.quant}) → {out}")
    try:
        import onnx_asr
    except ImportError:
        print("ERROR: onnx_asr not importable — run via `uv run`", file=sys.stderr)
        return 2

    try:
        onnx_asr.load_model(args.model, quantization=args.quant)
    except Exception as exc:
        print(f"   note: model session build raised ({type(exc).__name__}: {exc}); verifying download…")

    if not _has_onnx(repo_dir):
        print(f"ERROR: no .onnx weights in {repo_dir} after download", file=sys.stderr)
        return 1

    onnx_count = sum(1 for _ in (repo_dir / "snapshots").rglob("*.onnx"))
    print(f"==> seeded OK: {onnx_count} onnx file(s) under {repo_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
