"""The streaming downloader must resume a huggingface_hub ``.incomplete`` partial.

A download that started via the swap path (or any ``snapshot_download``) leaves
``<blob>.incomplete``; the streaming primitive resumes from ``<blob>.partial``.
Without bridging the two, resuming such a download restarts the file from
scratch — the "cohere resumed from 0% despite ~70% on disk" report.
"""

from __future__ import annotations

from pathlib import Path

from src.recorder.infrastructure.streaming_downloader import _adopt_hf_incomplete


def test_hf_incomplete_is_adopted_as_partial(tmp_path: Path) -> None:
    blob = tmp_path / "deadbeef"
    incomplete = tmp_path / "deadbeef.incomplete"
    incomplete.write_bytes(b"partial-bytes")

    _adopt_hf_incomplete(blob)

    partial = tmp_path / "deadbeef.partial"
    assert partial.exists(), "HF .incomplete should be renamed to the streaming .partial"
    assert partial.read_bytes() == b"partial-bytes"
    assert not incomplete.exists()


def test_existing_partial_is_not_clobbered(tmp_path: Path) -> None:
    blob = tmp_path / "deadbeef"
    (tmp_path / "deadbeef.incomplete").write_bytes(b"hf-bytes")
    (tmp_path / "deadbeef.partial").write_bytes(b"streaming-bytes")

    _adopt_hf_incomplete(blob)

    # Our own in-progress .partial wins; the HF copy is left untouched.
    assert (tmp_path / "deadbeef.partial").read_bytes() == b"streaming-bytes"
    assert (tmp_path / "deadbeef.incomplete").exists()


def test_noop_when_nothing_to_adopt(tmp_path: Path) -> None:
    blob = tmp_path / "deadbeef"
    _adopt_hf_incomplete(blob)  # must not raise
    assert not (tmp_path / "deadbeef.partial").exists()
