from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class TranscriberBackend(Enum):
    FASTER_WHISPER = "faster_whisper"
    ONNX_ASR = "onnx_asr"


@dataclass(frozen=True)
class ModelInfo:
    id: str
    display_name: str
    backend: TranscriberBackend
    family: str
    languages: list[str] = field(default_factory=list)
    supports_language_detection: bool = False
    size_label: str = ""
    supports_realtime: bool = False
    onnx_model_name: str | None = None
    description: str = ""


def _whisper_models() -> list[ModelInfo]:
    multilingual = [
        ("tiny", "Whisper Tiny", "39M"),
        ("base", "Whisper Base", "74M"),
        ("small", "Whisper Small", "244M"),
        ("medium", "Whisper Medium", "769M"),
        ("large-v1", "Whisper Large v1", "1.5B"),
        ("large-v2", "Whisper Large v2", "1.5B"),
        ("large-v3", "Whisper Large v3", "1.5B"),
        ("large-v3-turbo", "Whisper Large v3 Turbo", "809M"),
    ]
    english_only = [
        ("tiny.en", "Whisper Tiny (EN)", "39M"),
        ("base.en", "Whisper Base (EN)", "74M"),
        ("small.en", "Whisper Small (EN)", "244M"),
        ("medium.en", "Whisper Medium (EN)", "769M"),
    ]
    models: list[ModelInfo] = []
    for model_id, name, size in multilingual:
        models.append(
            ModelInfo(
                id=model_id,
                display_name=name,
                backend=TranscriberBackend.FASTER_WHISPER,
                family="whisper",
                languages=[],
                supports_language_detection=True,
                size_label=size,
                supports_realtime=True,
                description=f"OpenAI Whisper {model_id} ({size} params)",
            )
        )
    for model_id, name, size in english_only:
        models.append(
            ModelInfo(
                id=model_id,
                display_name=name,
                backend=TranscriberBackend.FASTER_WHISPER,
                family="whisper",
                languages=["en"],
                supports_language_detection=False,
                size_label=size,
                supports_realtime=True,
                description=f"OpenAI Whisper {model_id} ({size} params, English only)",
            )
        )
    return models


def _nemo_models() -> list[ModelInfo]:
    entries: list[tuple[str, str, list[str], bool, str, str]] = [
        ("nemo-parakeet-ctc-0.6b", "NeMo Parakeet CTC 0.6B", ["en"], False, "600M", "NVIDIA Parakeet CTC model"),
        ("nemo-parakeet-rnnt-0.6b", "NeMo Parakeet RNNT 0.6B", ["en"], False, "600M", "NVIDIA Parakeet RNNT model"),
        ("nemo-parakeet-tdt-0.6b-v2", "NeMo Parakeet TDT 0.6B v2", ["en"], False, "600M", "NVIDIA Parakeet TDT v2"),
        (
            "nemo-parakeet-tdt-0.6b-v3",
            "NeMo Parakeet TDT 0.6B v3",
            [],
            True,
            "600M",
            "NVIDIA Parakeet TDT v3 (multilingual)",
        ),
        (
            "nemo-canary-1b-v2",
            "NeMo Canary 1B v2",
            [],
            True,
            "1B",
            "NVIDIA Canary 1B v2 (multilingual, language detection)",
        ),
        (
            "nemo-fastconformer-ru-ctc",
            "NeMo FastConformer RU CTC",
            ["ru"],
            False,
            "",
            "NVIDIA FastConformer Russian CTC",
        ),
        (
            "nemo-fastconformer-ru-rnnt",
            "NeMo FastConformer RU RNNT",
            ["ru"],
            False,
            "",
            "NVIDIA FastConformer Russian RNNT",
        ),
    ]
    models: list[ModelInfo] = []
    for model_id, name, langs, lang_detect, size, desc in entries:
        models.append(
            ModelInfo(
                id=model_id,
                display_name=name,
                backend=TranscriberBackend.ONNX_ASR,
                family="nemo",
                languages=langs,
                supports_language_detection=lang_detect,
                size_label=size,
                supports_realtime=True,
                onnx_model_name=model_id,
                description=desc,
            )
        )
    return models


def _gigaam_models() -> list[ModelInfo]:
    ids = [
        ("gigaam-v2-ctc", "GigaAM v2 CTC"),
        ("gigaam-v2-rnnt", "GigaAM v2 RNNT"),
        ("gigaam-v3-ctc", "GigaAM v3 CTC"),
        ("gigaam-v3-rnnt", "GigaAM v3 RNNT"),
        ("gigaam-v3-e2e-ctc", "GigaAM v3 E2E CTC"),
        ("gigaam-v3-e2e-rnnt", "GigaAM v3 E2E RNNT"),
    ]
    return [
        ModelInfo(
            id=model_id,
            display_name=name,
            backend=TranscriberBackend.ONNX_ASR,
            family="gigaam",
            languages=["ru"],
            supports_realtime=True,
            onnx_model_name=model_id,
            description=f"GigaAM {model_id} (Russian)",
        )
        for model_id, name in ids
    ]


def _kaldi_models() -> list[ModelInfo]:
    return [
        ModelInfo(
            id="alphacep/vosk-model-ru",
            display_name="Vosk Russian",
            backend=TranscriberBackend.ONNX_ASR,
            family="kaldi",
            languages=["ru"],
            supports_realtime=True,
            onnx_model_name="alphacep/vosk-model-ru",
            description="Kaldi/Vosk Russian model",
        ),
        ModelInfo(
            id="alphacep/vosk-model-small-ru",
            display_name="Vosk Russian (Small)",
            backend=TranscriberBackend.ONNX_ASR,
            family="kaldi",
            languages=["ru"],
            supports_realtime=True,
            onnx_model_name="alphacep/vosk-model-small-ru",
            description="Kaldi/Vosk Russian small model",
        ),
    ]


def _tone_models() -> list[ModelInfo]:
    return [
        ModelInfo(
            id="t-tech/t-one",
            display_name="T-One",
            backend=TranscriberBackend.ONNX_ASR,
            family="t-one",
            languages=["ru"],
            supports_realtime=True,
            onnx_model_name="t-tech/t-one",
            description="T-Tech T-One Russian ASR",
        ),
    ]


def _whisper_onnx_models() -> list[ModelInfo]:
    return [
        ModelInfo(
            id="whisper-base",
            display_name="Whisper Base (ONNX)",
            backend=TranscriberBackend.ONNX_ASR,
            family="whisper",
            languages=[],
            supports_language_detection=True,
            supports_realtime=True,
            onnx_model_name="whisper-base",
            description="OpenAI Whisper Base via ONNX runtime",
        ),
    ]


class ModelCatalog:
    """Registry of all known ASR models and their metadata."""

    def __init__(self) -> None:
        self._models: dict[str, ModelInfo] = {}
        for model in (
            *_whisper_models(),
            *_nemo_models(),
            *_gigaam_models(),
            *_kaldi_models(),
            *_tone_models(),
            *_whisper_onnx_models(),
        ):
            self._models[model.id] = model

    def get(self, model_id: str) -> ModelInfo | None:
        return self._models.get(model_id)

    def get_backend(self, model_id: str) -> TranscriberBackend:
        info = self._models.get(model_id)
        if info is None:
            return TranscriberBackend.FASTER_WHISPER
        return info.backend

    def list_all(self) -> list[ModelInfo]:
        return list(self._models.values())

    def to_dicts(self) -> list[dict[str, object]]:
        result: list[dict[str, object]] = []
        for m in self._models.values():
            result.append({
                "id": m.id,
                "display_name": m.display_name,
                "backend": m.backend.value,
                "family": m.family,
                "languages": m.languages,
                "supports_language_detection": m.supports_language_detection,
                "size_label": m.size_label,
                "supports_realtime": m.supports_realtime,
                "onnx_model_name": m.onnx_model_name,
                "description": m.description,
            })
        return result
