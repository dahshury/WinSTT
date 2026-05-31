"""Tests for the ``--data-dir`` runtime application in ``stt_server.server``.

``_apply_data_dir`` is the side-effect entry point invoked at the top of
``main_async``. It must:

* No-op when neither ``--data-dir`` nor ``WINSTT_DATA_DIR`` is set.
* Create the data tree (data root + ``hf/`` subdir) so onnx-asr's lazy
  HF cache writes don't fail with ENOENT.
* Route ``HF_HOME`` / ``HUGGINGFACE_HUB_CACHE`` / ``WINSTT_LOG_DIR``
  under the data dir WITHOUT clobbering pre-existing env values — the
  Electron main process sets them before spawning us and must win.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest

from src.stt_server.server import _apply_data_dir

_TRACKED_ENV_VARS = ("WINSTT_DATA_DIR", "HF_HOME", "HUGGINGFACE_HUB_CACHE", "WINSTT_LOG_DIR")


@pytest.fixture(autouse=True)
def _isolate_env() -> Iterator[None]:
    """Snapshot+restore every env var ``_apply_data_dir`` mutates."""
    snapshot = {name: os.environ.get(name) for name in _TRACKED_ENV_VARS}
    for name in _TRACKED_ENV_VARS:
        os.environ.pop(name, None)
    try:
        yield
    finally:
        for name, value in snapshot.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def test_no_data_dir_means_no_env_mutation() -> None:
    result = _apply_data_dir(None)
    assert result is None
    for name in _TRACKED_ENV_VARS:
        assert os.environ.get(name) is None, f"{name} should remain unset"


def test_cli_flag_creates_tree_and_sets_env(tmp_path: Path) -> None:
    target = tmp_path / "WinSTT-Portable" / "Data"
    assert not target.exists(), "Pre-condition: tree should be missing"

    result = _apply_data_dir(str(target))
    assert result == target
    assert target.exists()
    assert (target / "hf").exists(), "HF cache subdir should be created"

    assert os.environ["WINSTT_DATA_DIR"] == str(target)
    assert os.environ["HF_HOME"] == str(target / "hf")
    assert os.environ["HUGGINGFACE_HUB_CACHE"] == str(target / "hf" / "hub")
    assert os.environ["WINSTT_LOG_DIR"] == str(target / "logs")


def test_env_var_fallback_when_cli_flag_missing(tmp_path: Path) -> None:
    target = tmp_path / "via-env"
    os.environ["WINSTT_DATA_DIR"] = str(target)
    result = _apply_data_dir(None)
    assert result == target
    assert target.exists()


def test_existing_env_values_are_preserved(tmp_path: Path) -> None:
    """Electron-supplied env vars must NOT be clobbered by the CLI fallback."""
    target = tmp_path / "cli-target"
    sticky_hf = tmp_path / "electron-hf"
    sticky_log = tmp_path / "electron-log"
    os.environ["HF_HOME"] = str(sticky_hf)
    os.environ["WINSTT_LOG_DIR"] = str(sticky_log)

    _apply_data_dir(str(target))

    # WINSTT_DATA_DIR + HUGGINGFACE_HUB_CACHE were not pre-set, so they
    # follow the CLI flag's data dir.
    assert os.environ["WINSTT_DATA_DIR"] == str(target)
    assert os.environ["HUGGINGFACE_HUB_CACHE"] == str(target / "hf" / "hub")
    # HF_HOME + WINSTT_LOG_DIR were pre-set by the (simulated) Electron
    # parent process — they must survive the CLI fallback's setdefault.
    assert os.environ["HF_HOME"] == str(sticky_hf)
    assert os.environ["WINSTT_LOG_DIR"] == str(sticky_log)


def test_cli_flag_expands_user(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    # `Path.home()` on Windows reads USERPROFILE — patch both to cover.
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    result = _apply_data_dir("~/winstt-portable")
    assert result == (tmp_path / "winstt-portable").expanduser()
    assert os.environ["WINSTT_DATA_DIR"] == str(result)
