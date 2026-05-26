"""Tests for the custom-model filesystem scanner.

The scanner is infrastructure (live filesystem I/O), so it's excluded from
the coverage gate, but we still verify the contract end-to-end via
``tmp_path`` so the picker's "broken model → tooltip" UX has a backing
test. Each test builds the minimal HF-style folder layout the contract
demands, then assertions confirm scanner behavior matches what the
:class:`ModelCatalog` consumer expects.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.recorder.infrastructure.custom_model_scanner import scan_custom_models


def _write(path: Path, content: str = "x") -> None:
    """Create ``path`` (with parents) and write a one-byte placeholder.

    Scanner contract only checks file existence — never reads the ONNX
    bytes — so a stub byte is enough to satisfy the encoder / decoder /
    tokenizer presence checks.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _write_valid_bundle(folder: Path, *, name_or_path: str | None = None, model_type: str = "whisper") -> None:
    """Write the minimal valid HF-style ONNX bundle into ``folder``."""
    _write(folder / "encoder_model.onnx")
    _write(folder / "decoder_model.onnx")
    _write(folder / "tokenizer.json", json.dumps({"version": "1.0"}))
    config: dict[str, object] = {"model_type": model_type}
    if name_or_path is not None:
        config["_name_or_path"] = name_or_path
    _write(folder / "config.json", json.dumps(config))


class TestScannerHappyPath:
    def test_valid_bundle_yields_one_valid_entry(self, tmp_path: Path) -> None:
        _write_valid_bundle(tmp_path / "my-model", name_or_path="openai/whisper-tiny")
        entries = scan_custom_models(tmp_path)
        assert len(entries) == 1
        entry = entries[0]
        assert entry.slug == "my-model"
        assert entry.valid is True
        assert entry.error_message == ""
        # ``_name_or_path`` provides the display name; the trailing segment
        # after the slash is used so "openai/whisper-tiny" → "whisper-tiny".
        assert entry.display_name == "whisper-tiny"
        assert entry.config["model_type"] == "whisper"
        assert "Custom model in" in entry.description

    def test_humanized_slug_when_no_name_or_path(self, tmp_path: Path) -> None:
        _write_valid_bundle(tmp_path / "acme_voice-model")
        entries = scan_custom_models(tmp_path)
        # Hyphens AND underscores collapse to spaces → title-case.
        assert entries[0].display_name == "Acme Voice Model"

    def test_accepts_encoder_alias(self, tmp_path: Path) -> None:
        """``encoder.onnx`` is the alternative filename for the encoder weights."""
        folder = tmp_path / "alt"
        _write(folder / "encoder.onnx")  # not encoder_model.onnx
        _write(folder / "decoder_model.onnx")
        _write(folder / "tokenizer.json")
        _write(folder / "config.json", json.dumps({"model_type": "whisper"}))
        entries = scan_custom_models(tmp_path)
        assert len(entries) == 1
        assert entries[0].valid is True

    def test_accepts_decoder_merged_alias(self, tmp_path: Path) -> None:
        """``decoder_model_merged.onnx`` is the alternative decoder filename."""
        folder = tmp_path / "merged"
        _write(folder / "encoder_model.onnx")
        _write(folder / "decoder_model_merged.onnx")
        _write(folder / "tokenizer.json")
        _write(folder / "config.json", json.dumps({"model_type": "whisper"}))
        entries = scan_custom_models(tmp_path)
        assert len(entries) == 1
        assert entries[0].valid is True

    def test_multiple_bundles_sorted_by_slug(self, tmp_path: Path) -> None:
        _write_valid_bundle(tmp_path / "zebra")
        _write_valid_bundle(tmp_path / "alpha")
        _write_valid_bundle(tmp_path / "mango")
        entries = scan_custom_models(tmp_path)
        assert [e.slug for e in entries] == ["alpha", "mango", "zebra"]


class TestScannerBrokenBundles:
    def test_missing_encoder_marks_invalid(self, tmp_path: Path) -> None:
        folder = tmp_path / "no-encoder"
        _write(folder / "decoder_model.onnx")
        _write(folder / "tokenizer.json")
        _write(folder / "config.json", json.dumps({"model_type": "whisper"}))
        entries = scan_custom_models(tmp_path)
        assert len(entries) == 1
        assert entries[0].valid is False
        assert "encoder.onnx" in entries[0].error_message

    def test_missing_decoder_marks_invalid(self, tmp_path: Path) -> None:
        folder = tmp_path / "no-decoder"
        _write(folder / "encoder_model.onnx")
        _write(folder / "tokenizer.json")
        _write(folder / "config.json", json.dumps({"model_type": "whisper"}))
        entries = scan_custom_models(tmp_path)
        assert entries[0].valid is False
        assert "decoder_model.onnx" in entries[0].error_message

    def test_missing_tokenizer_marks_invalid(self, tmp_path: Path) -> None:
        folder = tmp_path / "no-tok"
        _write(folder / "encoder_model.onnx")
        _write(folder / "decoder_model.onnx")
        _write(folder / "config.json", json.dumps({"model_type": "whisper"}))
        entries = scan_custom_models(tmp_path)
        assert entries[0].valid is False
        assert "tokenizer.json" in entries[0].error_message

    def test_missing_config_marks_invalid(self, tmp_path: Path) -> None:
        folder = tmp_path / "no-cfg"
        _write(folder / "encoder_model.onnx")
        _write(folder / "decoder_model.onnx")
        _write(folder / "tokenizer.json")
        entries = scan_custom_models(tmp_path)
        assert entries[0].valid is False
        assert "config.json" in entries[0].error_message

    def test_malformed_config_marks_invalid(self, tmp_path: Path) -> None:
        folder = tmp_path / "bad-cfg"
        _write(folder / "encoder_model.onnx")
        _write(folder / "decoder_model.onnx")
        _write(folder / "tokenizer.json")
        _write(folder / "config.json", "{not valid json")
        entries = scan_custom_models(tmp_path)
        assert entries[0].valid is False
        assert "malformed config.json" in entries[0].error_message

    def test_config_not_an_object_marks_invalid(self, tmp_path: Path) -> None:
        folder = tmp_path / "list-cfg"
        _write(folder / "encoder_model.onnx")
        _write(folder / "decoder_model.onnx")
        _write(folder / "tokenizer.json")
        _write(folder / "config.json", json.dumps(["not", "an", "object"]))
        entries = scan_custom_models(tmp_path)
        assert entries[0].valid is False
        assert "object" in entries[0].error_message

    def test_config_missing_model_type_marks_invalid(self, tmp_path: Path) -> None:
        folder = tmp_path / "no-mtype"
        _write(folder / "encoder_model.onnx")
        _write(folder / "decoder_model.onnx")
        _write(folder / "tokenizer.json")
        _write(folder / "config.json", json.dumps({"_name_or_path": "openai/whisper"}))
        entries = scan_custom_models(tmp_path)
        assert entries[0].valid is False
        assert "model_type" in entries[0].error_message

    def test_broken_entries_keep_their_slug_and_path(self, tmp_path: Path) -> None:
        folder = tmp_path / "missing-stuff"
        _write(folder / "config.json", json.dumps({"model_type": "whisper"}))
        entries = scan_custom_models(tmp_path)
        assert entries[0].slug == "missing-stuff"
        assert entries[0].path == folder
        assert entries[0].valid is False


class TestScannerEdgeCases:
    def test_none_path_yields_empty(self) -> None:
        assert scan_custom_models(None) == []

    def test_missing_directory_yields_empty(self, tmp_path: Path) -> None:
        assert scan_custom_models(tmp_path / "does-not-exist") == []

    def test_file_instead_of_dir_yields_empty(self, tmp_path: Path) -> None:
        target = tmp_path / "not-a-dir"
        target.write_text("hi", encoding="utf-8")
        assert scan_custom_models(target) == []

    def test_empty_directory_yields_empty(self, tmp_path: Path) -> None:
        assert scan_custom_models(tmp_path) == []

    def test_skips_files_at_top_level(self, tmp_path: Path) -> None:
        (tmp_path / "README.txt").write_text("ignore me", encoding="utf-8")
        _write_valid_bundle(tmp_path / "real")
        entries = scan_custom_models(tmp_path)
        assert len(entries) == 1
        assert entries[0].slug == "real"

    def test_skips_hidden_directories(self, tmp_path: Path) -> None:
        _write_valid_bundle(tmp_path / ".hidden")  # .DS_Store / partial download style
        _write_valid_bundle(tmp_path / "visible")
        entries = scan_custom_models(tmp_path)
        assert [e.slug for e in entries] == ["visible"]

    def test_accepts_string_path(self, tmp_path: Path) -> None:
        _write_valid_bundle(tmp_path / "x")
        # Same input as ``Path(tmp_path)`` — the scanner accepts both
        # ``str`` and ``Path`` so callers don't have to coerce.
        entries = scan_custom_models(str(tmp_path))
        assert len(entries) == 1


class TestScannerOSErrorHandling:
    def test_listdir_failure_logs_and_returns_empty(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A filesystem error during iteration is logged, not raised."""

        def raising_iterdir(self: Path) -> object:
            raise PermissionError("simulated")

        monkeypatch.setattr(Path, "iterdir", raising_iterdir)
        # No assertion on the log line itself; the contract is "never
        # raises, returns []". A noisy log is incidental.
        assert scan_custom_models(tmp_path) == []
