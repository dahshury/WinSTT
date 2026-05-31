"""Tests for the portable-aware ``--data-dir`` handling in ``stt_server.cli``.

The Electron frontend passes ``--data-dir <path>`` whenever a ``portable``
marker file is found next to the executable. The Python server must:

* Resolve ``server-settings.json`` (the persisted model-pick file) under
  that path instead of ``~/.winstt`` so a portable install stays
  self-contained.
* Honor ``WINSTT_DATA_DIR`` as a fallback for raw ``stt-server`` launches
  where the flag may be missing.
* Keep the historic ``~/.winstt`` location when neither is set so
  non-portable installs are completely unaffected.

The CLI parser excludes itself from the coverage gate (it's in
``src/stt_server/*`` which is omitted) so these tests are signal-only,
not coverage-driven.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from pathlib import Path

import pytest

from src.stt_server import cli


@pytest.fixture(autouse=True)
def _restore_env() -> Iterator[None]:
    """Snapshot+restore ``WINSTT_DATA_DIR`` so each test starts clean."""
    saved = os.environ.get("WINSTT_DATA_DIR")
    try:
        yield
    finally:
        if saved is None:
            os.environ.pop("WINSTT_DATA_DIR", None)
        else:
            os.environ["WINSTT_DATA_DIR"] = saved


# ─── _resolve_data_dir ───────────────────────────────────────────────


def test_resolve_data_dir_returns_none_when_neither_flag_nor_env(tmp_path: Path) -> None:
    os.environ.pop("WINSTT_DATA_DIR", None)
    assert cli._resolve_data_dir([]) is None


def test_resolve_data_dir_picks_up_long_flag_with_space(tmp_path: Path) -> None:
    os.environ.pop("WINSTT_DATA_DIR", None)
    result = cli._resolve_data_dir(["--data-dir", str(tmp_path)])
    assert result == tmp_path


def test_resolve_data_dir_picks_up_underscore_alias(tmp_path: Path) -> None:
    os.environ.pop("WINSTT_DATA_DIR", None)
    result = cli._resolve_data_dir(["--data_dir", str(tmp_path)])
    assert result == tmp_path


def test_resolve_data_dir_picks_up_equals_syntax(tmp_path: Path) -> None:
    os.environ.pop("WINSTT_DATA_DIR", None)
    result = cli._resolve_data_dir([f"--data-dir={tmp_path}"])
    assert result == tmp_path


def test_resolve_data_dir_picks_up_underscore_equals_syntax(tmp_path: Path) -> None:
    os.environ.pop("WINSTT_DATA_DIR", None)
    result = cli._resolve_data_dir([f"--data_dir={tmp_path}"])
    assert result == tmp_path


def test_resolve_data_dir_falls_back_to_env_when_flag_missing(tmp_path: Path) -> None:
    os.environ["WINSTT_DATA_DIR"] = str(tmp_path)
    assert cli._resolve_data_dir([]) == tmp_path


def test_resolve_data_dir_cli_flag_wins_over_env(tmp_path: Path) -> None:
    other = tmp_path / "via-env"
    other.mkdir()
    os.environ["WINSTT_DATA_DIR"] = str(other)
    result = cli._resolve_data_dir(["--data-dir", str(tmp_path)])
    assert result == tmp_path


def test_resolve_data_dir_ignores_trailing_flag_without_value(tmp_path: Path) -> None:
    # ``--data-dir`` at the very end with no argument should be ignored
    # rather than crashing the parser. argparse would catch this for the
    # main parser, but our pre-parser is permissive on purpose so the
    # main parse can produce a clean help line.
    os.environ.pop("WINSTT_DATA_DIR", None)
    assert cli._resolve_data_dir(["--data-dir"]) is None


# ─── persistence: load + persist round-trip ─────────────────────────


def test_persist_setting_writes_under_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """``persist_setting`` should write into the portable data dir, not ``~/.winstt``."""
    os.environ["WINSTT_DATA_DIR"] = str(tmp_path)
    cli.persist_setting("model", "tiny")
    expected = tmp_path / "server-settings.json"
    assert expected.exists()
    payload = json.loads(expected.read_text(encoding="utf-8"))
    assert payload == {"model": "tiny"}


def test_load_persisted_settings_reads_from_data_dir(tmp_path: Path) -> None:
    os.environ["WINSTT_DATA_DIR"] = str(tmp_path)
    settings_file = tmp_path / "server-settings.json"
    settings_file.write_text(json.dumps({"model": "small"}), encoding="utf-8")
    loaded = cli.load_persisted_settings()
    assert loaded == {"model": "small"}


def test_load_persisted_settings_returns_empty_when_data_dir_missing_file(
    tmp_path: Path,
) -> None:
    os.environ["WINSTT_DATA_DIR"] = str(tmp_path)
    # tmp_path exists but no settings file inside it.
    assert cli.load_persisted_settings() == {}


def test_persist_setting_round_trips_through_load(tmp_path: Path) -> None:
    os.environ["WINSTT_DATA_DIR"] = str(tmp_path)
    cli.persist_setting("model", "large-v3-turbo")
    assert cli.load_persisted_settings() == {"model": "large-v3-turbo"}


def test_persist_setting_ignores_unknown_keys(tmp_path: Path) -> None:
    os.environ["WINSTT_DATA_DIR"] = str(tmp_path)
    cli.persist_setting("not-a-real-key", "value")
    # ``unknown-key`` is filtered out by PERSISTED_PARAMETERS; nothing
    # should land on disk.
    assert not (tmp_path / "server-settings.json").exists()


def test_get_settings_file_honors_data_dir(tmp_path: Path) -> None:
    os.environ["WINSTT_DATA_DIR"] = str(tmp_path)
    assert cli.get_settings_file() == tmp_path / "server-settings.json"


def test_get_settings_file_defaults_to_home_winstt_when_no_data_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No portable data dir → historic ``~/.winstt`` is used."""
    os.environ.pop("WINSTT_DATA_DIR", None)
    monkeypatch.setattr(Path, "home", classmethod(lambda _cls: tmp_path))
    # Reset sys.argv so the resolver doesn't pick a stale flag from pytest.
    monkeypatch.setattr("sys.argv", ["stt-server"])
    expected = tmp_path / ".winstt" / "server-settings.json"
    assert cli.get_settings_file() == expected


# ─── parser integration ─────────────────────────────────────────────


def test_parser_accepts_data_dir_flag(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("sys.argv", ["stt-server", "--data-dir", str(tmp_path)])
    args = cli.parse_arguments()
    assert args.data_dir == str(tmp_path)


def test_parser_accepts_underscore_data_dir_alias(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("sys.argv", ["stt-server", "--data_dir", str(tmp_path)])
    args = cli.parse_arguments()
    assert args.data_dir == str(tmp_path)


def test_parser_default_data_dir_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("sys.argv", ["stt-server"])
    args = cli.parse_arguments()
    assert args.data_dir is None
