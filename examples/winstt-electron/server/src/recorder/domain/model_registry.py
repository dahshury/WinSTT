from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from collections.abc import Iterator

    from src.recorder.domain.custom_models import CustomModelEntry


class TranscriberBackend(Enum):
    """ASR backend identifier.

    Post-Track-B-step-1 the server only supports ``ONNX_ASR``. The legacy
    ``FASTER_WHISPER`` value is retained as an alias (it routes to the same
    onnx-asr adapter) so persisted user configs from older builds don't
    fail to deserialize.
    """

    ONNX_ASR = "onnx_asr"
    FASTER_WHISPER = "faster_whisper"  # alias — routed to ONNX_ASR by bootstrap


#: Sentinel ``family`` value applied to every user-provided custom model
#: discovered under ``{custom_models_dir}/{slug}/``. The picker uses this to
#: render a separate "Custom" section and the bootstrap loader checks for
#: this to take the local-path code path instead of the HF resolver.
CUSTOM_MODEL_FAMILY: str = "custom"


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
    #: Total on-HF bytes per quantization variant, baked in by
    #: ``scripts/refresh_catalog.py`` from the HuggingFace metadata. Drives
    #: the download-confirmation dialog so it can show the exact byte count
    #: the moment it opens — replaces the legacy "Size: unknown until
    #: headers fetched" placeholder. Empty for custom-model entries and
    #: catalog rows the refresh hasn't covered yet; consumers fall back to
    #: ``size_label`` (the param-derived human label) in that case.
    size_bytes_by_quantization: dict[str, int] = field(default_factory=dict)
    #: ``True`` for every shipped catalog entry. User-provided custom-model
    #: bundles that fail the validation contract (missing encoder / decoder /
    #: tokenizer / config) surface as ``available=False`` so the UI can grey
    #: them out and explain why via ``error_message`` — much better UX than
    #: silently hiding a broken drop, which leaves the user wondering why
    #: their folder didn't appear.
    available: bool = True
    #: Empty for catalog entries. Set to a human-readable reason on broken
    #: custom-model entries so the picker can render a tooltip.
    error_message: str = ""
    #: Absolute path to the on-disk folder for custom-model entries; ``None``
    #: for shipped catalog rows. The transcriber loader uses this to call
    #: ``onnx_asr.load_model(path=...)`` instead of resolving through HF.
    local_path: str | None = None
    #: Optional SHA-256 digest of the canonical fp32 weights file, normalized
    #: to lowercase hex. Populated by ``scripts/refresh_catalog.py`` when the
    #: upstream repo exposes it; ``None`` for entries the refresh hasn't
    #: covered yet. Used by the model cache to detect corrupted downloads
    #: without having to re-fetch the entire weights file from HF.
    sha256: str | None = None
    #: Published word-error-rate (%, lower is better). Sourced from HF Open
    #: ASR Leaderboard or upstream model-card claims — see ``catalog.json``
    #: for the per-row numbers. ``0.0`` (default) means "unknown"; the picker
    #: hides the accuracy bar in that case. The renderer normalizes this
    #: into a 0..1 accuracy_score via :func:`_accuracy_score`.
    wer: float = 0.0
    #: Published real-time factor (RTFx — higher = faster; 1.0 = realtime).
    #: Sourced from HF Open ASR Leaderboard or model-card claims. ``0.0``
    #: (default) means "unknown" -- bar hidden. Normalized into 0..1
    #: speed_score via :func:`_speed_score` (log-scaled so the 1x/2000x
    #: dynamic range fits a single bar).
    rtfx: float = 0.0


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _accuracy_score(wer: float) -> float:
    """Normalize a published WER into the picker's 0..1 accuracy bar.

    ``wer <= 0`` is the "unknown" sentinel and maps to the renderer's
    ``0.5`` hide-bar value. Otherwise we use a linear ramp anchored at the
    catalog's worst-case (~30 % WER on Whisper-tiny) so the smallest model
    still earns a visible non-zero bar.
    """
    if wer <= 0:
        return 0.5
    return round(_clamp(1.0 - wer / 30.0, 0.05, 0.99), 3)


def _speed_score(rtfx: float) -> float:
    """Normalize a published RTFx into the picker's 0..1 speed bar.

    Log-scaled because the catalog's speed range spans 100x-2000x - a
    linear map would crush every Whisper variant into the bottom of the
    bar. ``rtfx <= 0`` maps to the renderer's ``0.5`` hide-bar sentinel.
    """
    if rtfx <= 0:
        return 0.5
    return round(_clamp(math.log10(rtfx + 1.0) / math.log10(2001.0), 0.05, 0.99), 3)


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


#: Model families whose ONNX encoder graph crashes on non-CUDA GPU EPs
#: (DirectML / ROCm / CoreML) at every quantization — the reshape patterns
#: trip ``MLOperatorAuthorImpl`` with ``ERROR_FATAL_APP_EXIT`` even with
#: graph optimizations disabled and even on int8. Verified by running
#: istupakov's ``encoder-model.int8.onnx`` for Canary 180M on bare ORT-DML
#: and observing the crash. Implementations that run these models on the
#: CPU EP avoid it not because their export differs (the encoder file is
#: byte-identical) but because they never route the model through a
#: non-CUDA GPU EP in the first place.
#:
#: :func:`bootstrap.build_transcriber` consults this set to override the
#: provider list to CPU-only for these models when the user's selected
#: accelerator is DML / ROCm / CoreML. Whisper / Moonshine / custom ship
#: working fp32 DML graphs and are not in the set.
_DML_INCOMPATIBLE_FAMILIES: frozenset[str] = frozenset(
    {"nemo", "cohere", "gigaam", "kaldi", "t-one", "sense_voice", "dolphin"}
)


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


def _float_or_zero(value: object) -> float:
    """Best-effort float coercion for optional JSON numeric fields.

    Returns ``0.0`` for ``None`` / missing / non-numeric -- that's the
    "unknown" sentinel both ``wer`` and ``rtfx`` use to mean "no bar".
    """
    if not isinstance(value, (int, float)):
        return 0.0
    return float(value)


def _model_from_json(entry: dict[str, Any]) -> ModelInfo:
    """Build a :class:`ModelInfo` from one JSON entry.

    Trusts the editorial fields verbatim and derives ``size_label`` from
    ``param_count`` so the on-disk JSON stays focused on data the refresh
    script can verify against HuggingFace.
    """
    params = int(entry.get("param_count", 0))
    quants = _str_list(entry.get("available_quantizations", [""]), default=[""])
    languages = _str_list(entry.get("languages", []), default=[])
    raw_sha = entry.get("sha256")
    sha256 = str(raw_sha).lower() if isinstance(raw_sha, str) and raw_sha else None
    family = str(entry.get("family", ""))
    return ModelInfo(
        id=str(entry["id"]),
        display_name=str(entry.get("display_name", entry["id"])),
        backend=_backend_from_str(entry.get("backend")),
        family=family,
        languages=languages,
        supports_language_detection=bool(entry.get("supports_language_detection", False)),
        size_label=_size_label(params),
        supports_realtime=bool(entry.get("supports_realtime", False)),
        onnx_model_name=entry.get("onnx_model_name"),
        description=str(entry.get("description", "")),
        param_count=params,
        available_quantizations=quants,
        size_bytes_by_quantization=_size_bytes_map(entry.get("size_bytes_by_quantization")),
        sha256=sha256,
        wer=_float_or_zero(entry.get("wer")),
        rtfx=_float_or_zero(entry.get("rtfx")),
    )


def _coerce_size(value: object) -> int | None:
    """A positive-int byte count, else ``None``.

    Non-positive / non-int values are the catalog's "unknown" sentinel (the
    refresh script omits them) and are dropped from the size map.
    """
    if isinstance(value, int) and value > 0:
        return value
    return None


def _str_keyed(raw: dict[Any, Any]) -> Iterator[tuple[str, object]]:
    """Yield only the ``(key, value)`` pairs of ``raw`` with ``str`` keys."""
    return ((key, value) for key, value in raw.items() if isinstance(key, str))


def _build_size_map(raw: dict[Any, Any]) -> dict[str, int]:
    """Keep ``str``-keyed entries whose value coerces to a positive byte count."""
    return {key: count for key, value in _str_keyed(raw) if (count := _coerce_size(value)) is not None}


def _size_bytes_map(raw: object) -> dict[str, int]:
    """Coerce the catalog's ``size_bytes_by_quantization`` blob into a dict.

    Drops keys whose values aren't positive integers — the refresh script
    persists zero/missing entries by omission, so anything non-positive in
    the on-disk JSON is treated as "unknown" rather than "0 bytes".
    """
    if not isinstance(raw, dict):
        return {}
    return _build_size_map(raw)


def _load_catalog_entries() -> list[ModelInfo]:
    """Load every catalog entry from :data:`_CATALOG_JSON`.

    The JSON file is generated/refreshed by ``scripts/refresh_catalog.py``
    at release time (it bakes ``languages`` / ``available_quantizations`` /
    ``param_count`` straight from the HuggingFace model cards) and committed
    to the repo — so the bundled snapshot is the single source of truth and
    the running server never re-fetches editorial metadata. Raising on a
    missing file is intentional: a deployment without the catalog is broken;
    a silent empty catalog would hide the breakage.
    """
    with _CATALOG_JSON.open("r", encoding="utf-8") as f:
        payload = json.load(f)
    raw_models = payload.get("models", [])
    if not isinstance(raw_models, list):
        msg = f"catalog.json malformed: 'models' must be a list, got {type(raw_models).__name__}"
        raise ValueError(msg)
    return [_model_from_json(entry) for entry in raw_models]


def _custom_id(slug: str) -> str:
    """``custom-{slug}`` — the stable id format the catalog registers and the
    picker uses to detect custom models without inspecting ``family``."""
    return f"custom-{slug}"


def _model_from_custom_entry(entry: CustomModelEntry) -> ModelInfo:
    """Build a :class:`ModelInfo` row from a scanned custom-model folder.

    Broken entries still get a row (with ``available=False``) so the UI can
    surface the failure to the user rather than silently dropping it.
    Custom models inherit ``supports_realtime=True`` so they're eligible for
    the realtime slot; ``param_count=0`` skips the hardware-fit warning
    (we don't know the parameter budget without loading the weights).
    """
    return ModelInfo(
        id=_custom_id(entry.slug),
        display_name=entry.display_name,
        backend=TranscriberBackend.ONNX_ASR,
        family=CUSTOM_MODEL_FAMILY,
        languages=[],
        supports_language_detection=False,
        size_label="",
        supports_realtime=True,
        onnx_model_name=None,
        description=entry.description,
        param_count=0,
        available_quantizations=[""],
        available=entry.valid,
        error_message=entry.error_message,
        local_path=str(entry.path),
    )


class CustomModelScanner(Protocol):
    """Minimal scanner contract domain depends on without importing infra.

    The concrete implementation lives at
    ``src.recorder.infrastructure.custom_model_scanner.scan_custom_models`` —
    domain code only sees this Protocol so the import contract stays clean
    (domain → building_blocks + stdlib only).
    """

    def __call__(self, custom_dir: Path | str | None) -> list[CustomModelEntry]:  # pragma: no cover — Protocol
        ...


#: Process-wide default for the custom-models directory. ``None`` (the
#: default) means "skip the custom-model scan" — useful in tests and when
#: the Electron host hasn't propagated the userData path yet. Override via
#: :func:`set_custom_models_dir` from the server startup.
_DEFAULT_CUSTOM_MODELS_DIR: Path | None = None

#: Lazy reference to the infrastructure scanner so the domain module
#: doesn't import infrastructure at import time. Set the first time the
#: catalog needs to actually scan — see :func:`_get_default_scanner`.
_DEFAULT_SCANNER: CustomModelScanner | None = None


def set_custom_models_dir(directory: Path | str | None) -> None:
    """Override the process-wide custom-models scan directory.

    Called from the server's ``main_async`` once Electron has propagated the
    ``--custom-models-dir`` CLI flag. Idempotent — pass ``None`` to disable.
    """
    global _DEFAULT_CUSTOM_MODELS_DIR
    _DEFAULT_CUSTOM_MODELS_DIR = Path(directory) if directory is not None else None


def get_custom_models_dir() -> Path | None:
    """Read the process-wide custom-models scan directory.

    Exposed for the IPC handler that implements "open custom models folder"
    so the Electron side can ``shell.openPath`` the exact same directory
    the server scans.
    """
    return _DEFAULT_CUSTOM_MODELS_DIR


def _get_default_scanner() -> CustomModelScanner:
    """Resolve the default infrastructure scanner lazily.

    Importing :mod:`infrastructure` from inside the domain module-load path
    would violate the layer contract. Instead we look it up on first call —
    by that point the application bootstrap has wired the layers and the
    import is just a registry hit, not a layer crossing at module-load.
    """
    global _DEFAULT_SCANNER
    if _DEFAULT_SCANNER is None:
        from src.recorder.infrastructure.custom_model_scanner import scan_custom_models

        _DEFAULT_SCANNER = scan_custom_models
    return _DEFAULT_SCANNER


def _resolve_custom_dir(custom_models_dir: Path | str | None) -> Path | str | None:
    """Effective scan dir: the explicit kwarg when the caller passed one (a
    test overriding the process default), else the module-level global.
    ``None`` (from either) skips the scan entirely."""
    if custom_models_dir is not None:
        return custom_models_dir
    return _DEFAULT_CUSTOM_MODELS_DIR


def _resolve_scanner(custom_scanner: CustomModelScanner | None) -> CustomModelScanner:
    """The injected scanner stub when supplied (tests), else the lazily
    resolved infrastructure scanner."""
    if custom_scanner is not None:
        return custom_scanner
    return _get_default_scanner()


class ModelCatalog:
    """Registry of all known ASR models and their metadata.

    ``custom_models_dir`` defaults to the module-level
    :data:`_DEFAULT_CUSTOM_MODELS_DIR` (configured at server startup). Pass
    an explicit ``Path`` (or ``None`` to disable) for unit tests. The
    scanner is injectable for the same reason — tests pass a stub closure
    and never touch the real filesystem.
    """

    def __init__(
        self,
        *,
        custom_models_dir: Path | str | None = None,
        custom_scanner: CustomModelScanner | None = None,
    ) -> None:
        self._models: dict[str, ModelInfo] = {}
        self._register_catalog()
        effective_dir = _resolve_custom_dir(custom_models_dir)
        if effective_dir is not None:
            self._register_custom(effective_dir, _resolve_scanner(custom_scanner))

    def _register_catalog(self) -> None:
        """Load every shipped catalog entry into ``self._models``."""
        for model in _load_catalog_entries():
            self._models[model.id] = model

    def _register_custom(self, effective_dir: Path | str, scanner: CustomModelScanner) -> None:
        """Scan ``effective_dir`` and register each discovered custom model."""
        for entry in scanner(effective_dir):
            info = _model_from_custom_entry(entry)
            # Custom slugs are user input — guard against a slug that
            # collides with a shipped catalog id ("custom-tiny" can't
            # exist today, but a sufficiently determined user could
            # try). The shipped catalog wins; the custom-scan row is
            # demoted to a unique fallback id so it still appears.
            self._models[info.id] = info

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
        ``supports_language_detection`` is orthogonal: Canary 1B v2 has
        a 25-language transcription whitelist, but this app's local Canary
        runtime still needs an explicit source language and cannot
        transcribe e.g. Arabic. Conflating the two used to make the
        language dropdown advertise unsupported languages.
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

    @staticmethod
    def _quants_for(m: ModelInfo, is_cuda: bool) -> list[str]:
        """The quantizations the picker should offer for ``m``.

        On CUDA, sub-fp16 quants are dropped (CUDA-EP can't accelerate them);
        every other EP keeps the full published list.
        """
        if is_cuda:
            return gpu_filter_quantizations(m.available_quantizations)
        return list(m.available_quantizations)

    @staticmethod
    def _serialize_model(m: ModelInfo, is_cuda: bool) -> dict[str, object]:
        """Serialize one model row, mirroring the quant filter into the size
        map so the renderer only sees bytes for quants it'll actually show."""
        quants = ModelCatalog._quants_for(m, is_cuda)
        sizes = {quant: byte_count for quant, byte_count in m.size_bytes_by_quantization.items() if quant in quants}
        return {
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
            "size_bytes_by_quantization": sizes,
            "available": m.available,
            "error_message": m.error_message,
            "local_path": m.local_path,
            "sha256": m.sha256,
            "wer": m.wer,
            "rtfx": m.rtfx,
            "accuracy_score": _accuracy_score(m.wer),
            "speed_score": _speed_score(m.rtfx),
        }

    def to_dicts(
        self,
        *,
        device: str | None = None,
        accelerator: str | None = None,
    ) -> list[dict[str, object]]:
        """Serialize the catalog for the frontend.

        When ``device == "cuda"`` or ``accelerator == "cuda"``,
        ``available_quantizations`` is filtered to those CUDA-EP can
        actually accelerate (only fp32 and fp16) — sub-fp16 quants either
        silently fall back to fp32 or hallucinate on CUDA (see
        :data:`_GPU_COMPATIBLE_QUANTIZATIONS`). Hiding them in the picker
        stops users picking a "faster" quantization that is in fact slower
        AND less accurate.

        DirectML / ROCm / CoreML do NOT filter the per-quant list —
        :data:`_DML_INCOMPATIBLE_FAMILIES` models are routed to CPU EP by
        the bootstrap regardless of accelerator setting, so every published
        quant remains valid (it runs on CPU). Whisper / Moonshine families
        run on DML directly with the full quant list.
        """
        is_cuda = any([device == "cuda", accelerator == "cuda"])
        return [self._serialize_model(m, is_cuda) for m in self._models.values()]
