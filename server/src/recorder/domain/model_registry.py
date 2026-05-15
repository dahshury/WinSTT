from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class TranscriberBackend(Enum):
    """ASR backend identifier.

    Post-Track-B-step-1 the server only supports ``ONNX_ASR``. The legacy
    ``FASTER_WHISPER`` value is retained as an alias (it routes to the same
    onnx-asr adapter) so persisted user configs from older builds don't
    fail to deserialize.
    """

    ONNX_ASR = "onnx_asr"
    FASTER_WHISPER = "faster_whisper"  # alias — routed to ONNX_ASR by bootstrap


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
    #: Approximate parameter count for the model. Drives the hardware-fitness
    #: estimate (memory headroom needed at run time). int8 quantization in
    #: onnx-asr roughly stores 1 byte per parameter + per-op activation
    #: overhead, so ``params * 1`` is a reasonable lower bound on resident
    #: bytes; default fp32 onnx is ``params * 4``. Zero means "unknown" —
    #: the catalog renders no warning for those.
    param_count: int = 0


def _whisper_models() -> list[ModelInfo]:
    """Catalog entries for the OpenAI Whisper family, routed through onnx-asr.

    User-facing IDs are unchanged from the legacy faster_whisper-era catalog
    (so persisted settings keep deserializing) but each one now carries
    ``onnx_model_name`` pointing at the matching ``onnx-community`` HF repo —
    that's what onnx-asr's resolver actually loads.
    """
    # Only sizes shipped by onnx-community are included. large-v1 / v2 are
    # absent because there's no upstream ONNX export for them. param_count
    # comes from OpenAI's published model spec — drives the fitness heuristic.
    multilingual: list[tuple[str, str, str, int]] = [
        ("tiny", "Whisper Tiny", "39M", 39_000_000),
        ("base", "Whisper Base", "74M", 74_000_000),
        ("small", "Whisper Small", "244M", 244_000_000),
        ("medium", "Whisper Medium", "769M", 769_000_000),
        ("large-v3", "Whisper Large v3", "1.5B", 1_540_000_000),
        ("large-v3-turbo", "Whisper Large v3 Turbo", "809M", 809_000_000),
    ]
    english_only: list[tuple[str, str, str, int]] = [
        ("tiny.en", "Whisper Tiny (EN)", "39M", 39_000_000),
        ("base.en", "Whisper Base (EN)", "74M", 74_000_000),
        ("small.en", "Whisper Small (EN)", "244M", 244_000_000),
        ("medium.en", "Whisper Medium (EN)", "769M", 769_000_000),
    ]
    models: list[ModelInfo] = []
    for model_id, name, size, params in multilingual:
        models.append(
            ModelInfo(
                id=model_id,
                display_name=name,
                backend=TranscriberBackend.ONNX_ASR,
                family="whisper",
                languages=[],
                supports_language_detection=True,
                size_label=size,
                supports_realtime=True,
                onnx_model_name=f"onnx-community/whisper-{model_id}",
                description=f"OpenAI Whisper {model_id} ({size} params)",
                param_count=params,
            )
        )
    for model_id, name, size, params in english_only:
        models.append(
            ModelInfo(
                id=model_id,
                display_name=name,
                backend=TranscriberBackend.ONNX_ASR,
                family="whisper",
                languages=["en"],
                supports_language_detection=False,
                size_label=size,
                supports_realtime=True,
                onnx_model_name=f"onnx-community/whisper-{model_id}",
                description=f"OpenAI Whisper {model_id} ({size} params, English only)",
                param_count=params,
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
            return TranscriberBackend.ONNX_ASR
        return info.backend

    def list_all(self) -> list[ModelInfo]:
        return list(self._models.values())

    def is_language_compatible(self, model_id: str, language: str) -> bool:
        """Return whether ``model_id`` can transcribe ``language``.

        Empty ``language`` (= auto-detect) is always compatible. Unknown
        models are treated as compatible — the catalog is not exhaustive of
        every onnx-asr-resolvable name, so refusing here would be too strict.
        Multilingual models (``languages == []``) and models that opt into
        ``supports_language_detection`` accept any language tag. Otherwise
        the language must appear in the model's ``languages`` list.
        """
        if not language:
            return True
        info = self._models.get(model_id)
        if info is None:
            return True
        if info.supports_language_detection or not info.languages:
            return True
        return language in info.languages

    def to_dicts(self) -> list[dict[str, object]]:
        result: list[dict[str, object]] = []
        for m in self._models.values():
            result.append(
                {
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
                    "param_count": m.param_count,
                }
            )
        return result
