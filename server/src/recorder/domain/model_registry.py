from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


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
    #: ONNX quantization suffixes the upstream repo actually ships. The
    #: empty string is the default (un-suffixed) export. The picker only
    #: offers these — onnx-community Whisper repos carry the full matrix;
    #: most other repos ship only the default graph. Empty list → the model
    #: takes no quantization (faster-whisper-style), picker hides the row.
    available_quantizations: list[str] = field(default_factory=lambda: [""])


#: Quantization suffixes ORT's CUDAExecutionProvider can actually accelerate.
#: Per Optimum's GPU guide and ORT quantization docs, CUDA-EP cannot fuse
#: Q/DQ nodes — int8 / uint8 / q4 / q4f16 / bnb4 all fall back to fp32
#: compute via QDQ scatter-gather (slower than plain fp32) and the
#: per-channel int8 path has a known Whisper-encoder bug
#: (microsoft/onnxruntime#25489) that produces hallucinated output.
#: Benchmark-confirmed locally: ``int8`` on CUDA ran at 2.4x realtime
#: AND emitted 8788 hallucinated words on the JFK-loop test (vs 3608 true).
#: Only fp32 ("") and fp16 are real CUDA wins, so the UI shouldn't tempt
#: users with the others on a GPU install.
_GPU_COMPATIBLE_QUANTIZATIONS: frozenset[str] = frozenset({"", "fp16"})


def gpu_filter_quantizations(quants: list[str]) -> list[str]:
    """Drop sub-fp16 quants from ``quants`` (preserves order, keeps "" + fp16)."""
    return [q for q in quants if q in _GPU_COMPATIBLE_QUANTIZATIONS]


def _billions_label(params: int) -> str:
    b = params / 1_000_000_000
    if b == int(b):
        return f"{int(b)}B"
    return f"{round(b, 2):g}B"


def _size_label(params: int) -> str:
    """Human-readable label derived from an exact param count.

    Sub-billion: ``{N}M`` rounded to the nearest million. ≥1 B: ``{N.NN}B``
    rounded to two decimals (kept consistent with prior catalog labels).
    """
    if params <= 0:
        return ""
    if params >= 1_000_000_000:
        return _billions_label(params)
    return f"{round(params / 1_000_000)}M"


#: Path to the JSON catalog data file. Colocated with this module so both
#: dev (``uv run …``) and the PyInstaller frozen bundle resolve it via
#: ``Path(__file__).parent`` without any environment-specific branches.
_CATALOG_JSON: Path = Path(__file__).parent / "catalog.json"


#: Lookup from JSON ``backend`` slug to enum member. Built once from the
#: enum so new members are picked up automatically. Anything not in here
#: (including ``None`` / empty / unknown) coerces to ``ONNX_ASR``.
_BACKEND_BY_VALUE: dict[str, TranscriberBackend] = {m.value: m for m in TranscriberBackend}


def _backend_from_str(value: str | None) -> TranscriberBackend:
    """Coerce a backend slug from the JSON catalog into the enum.

    JSON entries may omit ``backend`` (everything is onnx-asr after the
    torch-drop) — fall back to ``ONNX_ASR`` so the data file stays terse.
    """
    return _BACKEND_BY_VALUE.get(value or "", TranscriberBackend.ONNX_ASR)


def _str_list(raw: object, *, default: list[str]) -> list[str]:
    """Coerce a JSON value into a ``list[str]``, falling back to ``default``."""
    if not isinstance(raw, list):
        return list(default)
    return [str(item) for item in raw]


def _model_from_json(entry: dict[str, Any]) -> ModelInfo:
    """Build a :class:`ModelInfo` from one JSON entry.

    Trusts the editorial fields verbatim and derives ``size_label`` from
    ``param_count`` so the on-disk JSON stays focused on data the refresh
    script can verify against HuggingFace.
    """
    params = int(entry.get("param_count", 0))
    quants = _str_list(entry.get("available_quantizations", [""]), default=[""])
    languages = _str_list(entry.get("languages", []), default=[])
    return ModelInfo(
        id=str(entry["id"]),
        display_name=str(entry.get("display_name", entry["id"])),
        backend=_backend_from_str(entry.get("backend")),
        family=str(entry.get("family", "")),
        languages=languages,
        supports_language_detection=bool(entry.get("supports_language_detection", False)),
        size_label=_size_label(params),
        supports_realtime=bool(entry.get("supports_realtime", False)),
        onnx_model_name=entry.get("onnx_model_name"),
        description=str(entry.get("description", "")),
        param_count=params,
        available_quantizations=quants,
    )


def _load_catalog_entries() -> list[ModelInfo]:
    """Load every catalog entry from :data:`_CATALOG_JSON`.

    The JSON file is generated/refreshed by ``scripts/refresh_catalog.py``
    and committed to the repo. Raising on a missing file is intentional —
    a deployment without the catalog is broken; a silent empty catalog
    would hide the breakage. The result is then folded with any per-user
    overlay (see :mod:`catalog_overlay`) so a previous runtime refresh's
    HF data survives across launches even when the next boot is offline.
    """
    with _CATALOG_JSON.open("r", encoding="utf-8") as f:
        payload = json.load(f)
    raw_models = payload.get("models", [])
    if not isinstance(raw_models, list):
        msg = f"catalog.json malformed: 'models' must be a list, got {type(raw_models).__name__}"
        raise ValueError(msg)
    from src.recorder.domain.catalog_overlay import load_overlay

    overlay = load_overlay()
    return [_apply_overlay(_model_from_json(entry), overlay) for entry in raw_models]


def _str_only(values: list[Any]) -> list[str]:
    return [str(v) for v in values if isinstance(v, str)]


def _overlay_languages(patch: dict[str, Any] | None) -> list[str]:
    """Extract a normalized ``languages`` list from an overlay patch.

    Empty list means "no usable override" — the caller keeps the bundled
    value. Guards every shape the on-disk overlay could carry.
    """
    if not patch:
        return []
    languages = patch.get("languages")
    if not isinstance(languages, list):
        return []
    return _str_only(languages)


def _apply_overlay(info: ModelInfo, overlay: dict[str, dict[str, Any]]) -> ModelInfo:
    """Return ``info`` with any matching overlay fields swapped in.

    Today only ``languages`` is overlayable. The overlay's list is taken
    verbatim — a runtime refresh that successfully fetched HF metadata is
    by definition more authoritative than the bundled snapshot.
    """
    normalized = _overlay_languages(overlay.get(info.id))
    if not normalized:
        return info
    return ModelInfo(
        id=info.id,
        display_name=info.display_name,
        backend=info.backend,
        family=info.family,
        languages=normalized,
        supports_language_detection=info.supports_language_detection,
        size_label=info.size_label,
        supports_realtime=info.supports_realtime,
        onnx_model_name=info.onnx_model_name,
        description=info.description,
        param_count=info.param_count,
        available_quantizations=info.available_quantizations,
    )


class ModelCatalog:
    """Registry of all known ASR models and their metadata."""

    def __init__(self) -> None:
        self._models: dict[str, ModelInfo] = {}
        for model in _load_catalog_entries():
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

    @staticmethod
    def _accepts_any_language(info: ModelInfo) -> bool:
        """Whether ``info`` transcribes every language tag.

        True only when the whitelist is empty — that's the catalog's
        "unknown / accepts all" sentinel for entries the refresh script
        couldn't populate from HuggingFace metadata.
        ``supports_language_detection`` is orthogonal: Canary 1B v2
        auto-detects language *within* its 25 European whitelist, but
        cannot transcribe e.g. Arabic. Conflating the two used to make
        the language dropdown advertise unsupported languages.
        """
        return not info.languages

    def _is_universal(self, model_id: str, language: str) -> bool:
        """Whether the pairing is compatible regardless of the whitelist.

        Covers the three always-pass cases: empty ``language``
        (auto-detect), unknown ``model_id`` (catalog not exhaustive), and
        models that accept any language.
        """
        if not language:
            return True
        info = self._models.get(model_id)
        if info is None:
            return True
        return self._accepts_any_language(info)

    def is_language_compatible(self, model_id: str, language: str) -> bool:
        """Return whether ``model_id`` can transcribe ``language``.

        Empty ``language`` (= auto-detect) is always compatible. Unknown
        models are treated as compatible — the catalog is not exhaustive of
        every onnx-asr-resolvable name, so refusing here would be too strict.
        Empty ``languages`` whitelist means "unknown / accepts all"
        (entries the refresh script couldn't populate). Otherwise the
        language must appear in the model's ``languages`` list, even when
        the model supports language detection.
        """
        if self._is_universal(model_id, language):
            return True
        info = self._models[model_id]
        return language in info.languages

    def to_dicts(self, *, device: str | None = None) -> list[dict[str, object]]:
        """Serialize the catalog for the frontend.

        When ``device == "cuda"``, ``available_quantizations`` is filtered
        to those CUDAExecutionProvider can actually accelerate (only fp32
        and fp16) — sub-fp16 quants either silently fall back to fp32 or
        hallucinate on CUDA (see :data:`_GPU_COMPATIBLE_QUANTIZATIONS`).
        Hiding them in the picker stops users picking a "faster"
        quantization that is in fact slower AND less accurate.
        """
        filter_quants = device == "cuda"
        result: list[dict[str, object]] = []
        for m in self._models.values():
            quants = (
                gpu_filter_quantizations(m.available_quantizations)
                if filter_quants
                else list(m.available_quantizations)
            )
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
                    "available_quantizations": quants,
                }
            )
        return result
