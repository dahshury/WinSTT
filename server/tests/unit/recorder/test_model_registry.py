from __future__ import annotations

import json

import pytest

from src.recorder.domain.model_registry import ModelCatalog, ModelInfo, TranscriberBackend

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
        for model_id in WHISPER_IDS:
            info = catalog.get(model_id)
            assert info is not None, f"Missing whisper model: {model_id}"
            # Whisper entries route through onnx-asr after Track B step 1.
            assert info.backend == TranscriberBackend.ONNX_ASR
            assert info.onnx_model_name is not None
            assert info.onnx_model_name.startswith("onnx-community/whisper-")

    def test_onnx_asr_models_present(self, catalog: ModelCatalog) -> None:
        onnx_ids = [
            "nemo-parakeet-ctc-0.6b",
            "nemo-parakeet-rnnt-0.6b",
            "nemo-parakeet-tdt-0.6b-v2",
            "nemo-parakeet-tdt-0.6b-v3",
            "nemo-canary-1b-v2",
            "nemo-fastconformer-ru-ctc",
            "nemo-fastconformer-ru-rnnt",
            "gigaam-v2-ctc",
            "gigaam-v2-rnnt",
            "gigaam-v3-ctc",
            "gigaam-v3-rnnt",
            "gigaam-v3-e2e-ctc",
            "gigaam-v3-e2e-rnnt",
            "alphacep/vosk-model-ru",
            "alphacep/vosk-model-small-ru",
            "t-tech/t-one",
            "whisper-base",
        ]
        for model_id in onnx_ids:
            info = catalog.get(model_id)
            assert info is not None, f"Missing onnx-asr model: {model_id}"
            assert info.backend == TranscriberBackend.ONNX_ASR

    def test_get_backend_returns_correct_backend(self, catalog: ModelCatalog) -> None:
        # Every catalog entry now routes through onnx-asr post Track B step 1.
        assert catalog.get_backend("tiny") == TranscriberBackend.ONNX_ASR
        assert catalog.get_backend("nemo-parakeet-ctc-0.6b") == TranscriberBackend.ONNX_ASR
        assert catalog.get_backend("gigaam-v2-ctc") == TranscriberBackend.ONNX_ASR

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
        assert info.languages == []

    def test_whisper_english_only_no_language_detection(self, catalog: ModelCatalog) -> None:
        info = catalog.get("tiny.en")
        assert info is not None
        assert info.supports_language_detection is False
        assert info.languages == ["en"]

    def test_nemo_canary_supports_language_detection(self, catalog: ModelCatalog) -> None:
        info = catalog.get("nemo-canary-1b-v2")
        assert info is not None
        assert info.supports_language_detection is True
        assert info.size_label == "1B"

    def test_gigaam_models_are_russian(self, catalog: ModelCatalog) -> None:
        info = catalog.get("gigaam-v3-ctc")
        assert info is not None
        assert info.languages == ["ru"]
        assert info.family == "gigaam"

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

    def test_whisper_ships_full_quantization_matrix(self, catalog: ModelCatalog) -> None:
        info = catalog.get("large-v3")
        assert info is not None
        assert info.available_quantizations == ["", "int8", "fp16", "uint8", "q4", "q4f16", "bnb4"]

    def test_nemo_ships_default_and_int8(self, catalog: ModelCatalog) -> None:
        info = catalog.get("nemo-parakeet-tdt-0.6b-v3")
        assert info is not None
        assert info.available_quantizations == ["", "int8"]

    def test_gigaam_ships_default_quantization_only(self, catalog: ModelCatalog) -> None:
        info = catalog.get("gigaam-v3-ctc")
        assert info is not None
        assert info.available_quantizations == [""]

    def test_transcriber_backend_values(self) -> None:
        assert TranscriberBackend.FASTER_WHISPER.value == "faster_whisper"
        assert TranscriberBackend.ONNX_ASR.value == "onnx_asr"

    def test_is_language_compatible_empty_language_always_passes(self, catalog: ModelCatalog) -> None:
        # Empty language = auto-detect; every model accepts that.
        assert catalog.is_language_compatible("tiny.en", "") is True
        assert catalog.is_language_compatible("large-v3", "") is True
        assert catalog.is_language_compatible("gigaam-v3-ctc", "") is True

    def test_is_language_compatible_unknown_model_passes(self, catalog: ModelCatalog) -> None:
        # Catalog is not exhaustive — onnx-asr accepts raw HF repo paths.
        assert catalog.is_language_compatible("unknown/model-xyz", "en") is True

    def test_is_language_compatible_multilingual_accepts_any(self, catalog: ModelCatalog) -> None:
        # Whisper multilingual models support language detection AND empty `languages`.
        for lang in ("en", "es", "fr", "zh", "hi", "ar", "ru"):
            assert catalog.is_language_compatible("large-v3", lang) is True
            assert catalog.is_language_compatible("nemo-canary-1b-v2", lang) is True

    def test_is_language_compatible_english_only_rejects_others(self, catalog: ModelCatalog) -> None:
        assert catalog.is_language_compatible("tiny.en", "en") is True
        assert catalog.is_language_compatible("tiny.en", "es") is False
        assert catalog.is_language_compatible("tiny.en", "fr") is False

    def test_is_language_compatible_russian_only_models(self, catalog: ModelCatalog) -> None:
        assert catalog.is_language_compatible("gigaam-v3-ctc", "ru") is True
        assert catalog.is_language_compatible("gigaam-v3-ctc", "en") is False
        assert catalog.is_language_compatible("t-tech/t-one", "ru") is True
        assert catalog.is_language_compatible("t-tech/t-one", "en") is False

    def test_accepts_any_language_language_detection(self) -> None:
        info = ModelInfo(
            id="x",
            display_name="X",
            backend=TranscriberBackend.ONNX_ASR,
            family="x",
            languages=["en"],
            supports_language_detection=True,
        )
        assert ModelCatalog._accepts_any_language(info) is True

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
        assert catalog._is_universal("gigaam-v3-ctc", "") is True

    def test_is_universal_unknown_model(self, catalog: ModelCatalog) -> None:
        assert catalog._is_universal("unknown/model-xyz", "en") is True

    def test_is_universal_multilingual_known_model(self, catalog: ModelCatalog) -> None:
        assert catalog._is_universal("large-v3", "es") is True

    def test_is_universal_constrained_known_model(self, catalog: ModelCatalog) -> None:
        assert catalog._is_universal("gigaam-v3-ctc", "en") is False
