from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.recorder.domain.custom_models import CustomModelEntry
from src.recorder.domain.model_registry import (
    CUSTOM_MODEL_FAMILY,
    ModelCatalog,
    ModelInfo,
    TranscriberBackend,
    get_custom_models_dir,
    set_custom_models_dir,
)

WHISPER_IDS = [
    "tiny",
    "tiny.en",
    "base",
    "base.en",
    "small",
    "small.en",
    "medium",
    "medium.en",
    # large-v1 / large-v2 were dropped from the catalog when the Whisper
    # entries were rerouted through onnx-asr — onnx-community only ships
    # onnx exports of large-v3 / large-v3-turbo.
    "large-v3",
    "large-v3-turbo",
]


@pytest.fixture()
def catalog() -> ModelCatalog:
    return ModelCatalog()


class TestModelCatalog:
    def test_all_whisper_models_present(self, catalog: ModelCatalog) -> None:
        # medium / medium.en / large-v3 are gated on onnx-community and
        # routed to the public Xenova mirror; everything else stays on
        # onnx-community. Either prefix is a valid Whisper ONNX repo.
        valid_prefixes = ("onnx-community/whisper-", "Xenova/whisper-")
        for model_id in WHISPER_IDS:
            info = catalog.get(model_id)
            assert info is not None, f"Missing whisper model: {model_id}"
            # Whisper entries route through onnx-asr after Track B step 1.
            assert info.backend == TranscriberBackend.ONNX_ASR
            assert info.onnx_model_name is not None
            assert info.onnx_model_name.startswith(valid_prefixes), (
                f"{model_id} points at unexpected repo: {info.onnx_model_name}"
            )

    def test_onnx_asr_models_present(self, catalog: ModelCatalog) -> None:
        # Catalog excludes older entries dominated on every axis by a newer
        # sibling: parakeet-tdt-v2 (→ v3), gigaam-v2-{ctc,rnnt} (→ v3), and
        # gigaam-v3-{ctc,rnnt} (→ v3-e2e-{ctc,rnnt} — Sber's end-to-end
        # retraining of the same encoder has strictly better WER on general
        # transcription with identical compute and language coverage).
        onnx_ids = [
            "nemo-parakeet-ctc-0.6b",
            "nemo-parakeet-rnnt-0.6b",
            "nemo-parakeet-tdt-0.6b-v3",
            "nemo-canary-1b-v2",
            "nemo-canary-180m-flash",
            "breeze-asr-25",
            "nemo-fastconformer-ru-ctc",
            "nemo-fastconformer-ru-rnnt",
            "gigaam-v3-e2e-ctc",
            "gigaam-v3-e2e-rnnt",
            "alphacep/vosk-model-ru",
            "alphacep/vosk-model-small-ru",
            "t-tech/t-one",
            "moonshine-tiny",
            "moonshine-base",
            "moonshine-tiny-zh",
            "moonshine-tiny-ja",
            "moonshine-tiny-ko",
            "moonshine-tiny-ar",
            "moonshine-tiny-vi",
            "moonshine-base-zh",
            "moonshine-base-ja",
            "moonshine-base-ko",
            "cohere-transcribe",
            "sense-voice-small",
        ]
        for model_id in onnx_ids:
            info = catalog.get(model_id)
            assert info is not None, f"Missing onnx-asr model: {model_id}"
            assert info.backend == TranscriberBackend.ONNX_ASR

    def test_get_backend_returns_correct_backend(self, catalog: ModelCatalog) -> None:
        # Every catalog entry now routes through onnx-asr post Track B step 1.
        assert catalog.get_backend("tiny") == TranscriberBackend.ONNX_ASR
        assert catalog.get_backend("nemo-parakeet-ctc-0.6b") == TranscriberBackend.ONNX_ASR
        assert catalog.get_backend("gigaam-v3-e2e-ctc") == TranscriberBackend.ONNX_ASR

    def test_get_backend_defaults_to_onnx_asr_for_unknown(self, catalog: ModelCatalog) -> None:
        """Unknown IDs fall through to onnx-asr — the resolver will then either
        treat the ID as a full HF repo path or raise ``ModelNotSupportedError``.
        """
        assert catalog.get_backend("some-unknown-model") == TranscriberBackend.ONNX_ASR

    def test_to_dicts_returns_json_serializable(self, catalog: ModelCatalog) -> None:
        dicts = catalog.to_dicts()
        assert len(dicts) > 0
        serialized = json.dumps(dicts)
        assert isinstance(serialized, str)

    def test_list_all_no_duplicates(self, catalog: ModelCatalog) -> None:
        models = catalog.list_all()
        ids = [m.id for m in models]
        assert len(ids) == len(set(ids)), f"Duplicate model IDs found: {[x for x in ids if ids.count(x) > 1]}"

    def test_get_returns_none_for_unknown(self, catalog: ModelCatalog) -> None:
        assert catalog.get("nonexistent-model-xyz") is None

    def test_whisper_multilingual_has_language_detection(self, catalog: ModelCatalog) -> None:
        info = catalog.get("large-v3")
        assert info is not None
        assert info.supports_language_detection is True
        # languages is the HF-derived whitelist (99 OpenAI Whisper languages
        # after refresh_catalog.py populated it). It must include the major
        # multilingual codes; empty list would mean "unknown / accepts all"
        # which would re-introduce the bug where Canary's UI offered Arabic.
        assert "en" in info.languages
        assert "ar" in info.languages
        assert "zh" in info.languages
        assert len(info.languages) >= 90

    def test_whisper_english_only_no_language_detection(self, catalog: ModelCatalog) -> None:
        info = catalog.get("tiny.en")
        assert info is not None
        assert info.supports_language_detection is False
        assert info.languages == ["en"]

    def test_nemo_canary_supports_language_detection(self, catalog: ModelCatalog) -> None:
        info = catalog.get("nemo-canary-1b-v2")
        assert info is not None
        assert info.supports_language_detection is True
        # 978 M params per NVIDIA's canary-1b-v2 model card (despite the "1B" name).
        assert info.size_label == "978M"
        assert info.param_count == 978_000_000

    def test_gigaam_models_are_russian(self, catalog: ModelCatalog) -> None:
        info = catalog.get("gigaam-v3-e2e-ctc")
        assert info is not None
        assert info.languages == ["ru"]
        assert info.family == "gigaam"

    def test_sense_voice_small_catalog_entry(self, catalog: ModelCatalog) -> None:
        """SenseVoice Small ships int8-only (the same flavour Handy bundles).

        The five published languages (zh / en / ja / ko / yue) all need to
        be present so the picker offers a multilingual chip and the
        language-selector renders Cantonese (``yue``) which only this
        catalog row contributes today.

        Verified structurally — the upstream onnx-asr fork still needs to
        merge the ``SenseVoice`` adapter class before transcribe() actually
        runs; the catalog row + family enum + DML override are the WinSTT-
        side prerequisites and they're independently testable.
        """
        info = catalog.get("sense-voice-small")
        assert info is not None
        assert info.family == "sense_voice"
        assert info.backend == TranscriberBackend.ONNX_ASR
        assert info.languages == ["zh", "en", "ja", "ko", "yue"]
        assert info.supports_language_detection is True
        assert info.supports_realtime is True
        # Handy bundles the int8 graph; the catalog mirrors that as the only
        # supported quantization. Surfacing fp32/fp16 here would tempt users
        # with variants that no upstream export currently ships.
        assert info.available_quantizations == ["int8"]
        assert "yue" in info.languages  # Cantonese — SenseVoice is one of the
        # only catalog rows that supports it.

    def test_all_onnx_models_support_realtime(self, catalog: ModelCatalog) -> None:
        for model in catalog.list_all():
            if model.backend == TranscriberBackend.ONNX_ASR:
                assert model.supports_realtime is True, f"{model.id} should support realtime"

    def test_all_whisper_faster_whisper_support_realtime(self, catalog: ModelCatalog) -> None:
        for model in catalog.list_all():
            if model.backend == TranscriberBackend.FASTER_WHISPER:
                assert model.supports_realtime is True, f"{model.id} should support realtime"

    def test_model_info_is_frozen(self) -> None:
        info = ModelInfo(
            id="test",
            display_name="Test",
            backend=TranscriberBackend.FASTER_WHISPER,
            family="test",
        )
        with pytest.raises(AttributeError):
            info.id = "changed"  # type: ignore[misc]

    def test_to_dicts_structure(self, catalog: ModelCatalog) -> None:
        dicts = catalog.to_dicts()
        for d in dicts:
            assert "id" in d
            assert "display_name" in d
            assert "backend" in d
            assert "family" in d
            assert "languages" in d
            assert "supports_language_detection" in d
            assert "size_label" in d
            assert "supports_realtime" in d
            assert "onnx_model_name" in d
            assert "description" in d
            assert "available_quantizations" in d
            # Additive ``sha256`` field is always present; ``None`` when the
            # catalog entry omits it (the current default for every shipped
            # HuggingFace-hosted model). URL-based downloads supply a
            # lowercase hex digest the Electron-side downloader verifies.
            assert "sha256" in d

    def test_gated_whisper_repos_route_to_xenova_mirror(self, catalog: ModelCatalog) -> None:
        """medium / medium.en / large-v3 are gated on onnx-community (HTTP 401
        for unauthenticated downloads). Route them through the older
        ``Xenova/whisper-*`` mirror, which hosts the same Optimum-style ONNX
        layout publicly. End-to-end verified at fp32 + fp16 on the
        physicsworks fixture — transcription matches the small/large
        families. The public siblings must keep pointing at onnx-community."""
        medium = catalog.get("medium")
        assert medium is not None and medium.onnx_model_name == "Xenova/whisper-medium"
        medium_en = catalog.get("medium.en")
        assert medium_en is not None and medium_en.onnx_model_name == "Xenova/whisper-medium.en"
        large_v3 = catalog.get("large-v3")
        assert large_v3 is not None and large_v3.onnx_model_name == "Xenova/whisper-large-v3"
        for public in ("tiny", "tiny.en", "base", "base.en", "small", "small.en", "large-v3-turbo"):
            info = catalog.get(public)
            assert info is not None
            assert info.onnx_model_name == f"onnx-community/whisper-{public}"

    def test_large_v3_offers_only_fp32_due_to_mirror_layout(self, catalog: ModelCatalog) -> None:
        """``Xenova/whisper-large-v3`` only ships the merged-decoder at fp32
        (plus a generic ``_quantized`` alias); no merged-fp16 / merged-q4 /
        merged-bnb4. Override the catalog quant list to just ``[""]`` for
        that one ID so the picker doesn't offer choices that can't load."""
        info = catalog.get("large-v3")
        assert info is not None
        assert info.available_quantizations == [""]

    def test_whisper_exposes_only_verified_quantizations(self, catalog: ModelCatalog) -> None:
        """Picker hides int8/uint8 (broken QDQ scale on every Whisper repo)
        and q4f16 (file doesn't exist upstream). fp16 stays selectable —
        the patch-on-load + EXTENDED opt level in
        :class:`OnnxAsrTranscriber` handle the export defects on the
        ``.en`` variants. q4/bnb4 load cleanly on tiny/base/small (matches
        fp32 text); kept selectable for users who want tiny-on-disk.

        large-v3 has its own assertion: the Xenova mirror only ships the
        merged-fp32 decoder, so its quant list is overridden to ``[""]``.

        The curated list is enforced via ``_KNOWN_BROKEN_QUANTS["whisper"]``
        in :mod:`scripts.refresh_catalog`; the assertions below check the
        end-to-end output that ships in :file:`catalog.json`.
        """
        for model_id in (
            "tiny",
            "tiny.en",
            "base",
            "base.en",
            "small",
            "small.en",
            "medium",
            "medium.en",
            "large-v3-turbo",
        ):
            info = catalog.get(model_id)
            assert info is not None, f"missing catalog entry: {model_id}"
            assert info.available_quantizations == ["", "fp16", "q4", "bnb4"], (
                f"{model_id} unexpected quant list: {info.available_quantizations}"
            )

    def test_nemo_ships_default_and_int8(self, catalog: ModelCatalog) -> None:
        info = catalog.get("nemo-parakeet-tdt-0.6b-v3")
        assert info is not None
        assert info.available_quantizations == ["", "int8"]

    def test_gigaam_ships_default_and_int8(self, catalog: ModelCatalog) -> None:
        """``istupakov/gigaam-v3-onnx`` ships both ``v3_e2e_ctc.onnx`` and
        ``v3_e2e_ctc.int8.onnx`` (verified via HF API in the catalog refresh
        script). The picker exposes both — the old "default only" entry
        was outdated catalog data, not an intentional curation choice."""
        info = catalog.get("gigaam-v3-e2e-ctc")
        assert info is not None
        assert info.available_quantizations == ["", "int8"]

    def test_lite_whisper_models_present(self, catalog: ModelCatalog) -> None:
        # All three large-v3-turbo flavors are exposed; non-turbo is excluded.
        # The picker groups Lite-Whisper under the "whisper" family for UX
        # (they're Whisper variants the user picks alongside the originals);
        # the broken-quant filter still applies via the onnx_model_name
        # prefix override in scripts/refresh_catalog.py.
        for model_id in (
            "lite-whisper-large-v3-turbo",
            "lite-whisper-large-v3-turbo-acc",
            "lite-whisper-large-v3-turbo-fast",
        ):
            info = catalog.get(model_id)
            assert info is not None, f"Missing lite-whisper model: {model_id}"
            assert info.backend == TranscriberBackend.ONNX_ASR
            assert info.family == "whisper"
            assert info.onnx_model_name == f"onnx-community/{model_id}-ONNX"

    def test_lite_whisper_ships_fp32_and_fp16(self, catalog: ModelCatalog) -> None:
        """onnx-community publishes the full quant matrix on lite-whisper repos,
        but ORT-side most are broken: int8/uint8 fail to load (missing QDQ
        scale), q4/q4f16 fail on the SimplifiedLayerNormFusion bug, q4/bnb4
        produce token-loops (WER ~1.0). fp16 *was* broken too until we added
        the patch+EXTENDED workaround in :class:`OnnxAsrTranscriber`; the
        2026-05-17 bench re-confirmed fp16 transcribes correctly with that
        workaround on all three variants. Only the verified-good pair is
        exposed to the picker."""
        for model_id in (
            "lite-whisper-large-v3-turbo",
            "lite-whisper-large-v3-turbo-acc",
            "lite-whisper-large-v3-turbo-fast",
        ):
            info = catalog.get(model_id)
            assert info is not None
            assert info.available_quantizations == ["", "fp16"]

    def test_lite_whisper_supports_language_detection(self, catalog: ModelCatalog) -> None:
        # Lite-Whisper inherits Whisper's multilingual head — accepts the
        # full 99-language whitelist and runs language detection on
        # empty/auto input. refresh_catalog.py routes the whisper-family
        # languages through openai/whisper-tiny since the onnx-community
        # lite-whisper mirrors don't propagate the card_data.language list.
        info = catalog.get("lite-whisper-large-v3-turbo")
        assert info is not None
        assert info.supports_language_detection is True
        assert "en" in info.languages
        assert "ar" in info.languages
        assert len(info.languages) >= 90

    def test_to_dicts_no_device_keeps_shipped_quant_matrix(self, catalog: ModelCatalog) -> None:
        """Without a device hint, every quant we expose stays visible."""
        whisper = next(d for d in catalog.to_dicts() if d["id"] == "large-v3-turbo")
        assert whisper["available_quantizations"] == ["", "fp16", "q4", "bnb4"]

    def test_to_dicts_cuda_filters_sub_fp16_quants(self, catalog: ModelCatalog) -> None:
        """On CUDA, the picker must not offer q4/bnb4 — they fall back to fp32
        compute via QDQ scatter-gather (slower than just running fp32)."""
        whisper = next(d for d in catalog.to_dicts(device="cuda") if d["id"] == "large-v3-turbo")
        assert whisper["available_quantizations"] == ["", "fp16"]

    def test_to_dicts_cuda_preserves_quant_order(self, catalog: ModelCatalog) -> None:
        """Filter preserves the canonical order — fp32 first, fp16 second."""
        for d in (e for e in catalog.to_dicts(device="cuda") if e["family"] == "whisper"):
            quants = d["available_quantizations"]
            assert isinstance(quants, list)
            assert quants == [q for q in ["", "fp16"] if q in quants]

    def test_to_dicts_cuda_handles_models_with_only_default(self, catalog: ModelCatalog) -> None:
        """Models that only ship fp32 stay loadable on CUDA — the empty-string default survives."""
        giga = next(d for d in catalog.to_dicts(device="cuda") if d["id"] == "gigaam-v3-e2e-ctc")
        assert giga["available_quantizations"] == [""]

    def test_to_dicts_cpu_does_not_filter(self, catalog: ModelCatalog) -> None:
        """``device="cpu"`` is not a filter trigger — CPU EP handles every quant we expose."""
        whisper = next(d for d in catalog.to_dicts(device="cpu") if d["id"] == "large-v3-turbo")
        assert whisper["available_quantizations"] == ["", "fp16", "q4", "bnb4"]

    def test_transcriber_backend_values(self) -> None:
        assert TranscriberBackend.FASTER_WHISPER.value == "faster_whisper"
        assert TranscriberBackend.ONNX_ASR.value == "onnx_asr"

    def test_is_language_compatible_empty_language_always_passes(self, catalog: ModelCatalog) -> None:
        # Empty language = auto-detect; every model accepts that.
        assert catalog.is_language_compatible("tiny.en", "") is True
        assert catalog.is_language_compatible("large-v3", "") is True
        assert catalog.is_language_compatible("gigaam-v3-e2e-ctc", "") is True

    def test_is_language_compatible_unknown_model_passes(self, catalog: ModelCatalog) -> None:
        # Catalog is not exhaustive — onnx-asr accepts raw HF repo paths.
        assert catalog.is_language_compatible("unknown/model-xyz", "en") is True

    def test_is_language_compatible_whisper_accepts_full_99(self, catalog: ModelCatalog) -> None:
        # Whisper multilingual models cover the full OpenAI 99-language set
        # — every code in the language constant is supported.
        for lang in ("en", "es", "fr", "zh", "hi", "ar", "ru"):
            assert catalog.is_language_compatible("large-v3", lang) is True

    def test_is_language_compatible_canary_restricted_to_25_european(self, catalog: ModelCatalog) -> None:
        # Canary 1B v2 supports 25 European languages per its HF model card
        # — Arabic / Chinese / Hindi are NOT in the whitelist even though
        # the model supports language detection (orthogonal capability).
        for lang in ("en", "es", "fr", "ru", "uk", "hr", "mt"):
            assert catalog.is_language_compatible("nemo-canary-1b-v2", lang) is True
        for lang in ("ar", "zh", "hi", "ja", "ko"):
            assert catalog.is_language_compatible("nemo-canary-1b-v2", lang) is False

    def test_is_language_compatible_canary_flash_restricted_to_four(self, catalog: ModelCatalog) -> None:
        # Canary 180M Flash supports only en/de/fr/es per its HF model card.
        # All other European codes that 1B v2 covers (ru, uk, mt, hr, …)
        # must be rejected even though the model has language detection.
        for lang in ("en", "de", "es", "fr"):
            assert catalog.is_language_compatible("nemo-canary-180m-flash", lang) is True
        for lang in ("ru", "uk", "mt", "hr", "ar", "zh", "ja"):
            assert catalog.is_language_compatible("nemo-canary-180m-flash", lang) is False

    def test_is_language_compatible_english_only_rejects_others(self, catalog: ModelCatalog) -> None:
        assert catalog.is_language_compatible("tiny.en", "en") is True
        assert catalog.is_language_compatible("tiny.en", "es") is False
        assert catalog.is_language_compatible("tiny.en", "fr") is False

    def test_is_language_compatible_russian_only_models(self, catalog: ModelCatalog) -> None:
        assert catalog.is_language_compatible("gigaam-v3-e2e-ctc", "ru") is True
        assert catalog.is_language_compatible("gigaam-v3-e2e-ctc", "en") is False
        assert catalog.is_language_compatible("t-tech/t-one", "ru") is True
        assert catalog.is_language_compatible("t-tech/t-one", "en") is False

    def test_accepts_any_language_detection_no_longer_overrides_whitelist(self) -> None:
        # Pre-fix bug: any model with supports_language_detection=True was
        # treated as accepting every language tag. That's how Canary's UI
        # ended up offering Arabic. Now the two fields are orthogonal —
        # detection is just "can auto-detect input language", and the
        # whitelist still binds the supported set.
        info = ModelInfo(
            id="x",
            display_name="X",
            backend=TranscriberBackend.ONNX_ASR,
            family="x",
            languages=["en"],
            supports_language_detection=True,
        )
        assert ModelCatalog._accepts_any_language(info) is False

    def test_accepts_any_language_empty_whitelist(self) -> None:
        info = ModelInfo(
            id="x",
            display_name="X",
            backend=TranscriberBackend.ONNX_ASR,
            family="x",
            languages=[],
            supports_language_detection=False,
        )
        assert ModelCatalog._accepts_any_language(info) is True

    def test_accepts_any_language_constrained_whitelist(self) -> None:
        info = ModelInfo(
            id="x",
            display_name="X",
            backend=TranscriberBackend.ONNX_ASR,
            family="x",
            languages=["ru"],
            supports_language_detection=False,
        )
        assert ModelCatalog._accepts_any_language(info) is False

    def test_is_universal_empty_language(self, catalog: ModelCatalog) -> None:
        assert catalog._is_universal("gigaam-v3-e2e-ctc", "") is True

    def test_is_universal_unknown_model(self, catalog: ModelCatalog) -> None:
        assert catalog._is_universal("unknown/model-xyz", "en") is True

    def test_is_universal_whisper_whitelists_explicit_languages(self, catalog: ModelCatalog) -> None:
        # Post-fix, multilingual Whisper has its 99-language whitelist
        # populated explicitly — `_is_universal` is not what passes the
        # check; the whitelist membership is. Spanish IS in Whisper's
        # whitelist, so `is_language_compatible` returns True even though
        # `_is_universal` may now return False.
        assert catalog.is_language_compatible("large-v3", "es") is True

    def test_is_universal_constrained_known_model(self, catalog: ModelCatalog) -> None:
        assert catalog._is_universal("gigaam-v3-e2e-ctc", "en") is False


def _fake_path(slug: str) -> Path:
    """Cross-platform fake path used by tests that never touch the filesystem."""
    return Path("/fake") / "custom" / slug


def _make_entry(
    slug: str,
    *,
    valid: bool = True,
    display_name: str | None = None,
    description: str = "",
    error_message: str = "",
    config: dict[str, object] | None = None,
    path: Path | None = None,
) -> CustomModelEntry:
    """Concise factory used by the custom-model registry tests."""
    return CustomModelEntry(
        slug=slug,
        path=path or _fake_path(slug),
        valid=valid,
        display_name=display_name or slug,
        description=description or f"Custom model in {_fake_path(slug)}",
        error_message=error_message,
        config=config or {},
    )


class TestCustomModelsInCatalog:
    """ModelCatalog folds scanned custom-model entries alongside catalog.json."""

    def test_valid_custom_entry_registered_with_custom_family(self) -> None:
        def scanner(_: Path | str | None) -> list[CustomModelEntry]:
            return [_make_entry("my-whisper", display_name="My Whisper")]

        catalog = ModelCatalog(custom_models_dir="/fake/custom", custom_scanner=scanner)
        info = catalog.get("custom-my-whisper")
        assert info is not None
        assert info.family == CUSTOM_MODEL_FAMILY
        assert info.display_name == "My Whisper"
        assert info.available is True
        assert info.error_message == ""
        assert info.local_path == str(_fake_path("my-whisper"))
        # Custom models route through onnx-asr at runtime; the catalog
        # tags them accordingly so the bootstrap loader takes the local
        # path branch.
        assert info.backend == TranscriberBackend.ONNX_ASR
        assert info.supports_realtime is True

    def test_invalid_custom_entry_surfaces_as_unavailable_with_error(self) -> None:
        def scanner(_: Path | str | None) -> list[CustomModelEntry]:
            return [
                _make_entry(
                    "broken",
                    valid=False,
                    error_message="missing tokenizer.json in broken",
                    description="Broken custom model in /fake/custom/broken: missing tokenizer.json in broken",
                ),
            ]

        catalog = ModelCatalog(custom_models_dir="/fake/custom", custom_scanner=scanner)
        info = catalog.get("custom-broken")
        assert info is not None
        assert info.available is False
        assert info.error_message == "missing tokenizer.json in broken"
        # Broken entries still surface so the UI can grey them out — the
        # alternative (silently hiding the folder) leaves the user
        # wondering why their drop didn't appear.
        assert info.family == CUSTOM_MODEL_FAMILY

    def test_no_custom_dir_skips_scan(self) -> None:
        calls: list[Path | str | None] = []

        def scanner(directory: Path | str | None) -> list[CustomModelEntry]:
            calls.append(directory)
            return []

        catalog = ModelCatalog(custom_models_dir=None, custom_scanner=scanner)
        # No custom-* entries when the directory is None — the scanner
        # should not have been called at all.
        assert not [m for m in catalog.list_all() if m.family == CUSTOM_MODEL_FAMILY]
        assert calls == []

    def test_to_dicts_includes_custom_entry_fields(self) -> None:
        def scanner(_: Path | str | None) -> list[CustomModelEntry]:
            return [_make_entry("acme", display_name="Acme Voice")]

        catalog = ModelCatalog(custom_models_dir="/fake/custom", custom_scanner=scanner)
        dicts = catalog.to_dicts()
        row = next(d for d in dicts if d["id"] == "custom-acme")
        assert row["family"] == CUSTOM_MODEL_FAMILY
        assert row["available"] is True
        assert row["error_message"] == ""
        assert row["local_path"] == str(_fake_path("acme"))

    def test_to_dicts_includes_broken_entry_fields(self) -> None:
        def scanner(_: Path | str | None) -> list[CustomModelEntry]:
            return [
                _make_entry(
                    "halfbroken",
                    valid=False,
                    error_message="missing decoder_model.onnx in halfbroken",
                )
            ]

        catalog = ModelCatalog(custom_models_dir="/fake/custom", custom_scanner=scanner)
        row = next(d for d in catalog.to_dicts() if d["id"] == "custom-halfbroken")
        assert row["available"] is False
        assert row["error_message"] == "missing decoder_model.onnx in halfbroken"
        assert row["local_path"] == str(_fake_path("halfbroken"))

    def test_shipped_entries_keep_available_true_and_no_local_path(self) -> None:
        catalog = ModelCatalog(custom_models_dir=None)
        tiny = catalog.get("tiny")
        assert tiny is not None
        assert tiny.available is True
        assert tiny.local_path is None
        assert tiny.error_message == ""

    def test_multiple_custom_entries_all_registered(self) -> None:
        def scanner(_: Path | str | None) -> list[CustomModelEntry]:
            return [
                _make_entry("first"),
                _make_entry("second"),
                _make_entry("third", valid=False, error_message="missing encoder.onnx in third"),
            ]

        catalog = ModelCatalog(custom_models_dir="/fake/custom", custom_scanner=scanner)
        ids = {m.id for m in catalog.list_all() if m.family == CUSTOM_MODEL_FAMILY}
        assert ids == {"custom-first", "custom-second", "custom-third"}


class TestCustomModelsDirGlobal:
    """``set_custom_models_dir`` / ``get_custom_models_dir`` module-level config."""

    def test_default_is_none(self) -> None:
        # Tests that touch the module-level config must restore it afterwards
        # so they don't bleed state into one another — the body uses a
        # try/finally for that.
        original = get_custom_models_dir()
        try:
            set_custom_models_dir(None)
            assert get_custom_models_dir() is None
        finally:
            set_custom_models_dir(original)

    def test_set_and_get_round_trip(self) -> None:
        original = get_custom_models_dir()
        try:
            set_custom_models_dir("/some/path")
            got = get_custom_models_dir()
            assert got is not None
            assert got == Path("/some/path")
        finally:
            set_custom_models_dir(original)

    def test_set_none_disables(self) -> None:
        original = get_custom_models_dir()
        try:
            set_custom_models_dir("/some/path")
            set_custom_models_dir(None)
            assert get_custom_models_dir() is None
        finally:
            set_custom_models_dir(original)

    def test_catalog_uses_module_default_when_kwarg_missing(self) -> None:
        """``ModelCatalog()`` with no kwargs picks up the module-level dir."""

        def scanner(_: Path | str | None) -> list[CustomModelEntry]:
            return [_make_entry("from-default")]

        original = get_custom_models_dir()
        try:
            set_custom_models_dir("/default/scan/dir")
            catalog = ModelCatalog(custom_scanner=scanner)
            assert catalog.get("custom-from-default") is not None
        finally:
            set_custom_models_dir(original)

    def test_default_scanner_resolves_to_infrastructure_implementation(self, tmp_path: Path) -> None:
        """Without an explicit ``custom_scanner`` we lazily import the infrastructure scanner.

        Domain code must not import infrastructure at module load (would
        break the hexagonal contract); the lookup happens inside
        :func:`_get_default_scanner` and is exercised by passing an empty
        directory so the real scanner runs and returns ``[]``.
        """
        original = get_custom_models_dir()
        try:
            set_custom_models_dir(tmp_path)  # empty tmpdir = no entries
            catalog = ModelCatalog()
            # No custom entries — the directory is empty — but the real
            # scanner was wired and called, covering the lazy import path.
            assert [m for m in catalog.list_all() if m.family == CUSTOM_MODEL_FAMILY] == []
        finally:
            set_custom_models_dir(original)


class TestModelInfoCustomFields:
    """The new ``available`` / ``error_message`` / ``local_path`` fields."""

    def test_defaults_are_backward_compatible(self) -> None:
        info = ModelInfo(
            id="x",
            display_name="X",
            backend=TranscriberBackend.ONNX_ASR,
            family="x",
        )
        # Pre-existing constructors (mypy --strict + ruff already passed
        # them as kwargs) must keep working — the new fields default to
        # the "shipped catalog row" semantics.
        assert info.available is True
        assert info.error_message == ""
        assert info.local_path is None

    def test_custom_fields_round_trip(self) -> None:
        info = ModelInfo(
            id="custom-x",
            display_name="X",
            backend=TranscriberBackend.ONNX_ASR,
            family=CUSTOM_MODEL_FAMILY,
            available=False,
            error_message="missing tokenizer.json in x",
            local_path="/path/to/x",
        )
        assert info.available is False
        assert info.error_message == "missing tokenizer.json in x"
        assert info.local_path == "/path/to/x"
