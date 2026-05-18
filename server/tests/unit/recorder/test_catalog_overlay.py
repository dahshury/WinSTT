from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.recorder.domain import catalog_overlay
from src.recorder.domain.model_registry import ModelCatalog


@pytest.fixture()
def isolated_overlay(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Redirect the overlay path to a tmp file for each test.

    Real ``~/.winstt/catalog-overlay.json`` is the user's data — must not
    leak across tests or modify the host. Touching the module-level
    constants keeps :class:`ModelCatalog` honest because it imports
    :mod:`catalog_overlay` lazily inside ``_load_catalog_entries``.
    """
    monkeypatch.setattr(catalog_overlay, "OVERLAY_DIR", tmp_path)
    monkeypatch.setattr(catalog_overlay, "OVERLAY_PATH", tmp_path / "catalog-overlay.json")
    return tmp_path / "catalog-overlay.json"


class TestOverlayPersistence:
    def test_load_missing_returns_empty(self, isolated_overlay: Path) -> None:
        assert not isolated_overlay.exists()
        assert catalog_overlay.load_overlay() == {}

    def test_save_then_load_round_trips(self, isolated_overlay: Path) -> None:
        payload = {"nemo-canary-1b-v2": {"languages": ["en", "es", "fr"]}}
        assert catalog_overlay.save_overlay(payload) is True
        assert isolated_overlay.exists()
        assert catalog_overlay.load_overlay() == payload

    def test_load_corrupt_json_returns_empty(self, isolated_overlay: Path) -> None:
        isolated_overlay.parent.mkdir(parents=True, exist_ok=True)
        isolated_overlay.write_text("{not valid json", encoding="utf-8")
        assert catalog_overlay.load_overlay() == {}

    def test_load_non_dict_root_returns_empty(self, isolated_overlay: Path) -> None:
        isolated_overlay.parent.mkdir(parents=True, exist_ok=True)
        isolated_overlay.write_text("[1, 2, 3]", encoding="utf-8")
        assert catalog_overlay.load_overlay() == {}

    def test_load_filters_non_string_keys(self, isolated_overlay: Path) -> None:
        isolated_overlay.parent.mkdir(parents=True, exist_ok=True)
        isolated_overlay.write_text(
            json.dumps({"good": {"languages": ["en"]}, "bad-value": "not-a-dict"}),
            encoding="utf-8",
        )
        assert catalog_overlay.load_overlay() == {"good": {"languages": ["en"]}}

    def test_save_overwrites_atomically(self, isolated_overlay: Path) -> None:
        catalog_overlay.save_overlay({"a": {"languages": ["en"]}})
        catalog_overlay.save_overlay({"b": {"languages": ["fr"]}})
        # Second save fully replaces the file — no merged state.
        assert catalog_overlay.load_overlay() == {"b": {"languages": ["fr"]}}


class TestCatalogAppliesOverlay:
    def test_canary_languages_overridden_by_overlay(self, isolated_overlay: Path) -> None:
        # Simulate a refresh that produced a corrected Canary whitelist.
        # ModelCatalog must surface that list, not the bundled one.
        catalog_overlay.save_overlay({"nemo-canary-1b-v2": {"languages": ["de", "en", "fr"]}})
        catalog = ModelCatalog()
        info = catalog.get("nemo-canary-1b-v2")
        assert info is not None
        assert info.languages == ["de", "en", "fr"]

    def test_overlay_for_unknown_model_is_ignored(self, isolated_overlay: Path) -> None:
        catalog_overlay.save_overlay({"some-model-that-doesnt-exist": {"languages": ["xx"]}})
        catalog = ModelCatalog()
        # No crash; existing entries unaffected.
        assert catalog.get("tiny") is not None

    def test_empty_languages_in_overlay_is_ignored(self, isolated_overlay: Path) -> None:
        # An overlay with empty languages would re-introduce the "accepts
        # all" bug; the catalog must skip such overlays and keep the
        # bundled list.
        catalog_overlay.save_overlay({"nemo-canary-1b-v2": {"languages": []}})
        catalog = ModelCatalog()
        info = catalog.get("nemo-canary-1b-v2")
        assert info is not None
        # Bundled list still in effect — Canary's 25 European languages.
        assert "en" in info.languages
        assert "ar" not in info.languages

    def test_overlay_with_non_list_languages_is_ignored(self, isolated_overlay: Path) -> None:
        catalog_overlay.save_overlay({"tiny": {"languages": "en"}})  # type: ignore[dict-item]
        catalog = ModelCatalog()
        info = catalog.get("tiny")
        assert info is not None
        # Falls back to bundled list (~99 languages).
        assert len(info.languages) >= 90
