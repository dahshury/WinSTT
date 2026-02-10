from __future__ import annotations

import json

import pytest

from src.recorder.domain.model_registry import ModelCatalog, ModelInfo, TranscriberBackend

WHISPER_IDS = [
    "tiny", "tiny.en", "base", "base.en", "small", "small.en",
    "medium", "medium.en", "large-v1", "large-v2", "large-v3", "large-v3-turbo",
]


@pytest.fixture()
def catalog() -> ModelCatalog:
    return ModelCatalog()


class TestModelCatalog:
    def test_all_whisper_models_present(self, catalog: ModelCatalog) -> None:
        for model_id in WHISPER_IDS:
            info = catalog.get(model_id)
            assert info is not None, f"Missing whisper model: {model_id}"
            assert info.backend == TranscriberBackend.FASTER_WHISPER

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
        assert catalog.get_backend("tiny") == TranscriberBackend.FASTER_WHISPER
        assert catalog.get_backend("nemo-parakeet-ctc-0.6b") == TranscriberBackend.ONNX_ASR
        assert catalog.get_backend("gigaam-v2-ctc") == TranscriberBackend.ONNX_ASR

    def test_get_backend_defaults_to_faster_whisper_for_unknown(self, catalog: ModelCatalog) -> None:
        assert catalog.get_backend("some-unknown-model") == TranscriberBackend.FASTER_WHISPER

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

    def test_transcriber_backend_values(self) -> None:
        assert TranscriberBackend.FASTER_WHISPER.value == "faster_whisper"
        assert TranscriberBackend.ONNX_ASR.value == "onnx_asr"
