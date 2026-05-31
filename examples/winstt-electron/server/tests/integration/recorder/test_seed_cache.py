"""Offline base-model seeder behaviour.

Covers the first-run copy of the bundled ``whisper-tiny q4`` HF cache
tree into the user's real HF cache: it must seed when absent, be
idempotent, never clobber an existing repo, and degrade to a no-op when
nothing is bundled — so STT works with zero network out of the box.
"""

from __future__ import annotations

from pathlib import Path

from src.recorder.infrastructure.seed_cache import seed_bundled_models


def _fake_repo(root: Path, name: str = "models--onnx-community--whisper-tiny") -> Path:
    """Build a minimal HF-cache-shaped repo tree under ``root``."""
    repo = root / name
    snap = repo / "snapshots" / "deadbeef"
    snap.mkdir(parents=True)
    (snap / "config.json").write_text("{}", encoding="utf-8")
    (snap / "encoder_model_q4.onnx").write_bytes(b"\x00onnx")
    (repo / "refs").mkdir()
    (repo / "refs" / "main").write_text("deadbeef", encoding="utf-8")
    return repo


def test_seeds_when_cache_absent(tmp_path: Path) -> None:
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    _fake_repo(bundled)
    hf_cache = tmp_path / "hf"

    seeded = seed_bundled_models(bundled_dir=bundled, hf_cache=hf_cache)

    assert seeded == ["models--onnx-community--whisper-tiny"]
    repo = hf_cache / "models--onnx-community--whisper-tiny"
    copied = repo / "snapshots" / "deadbeef" / "encoder_model_q4.onnx"
    assert copied.read_bytes() == b"\x00onnx"
    assert (repo / "refs" / "main").read_text(encoding="utf-8") == "deadbeef"


def test_idempotent_and_never_clobbers_existing(tmp_path: Path) -> None:
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    _fake_repo(bundled)
    hf_cache = tmp_path / "hf"

    assert seed_bundled_models(bundled_dir=bundled, hf_cache=hf_cache) == ["models--onnx-community--whisper-tiny"]

    # User now holds a newer revision; a second seed must not overwrite it.
    user_file = hf_cache / "models--onnx-community--whisper-tiny" / "snapshots" / "deadbeef" / "encoder_model_q4.onnx"
    user_file.write_bytes(b"USER-NEWER")

    assert seed_bundled_models(bundled_dir=bundled, hf_cache=hf_cache) == []
    assert user_file.read_bytes() == b"USER-NEWER"


def test_noop_when_nothing_bundled(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist"
    hf_cache = tmp_path / "hf"

    assert seed_bundled_models(bundled_dir=missing, hf_cache=hf_cache) == []
    assert not hf_cache.exists()


def test_ignores_non_repo_dirs(tmp_path: Path) -> None:
    bundled = tmp_path / "bundled"
    (bundled / "not-a-model").mkdir(parents=True)
    (bundled / "not-a-model" / "junk.txt").write_text("x", encoding="utf-8")
    _fake_repo(bundled)
    hf_cache = tmp_path / "hf"

    seeded = seed_bundled_models(bundled_dir=bundled, hf_cache=hf_cache)

    assert seeded == ["models--onnx-community--whisper-tiny"]
    assert not (hf_cache / "not-a-model").exists()
