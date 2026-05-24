"""Property-based tests for :mod:`src.recorder.domain.catalog_overlay`."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from src.recorder.domain import catalog_overlay


@pytest.fixture()
def isolated_overlay(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    overlay_path = tmp_path / "catalog-overlay.json"
    monkeypatch.setattr(catalog_overlay, "OVERLAY_DIR", tmp_path)
    monkeypatch.setattr(catalog_overlay, "OVERLAY_PATH", overlay_path)
    return overlay_path


# JSON-safe scalar field values for an overlay's inner dicts.
_FIELD_VALUE = st.one_of(
    st.text(max_size=40),
    st.integers(min_value=-(10**6), max_value=10**6),
    st.booleans(),
    st.none(),
    st.lists(st.text(max_size=20), max_size=5),
)

# Inner dict: str -> json-safe value.
_INNER_DICT = st.dictionaries(st.text(min_size=1, max_size=20), _FIELD_VALUE, max_size=5)

# Valid overlay payload: dict[str, dict[str, Any]].
_OVERLAY = st.dictionaries(st.text(min_size=1, max_size=30), _INNER_DICT, max_size=5)


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(_OVERLAY)
def test_save_load_round_trips(isolated_overlay: Path, overlay: dict[str, dict[str, Any]]) -> None:
    # Clean slate per example.
    if isolated_overlay.exists():
        isolated_overlay.unlink()
    assert catalog_overlay.save_overlay(overlay) is True
    loaded = catalog_overlay.load_overlay()
    assert loaded == overlay


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(st.text(max_size=200))
def test_load_corrupt_file_returns_empty_dict(isolated_overlay: Path, junk: str) -> None:
    isolated_overlay.parent.mkdir(parents=True, exist_ok=True)
    # Write arbitrary text — most inputs are not valid JSON, but the
    # function must never raise regardless.
    isolated_overlay.write_text(junk, encoding="utf-8")
    result = catalog_overlay.load_overlay()
    assert isinstance(result, dict)
    if not _is_valid_overlay_text(junk):
        assert result == {}


def _is_valid_overlay_text(text: str) -> bool:
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return False
    return isinstance(parsed, dict)


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(st.integers() | st.text(max_size=30) | st.lists(st.integers(), max_size=5))
def test_load_non_dict_root_returns_empty(isolated_overlay: Path, payload: object) -> None:
    isolated_overlay.parent.mkdir(parents=True, exist_ok=True)
    isolated_overlay.write_text(json.dumps(payload), encoding="utf-8")
    assert catalog_overlay.load_overlay() == {}


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(st.dictionaries(st.text(max_size=20), st.text(max_size=20) | st.integers(), max_size=5))
def test_coercion_drops_non_dict_field_values(
    isolated_overlay: Path, mixed: dict[str, str | int]
) -> None:
    # Every value here is NOT a dict; the coercion must drop all of them
    # since only ``(str, dict)`` pairs survive ``_str_dict_pairs``.
    isolated_overlay.parent.mkdir(parents=True, exist_ok=True)
    isolated_overlay.write_text(json.dumps(mixed), encoding="utf-8")
    result = catalog_overlay.load_overlay()
    assert result == {}


def test_load_overlay_missing_file_returns_empty(isolated_overlay: Path) -> None:
    # Sanity: with the file absent, load_overlay returns {} without raising.
    assert not isolated_overlay.exists()
    assert catalog_overlay.load_overlay() == {}
