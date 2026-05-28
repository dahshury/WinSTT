from __future__ import annotations

from collections.abc import Iterator
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest

from src.recorder.domain import catalog_refresh
from src.recorder.domain.model_registry import ModelInfo, TranscriberBackend

if TYPE_CHECKING:
    from collections.abc import Mapping


def _info(model_id: str, *, family: str, onnx: str | None) -> ModelInfo:
    return ModelInfo(
        id=model_id,
        display_name=model_id,
        backend=TranscriberBackend.ONNX_ASR,
        family=family,
        onnx_model_name=onnx,
    )


@pytest.fixture()
def fake_hf(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    """Stub huggingface_hub so tests are offline-deterministic.

    Yields a mutable dict mapping ``repo_id -> card_data.language`` so the
    test body can program the API surface for that specific case.
    """
    card_languages: dict[str, Any] = {}

    class FakeApi:
        def model_info(self, repo_id: str) -> SimpleNamespace:
            if repo_id not in card_languages:
                raise RuntimeError(f"no fixture for {repo_id}")
            data = card_languages[repo_id]
            return SimpleNamespace(card_data=SimpleNamespace(language=data))

    fake_hub = MagicMock()
    fake_hub.HfApi = FakeApi
    monkeypatch.setitem(__import__("sys").modules, "huggingface_hub", fake_hub)
    yield card_languages


@pytest.fixture()
def fake_resolver(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, str]]:
    """Stub onnx_asr.resolver.model_repos so short aliases resolve to repos."""
    repos: dict[str, str] = {}
    fake_resolver_mod = MagicMock()
    fake_resolver_mod.model_repos = repos
    fake_pkg = MagicMock()
    fake_pkg.resolver = fake_resolver_mod
    monkeypatch.setitem(__import__("sys").modules, "onnx_asr.resolver", fake_resolver_mod)
    monkeypatch.setitem(__import__("sys").modules, "onnx_asr", fake_pkg)
    yield repos


class TestLanguageFetcher:
    def test_fetch_card_languages_string_normalizes_to_list(self, fake_hf: dict[str, Any]) -> None:
        fake_hf["nvidia/canary-1b-v2"] = "en"
        assert catalog_refresh._fetch_card_languages("nvidia/canary-1b-v2") == ["en"]

    def test_fetch_card_languages_list_returns_strings_only(self, fake_hf: dict[str, Any]) -> None:
        fake_hf["foo/bar"] = ["en", "de", 42, None]
        assert catalog_refresh._fetch_card_languages("foo/bar") == ["en", "de"]

    def test_fetch_card_languages_none_yields_none(self, fake_hf: dict[str, Any]) -> None:
        fake_hf["foo/bar"] = None
        assert catalog_refresh._fetch_card_languages("foo/bar") is None

    def test_fetch_card_languages_swallows_network_errors(self, fake_hf: Mapping[str, Any]) -> None:
        # No fixture programmed => FakeApi raises RuntimeError.
        assert catalog_refresh._fetch_card_languages("nonexistent/repo") is None

    def test_fetch_card_languages_missing_card_data(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Some HF responses (or old uploads) carry no card_data at all.
        class NoCardApi:
            def model_info(self, _repo_id: str) -> SimpleNamespace:
                return SimpleNamespace(card_data=None)

        fake_hub = MagicMock()
        fake_hub.HfApi = NoCardApi
        monkeypatch.setitem(__import__("sys").modules, "huggingface_hub", fake_hub)
        assert catalog_refresh._fetch_card_languages("foo/bar") is None

    def test_fetch_card_languages_unexpected_type_returns_none(self, fake_hf: dict[str, Any]) -> None:
        # Defensive: ``card_data.language`` could in principle be a dict or
        # int from a malformed upload. Don't treat that as a whitelist.
        fake_hf["foo/bar"] = {"unexpected": "dict"}
        assert catalog_refresh._fetch_card_languages("foo/bar") is None


class TestResolveHfRepo:
    def test_slashed_name_passes_through(self) -> None:
        assert catalog_refresh._resolve_hf_repo("nvidia/canary-1b-v2") == "nvidia/canary-1b-v2"

    def test_short_alias_resolves_via_onnx_asr(self, fake_resolver: dict[str, str]) -> None:
        fake_resolver["nemo-canary-1b-v2"] = "istupakov/canary-1b-v2-onnx"
        assert catalog_refresh._resolve_hf_repo("nemo-canary-1b-v2") == "istupakov/canary-1b-v2-onnx"

    def test_unknown_short_alias_returns_none(self, fake_resolver: dict[str, str]) -> None:
        assert catalog_refresh._resolve_hf_repo("unknown-alias") is None

    def test_empty_name_returns_none(self) -> None:
        assert catalog_refresh._resolve_hf_repo(None) is None
        assert catalog_refresh._resolve_hf_repo("") is None


class TestEnglishOnlyDetection:
    def test_en_suffix_in_id_is_english_only(self) -> None:
        info = _info("tiny.en", family="whisper", onnx="onnx-community/whisper-tiny.en")
        assert catalog_refresh._is_english_only_whisper(info) is True

    def test_multilingual_whisper_is_not_english_only(self) -> None:
        info = _info("tiny", family="whisper", onnx="onnx-community/whisper-tiny")
        assert catalog_refresh._is_english_only_whisper(info) is False

    def test_non_whisper_family_never_english_only(self) -> None:
        # Even with .en suffix, only whisper-family is treated as English-only.
        info = _info("foo.en", family="nemo", onnx="org/repo")
        assert catalog_refresh._is_english_only_whisper(info) is False


class TestLanguagesFor:
    def test_english_whisper_pinned_to_en(self, fake_hf: Mapping[str, Any], fake_resolver: Mapping[str, str]) -> None:
        info = _info("tiny.en", family="whisper", onnx="onnx-community/whisper-tiny.en")
        assert catalog_refresh._languages_for(info) == ["en"]

    def test_whisper_routes_through_openai_reference(self, fake_hf: dict[str, Any]) -> None:
        fake_hf["openai/whisper-tiny"] = ["en", "ar", "zh"]
        info = _info("tiny", family="whisper", onnx="onnx-community/whisper-tiny")
        assert catalog_refresh._languages_for(info) == ["en", "ar", "zh"]

    def test_lite_whisper_also_uses_openai_reference(self, fake_hf: dict[str, Any]) -> None:
        fake_hf["openai/whisper-tiny"] = ["en", "fr"]
        info = _info(
            "lite-whisper-large-v3-turbo",
            family="lite-whisper",
            onnx="onnx-community/lite-whisper-large-v3-turbo-ONNX",
        )
        assert catalog_refresh._languages_for(info) == ["en", "fr"]

    def test_nemo_canary_uses_resolved_repo(self, fake_hf: dict[str, Any], fake_resolver: dict[str, str]) -> None:
        fake_resolver["nemo-canary-1b-v2"] = "istupakov/canary-1b-v2-onnx"
        fake_hf["istupakov/canary-1b-v2-onnx"] = ["bg", "cs", "en", "de"]
        info = _info("nemo-canary-1b-v2", family="nemo", onnx="nemo-canary-1b-v2")
        assert catalog_refresh._languages_for(info) == ["bg", "cs", "en", "de"]

    def test_unknown_alias_returns_none(self, fake_hf: Mapping[str, Any], fake_resolver: Mapping[str, str]) -> None:
        info = _info("mystery-model", family="nemo", onnx="mystery-model")
        assert catalog_refresh._languages_for(info) is None


class TestFetchLanguageOverlay:
    def test_only_models_with_languages_appear(self, fake_hf: dict[str, Any], fake_resolver: dict[str, str]) -> None:
        # Programmed: canary returns a list; whisper falls back to openai
        # which we DON'T program — so whisper is skipped (None).
        fake_resolver["nemo-canary-1b-v2"] = "istupakov/canary-1b-v2-onnx"
        fake_hf["istupakov/canary-1b-v2-onnx"] = ["en", "de"]
        models = [
            _info("nemo-canary-1b-v2", family="nemo", onnx="nemo-canary-1b-v2"),
            _info("tiny", family="whisper", onnx="onnx-community/whisper-tiny"),
        ]
        overlay = catalog_refresh.fetch_language_overlay(models)
        assert overlay == {"nemo-canary-1b-v2": {"languages": ["de", "en"]}}

    def test_languages_deduplicated_and_sorted(self, fake_hf: dict[str, Any], fake_resolver: dict[str, str]) -> None:
        fake_resolver["model"] = "org/model"
        fake_hf["org/model"] = ["zh", "en", "en", "ar"]
        models = [_info("model", family="nemo", onnx="model")]
        overlay = catalog_refresh.fetch_language_overlay(models)
        assert overlay == {"model": {"languages": ["ar", "en", "zh"]}}

    def test_empty_input_yields_empty_overlay(self) -> None:
        assert catalog_refresh.fetch_language_overlay([]) == {}

    def test_shared_reference_repo_fetched_once(
        self, monkeypatch: pytest.MonkeyPatch, fake_resolver: dict[str, str]
    ) -> None:
        # Every Whisper variant routes through openai/whisper-tiny. The
        # overlay build must hit HF once for that repo, not once per entry.
        calls: list[str] = []

        class CountingApi:
            def model_info(self, repo_id: str) -> SimpleNamespace:
                calls.append(repo_id)
                return SimpleNamespace(card_data=SimpleNamespace(language=["en", "ar"]))

        fake_hub = MagicMock()
        fake_hub.HfApi = CountingApi
        monkeypatch.setitem(__import__("sys").modules, "huggingface_hub", fake_hub)
        models = [
            _info("tiny", family="whisper", onnx="onnx-community/whisper-tiny"),
            _info("base", family="whisper", onnx="onnx-community/whisper-base"),
            _info("small", family="whisper", onnx="onnx-community/whisper-small"),
        ]
        overlay = catalog_refresh.fetch_language_overlay(models)
        assert calls == ["openai/whisper-tiny"]
        assert overlay == {
            "tiny": {"languages": ["ar", "en"]},
            "base": {"languages": ["ar", "en"]},
            "small": {"languages": ["ar", "en"]},
        }
