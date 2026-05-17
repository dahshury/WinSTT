"""Resource-aware fitness assessment for dictation + Ollama models.

The picker's job changed: the old check compared an estimated model
footprint against *static totals* (total RAM, total VRAM). That's enough
to flag a model that simply can't run on a host, but it misses the real
operational question: "Will this fit given what's already loaded?" —
which is exactly the question that matters when the user is mid-session
and considering switching dictation models, or stacking an Ollama LLM on
top of an already-loaded Whisper.

This module produces *Assessments* — small dataclasses describing
whether a candidate model fits, where it would run, how much headroom
remains, and why (i18n-stable reason codes the renderer maps to strings).

Severity rules:
    critical = required > available                  (definitely won't fit)
    warning  = required > available * WARNING_THRESHOLD  (very tight)
    ok       = comfortable headroom remains

Footprint per quantization (rough, conservative):
    ""    (fp32)   → params * 4
    fp16           → params * 2
    int8 / q4 /    → params * 1.2   (weights ~1 B/param + activations)
    q4f16 / bnb4

GPU compatibility filters which quantizations actually run on CUDA-EP;
sub-fp16 quants either run slow via QDQ scatter or hallucinate (see
``model_registry._GPU_COMPATIBLE_QUANTIZATIONS``).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src.recorder.domain.model_registry import ModelCatalog, ModelInfo
from src.recorder.infrastructure.live_resources import LiveResources, get_live_resources

#: Quantization suffixes ORT's CUDAExecutionProvider can actually accelerate.
#: Per Optimum's GPU guide and ORT quantization docs, CUDA-EP can't fuse Q/DQ
#: nodes — int8 / uint8 / q4 / q4f16 / bnb4 all fall back to fp32 compute via
#: QDQ scatter-gather (slower than plain fp32) and the per-channel int8 path
#: has a known Whisper-encoder bug that produces hallucinated output. Only
#: fp32 ("") and fp16 are real CUDA wins. Defined here rather than imported
#: from ``model_registry`` so this module stays usable even when the catalog
#: shape evolves (the GPU-compat heuristic is a per-runtime fact, not a
#: per-catalog fact).
_GPU_COMPATIBLE_QUANTIZATIONS: frozenset[str] = frozenset({"", "fp32", "fp16"})

# ─── Public enums ────────────────────────────────────────────────────────


class FitSeverity(str, Enum):
    """Render-side severity for a fitness verdict.

    ``ok`` — render no badge.
    ``warning`` — inline ⚠ chip, no modal.
    ``critical`` — inline ⛔ chip + post-selection modal that requires
    "Proceed anyway".
    """

    OK = "ok"
    WARNING = "warning"
    CRITICAL = "critical"


class FitTarget(str, Enum):
    """Which device the candidate would run on (if it fits)."""

    GPU = "gpu"
    CPU = "cpu"
    NEITHER = "neither"


class FitReason(str, Enum):
    """Stable i18n keys for why a verdict was reached.

    Multiple reasons can apply per assessment (e.g. a candidate that's
    GPU-incompatible *and* too large for CPU yields ``REQUIRES_CPU_QUANT``
    plus ``EXCEEDS_RAM``). The renderer joins them into the modal body.
    """

    EXCEEDS_VRAM = "exceeds_vram"
    EXCEEDS_RAM = "exceeds_ram"
    TIGHT_VRAM = "tight_vram"
    TIGHT_RAM = "tight_ram"
    NO_GPU_AVAILABLE = "no_gpu_available"
    REQUIRES_CPU_QUANT = "requires_cpu_quant"  # quant can't accelerate on CUDA
    STT_ALREADY_USES_GPU = "stt_already_uses_gpu"
    STT_ALREADY_USES_RAM = "stt_already_uses_ram"
    UNKNOWN_FOOTPRINT = "unknown_footprint"
    OK = "ok"


# ─── Tunables ────────────────────────────────────────────────────────────

#: Severity boundary: `required > available * 0.8` is a "warning"; equal
#: or higher than available is "critical". 80% leaves enough headroom for
#: KV cache, activations, OS work and per-app driver overheads.
WARNING_THRESHOLD = 0.8

#: Rough bytes-per-parameter by quantization. The default fp32 export is
#: ``params * 4``; fp16 halves that; sub-fp16 quants are roughly 1 B/param
#: plus a small activation bump (the runtime never matches "1 byte per
#: param" exactly because activation tensors live in fp32 even when
#: weights are int8).
_BYTES_PER_PARAM_BY_QUANT: dict[str, float] = {
    "": 4.0,
    "fp32": 4.0,
    "fp16": 2.0,
    "int8": 1.2,
    "uint8": 1.2,
    "q4": 0.75,
    "q4f16": 0.75,
    "bnb4": 0.75,
}

#: Fraction of system RAM treated as usable for new model loads. The OS,
#: page cache, and other apps need the remainder. Matches the existing
#: Ollama heuristic so cross-checks line up.
_RAM_USABLE_FRACTION = 0.7

#: Padding bytes added to every dictation footprint estimate for KV cache,
#: encoder activations, and ORT scratch. Conservative enough to absorb
#: model-specific variance without making tiny models look huge.
_DICTATION_OVERHEAD_BYTES = 500_000_000  # 500 MB

#: Padding for Ollama (KV cache grows with context; 1 GB is a realistic
#: floor for typical 4k–8k context defaults).
_OLLAMA_OVERHEAD_BYTES = 1_000_000_000  # 1 GB

#: GGUF on-disk size doesn't exactly equal runtime weight footprint; bump
#: by 20% to match what we see for the recommended-model list.
_OLLAMA_SIZE_HEADROOM_FACTOR = 1.2


# ─── Assessment dataclasses ──────────────────────────────────────────────


@dataclass(frozen=True)
class DictationFitAssessment:
    """Server-authoritative answer for "can I load this dictation model?".

    ``available_bytes`` is the resource budget on ``target`` *after*
    subtracting already-loaded models. ``required_bytes`` is the
    candidate's own footprint at the requested quantization.
    """

    severity: FitSeverity
    target: FitTarget
    required_bytes: int
    available_bytes: int
    reasons: tuple[FitReason, ...]


@dataclass(frozen=True)
class OllamaFitAssessment:
    """Server-authoritative answer for "can I load this Ollama model?".

    Mirrors the existing client-side ``assessOllamaFit`` shape but accepts
    a live snapshot + already-loaded dictation footprint so the verdict
    is honest about stacking an LLM on top of a Whisper that's already
    eating VRAM.
    """

    severity: FitSeverity
    target: FitTarget
    required_bytes: int
    available_bytes: int
    reasons: tuple[FitReason, ...]


# ─── Footprint computation ───────────────────────────────────────────────


def estimate_runtime_bytes(model: ModelInfo, quantization: str = "") -> int:
    """Return the estimated resident bytes for ``model`` at ``quantization``.

    Returns 0 when ``model.param_count`` is non-positive — the renderer
    treats 0 as "unknown, don't warn".
    """
    if model.param_count <= 0:
        return 0
    factor = _BYTES_PER_PARAM_BY_QUANT.get(quantization, 4.0)
    return int(model.param_count * factor) + _DICTATION_OVERHEAD_BYTES


def predicted_target(
    quantization: str,
    *,
    requested_device: str | None,
    live: LiveResources,
) -> FitTarget:
    """Where the candidate would actually run.

    Rules:
      - User explicitly chose ``cpu`` → CPU.
      - No GPU detected → CPU.
      - Quantization isn't CUDA-compatible (``int8`` / ``q4`` / etc.) → CPU.
      - Otherwise → GPU.

    ``auto`` and ``None`` mean "prefer GPU if available". Returns ``NEITHER``
    only when there's literally no host budget (zero RAM and zero GPU) —
    a defensive value the renderer maps to a hard error.
    """
    if live.ram_total_bytes <= 0 and not live.gpus:
        return FitTarget.NEITHER
    if requested_device == "cpu":
        return FitTarget.CPU
    if not live.gpus:
        return FitTarget.CPU
    if quantization not in _GPU_COMPATIBLE_QUANTIZATIONS:
        return FitTarget.CPU
    return FitTarget.GPU


def _largest_gpu(live: LiveResources) -> tuple[int, int]:
    """Return ``(total, free)`` VRAM bytes of the largest reporting GPU."""
    if not live.gpus:
        return (0, 0)
    biggest = max(live.gpus, key=lambda g: g.total_vram_bytes)
    return (biggest.total_vram_bytes, biggest.free_vram_bytes)


def _loaded_dictation_footprint(
    *,
    catalog: ModelCatalog,
    loaded_main: str | None,
    loaded_main_quant: str | None,
    loaded_realtime: str | None,
    loaded_realtime_quant: str | None,
    exclude_id: str | None,
) -> int:
    """Sum the footprints of currently loaded dictation models.

    ``exclude_id`` lets a model swap subtract the *outgoing* model: when
    the user is replacing the main model, the candidate isn't stacking
    on top of itself.
    """
    total = 0
    for model_id, quant in (
        (loaded_main, loaded_main_quant or ""),
        (loaded_realtime, loaded_realtime_quant or ""),
    ):
        if not model_id or model_id == exclude_id:
            continue
        info = catalog.get(model_id)
        if info is None:
            continue
        total += estimate_runtime_bytes(info, quant)
    return total


# ─── Dictation assessment ────────────────────────────────────────────────


def assess_dictation_fit(
    candidate_id: str,
    *,
    catalog: ModelCatalog | None = None,
    candidate_quant: str = "",
    requested_device: str | None = None,
    loaded_main: str | None = None,
    loaded_main_quant: str | None = None,
    loaded_realtime: str | None = None,
    loaded_realtime_quant: str | None = None,
    live: LiveResources | None = None,
) -> DictationFitAssessment:
    """Assess whether ``candidate_id`` will fit given the current host load.

    The candidate is treated as *replacing* the same slot it would land
    in: if the user is changing the main model from ``A`` to ``B``, A's
    footprint isn't counted (it'll be unloaded). The realtime model is
    always counted unless it happens to be the same id as the candidate.
    """
    cat = catalog if catalog is not None else ModelCatalog()
    snap = live if live is not None else get_live_resources()
    info = cat.get(candidate_id)
    if info is None:
        return DictationFitAssessment(
            severity=FitSeverity.CRITICAL,
            target=FitTarget.NEITHER,
            required_bytes=0,
            available_bytes=0,
            reasons=(FitReason.UNKNOWN_FOOTPRINT,),
        )

    required = estimate_runtime_bytes(info, candidate_quant)
    if required <= 0:
        # Unknown footprint — don't warn. Treat as ok on the predicted target.
        return DictationFitAssessment(
            severity=FitSeverity.OK,
            target=predicted_target(candidate_quant, requested_device=requested_device, live=snap),
            required_bytes=0,
            available_bytes=0,
            reasons=(FitReason.UNKNOWN_FOOTPRINT,),
        )

    target = predicted_target(candidate_quant, requested_device=requested_device, live=snap)
    reasons: list[FitReason] = []

    # Quant-routing rationale — the picker reads this even when the verdict
    # is OK ("we put you on CPU because int8 doesn't accelerate on CUDA").
    if snap.gpus and candidate_quant not in _GPU_COMPATIBLE_QUANTIZATIONS:
        reasons.append(FitReason.REQUIRES_CPU_QUANT)
    if not snap.gpus and requested_device != "cpu":
        reasons.append(FitReason.NO_GPU_AVAILABLE)

    loaded_other = _loaded_dictation_footprint(
        catalog=cat,
        loaded_main=loaded_main,
        loaded_main_quant=loaded_main_quant,
        loaded_realtime=loaded_realtime,
        loaded_realtime_quant=loaded_realtime_quant,
        exclude_id=candidate_id,
    )

    if target == FitTarget.GPU:
        total_vram, free_vram = _largest_gpu(snap)
        # The "loaded other" models on a GPU host are also resident in VRAM,
        # but free_vram_bytes already accounts for that (driver reports the
        # actual free amount). We do NOT subtract loaded_other from free_vram
        # because doing so would double-count.
        available = free_vram
        if loaded_other > 0:
            reasons.append(FitReason.STT_ALREADY_USES_GPU)
        severity = _severity_for(required, available)
        if severity == FitSeverity.CRITICAL:
            reasons.append(FitReason.EXCEEDS_VRAM)
        elif severity == FitSeverity.WARNING:
            reasons.append(FitReason.TIGHT_VRAM)
        else:
            reasons.append(FitReason.OK)
        # Defensive: if no live data at all, fall back to total VRAM
        # comparison so we still produce a verdict.
        if available <= 0 and total_vram > 0:
            available = total_vram
        return DictationFitAssessment(
            severity=severity,
            target=target,
            required_bytes=required,
            available_bytes=available,
            reasons=tuple(reasons),
        )

    if target == FitTarget.CPU:
        usable_total = int(snap.ram_total_bytes * _RAM_USABLE_FRACTION)
        # On CPU, loaded RAM IS additive — psutil.available already reflects
        # what other apps are using, but the model swap doesn't free the
        # outgoing model's RAM until the swap completes. We treat
        # ram_available as the floor and additionally subtract our own
        # already-loaded models (those whose footprint *is* counted in
        # "available" but only because they exist; the candidate needs
        # space NEXT TO them during the swap).
        live_available = snap.ram_available_bytes
        # Pick the more conservative of (live_available, usable_total)
        # then subtract any extra models we know we're keeping resident.
        budget = min(live_available, usable_total) if live_available > 0 else usable_total
        available = max(0, budget - loaded_other)
        if loaded_other > 0:
            reasons.append(FitReason.STT_ALREADY_USES_RAM)
        severity = _severity_for(required, available)
        if severity == FitSeverity.CRITICAL:
            reasons.append(FitReason.EXCEEDS_RAM)
        elif severity == FitSeverity.WARNING:
            reasons.append(FitReason.TIGHT_RAM)
        else:
            reasons.append(FitReason.OK)
        return DictationFitAssessment(
            severity=severity,
            target=target,
            required_bytes=required,
            available_bytes=available,
            reasons=tuple(reasons),
        )

    # FitTarget.NEITHER — no resources at all (unusual; defensive)
    return DictationFitAssessment(
        severity=FitSeverity.CRITICAL,
        target=FitTarget.NEITHER,
        required_bytes=required,
        available_bytes=0,
        reasons=(FitReason.EXCEEDS_RAM,),
    )


# ─── Ollama assessment ───────────────────────────────────────────────────


def assess_ollama_fit(
    size_bytes: int,
    *,
    catalog: ModelCatalog | None = None,
    loaded_main: str | None = None,
    loaded_main_quant: str | None = None,
    loaded_realtime: str | None = None,
    loaded_realtime_quant: str | None = None,
    live: LiveResources | None = None,
) -> OllamaFitAssessment:
    """Assess whether an Ollama model of ``size_bytes`` will fit on top of STT.

    Ollama prefers GPU if available; otherwise falls back to CPU. The
    candidate's required footprint is ``size_bytes * 1.2 + 1 GB`` — the
    headroom factor accounts for KV cache and activations beyond the raw
    weight file.

    ``loaded_main`` / ``loaded_realtime`` are the dictation models
    currently in memory. On a GPU host, ``free_vram_bytes`` already
    reflects what they're using; on a CPU host, we additionally subtract
    their footprint from the RAM budget since the dictation models are
    resident in RAM and unlikely to be evicted.
    """
    snap = live if live is not None else get_live_resources()
    if size_bytes <= 0:
        return OllamaFitAssessment(
            severity=FitSeverity.OK,
            target=FitTarget.NEITHER,
            required_bytes=0,
            available_bytes=0,
            reasons=(FitReason.UNKNOWN_FOOTPRINT,),
        )
    required = int(size_bytes * _OLLAMA_SIZE_HEADROOM_FACTOR) + _OLLAMA_OVERHEAD_BYTES
    cat = catalog if catalog is not None else ModelCatalog()
    loaded_other = _loaded_dictation_footprint(
        catalog=cat,
        loaded_main=loaded_main,
        loaded_main_quant=loaded_main_quant,
        loaded_realtime=loaded_realtime,
        loaded_realtime_quant=loaded_realtime_quant,
        exclude_id=None,
    )

    reasons: list[FitReason] = []
    # Try GPU first
    if snap.gpus:
        total_vram, free_vram = _largest_gpu(snap)
        available = free_vram if free_vram > 0 else total_vram
        if loaded_other > 0:
            reasons.append(FitReason.STT_ALREADY_USES_GPU)
        if required <= available:
            severity = FitSeverity.WARNING if required > available * WARNING_THRESHOLD else FitSeverity.OK
            reasons.append(FitReason.TIGHT_VRAM if severity == FitSeverity.WARNING else FitReason.OK)
            return OllamaFitAssessment(
                severity=severity,
                target=FitTarget.GPU,
                required_bytes=required,
                available_bytes=available,
                reasons=tuple(reasons),
            )
        # Doesn't fit on GPU. Ollama would offload partial layers to CPU
        # with a major speed cliff — we surface this as a critical VRAM
        # shortfall, matching the existing client-side behavior.
        reasons.append(FitReason.EXCEEDS_VRAM)
        return OllamaFitAssessment(
            severity=FitSeverity.CRITICAL,
            target=FitTarget.NEITHER,
            required_bytes=required,
            available_bytes=available,
            reasons=tuple(reasons),
        )

    # No GPU — CPU path
    usable_total = int(snap.ram_total_bytes * _RAM_USABLE_FRACTION)
    live_available = snap.ram_available_bytes
    budget = min(live_available, usable_total) if live_available > 0 else usable_total
    available = max(0, budget - loaded_other)
    if loaded_other > 0:
        reasons.append(FitReason.STT_ALREADY_USES_RAM)
    severity = _severity_for(required, available)
    if severity == FitSeverity.CRITICAL:
        reasons.append(FitReason.EXCEEDS_RAM)
        target = FitTarget.NEITHER
    elif severity == FitSeverity.WARNING:
        reasons.append(FitReason.TIGHT_RAM)
        target = FitTarget.CPU
    else:
        reasons.append(FitReason.OK)
        target = FitTarget.CPU
    return OllamaFitAssessment(
        severity=severity,
        target=target,
        required_bytes=required,
        available_bytes=available,
        reasons=tuple(reasons),
    )


# ─── Severity helper ─────────────────────────────────────────────────────


def _severity_for(required: int, available: int) -> FitSeverity:
    """Three-tier verdict from required + available bytes."""
    if available <= 0:
        return FitSeverity.CRITICAL
    if required > available:
        return FitSeverity.CRITICAL
    if required > available * WARNING_THRESHOLD:
        return FitSeverity.WARNING
    return FitSeverity.OK


# ─── Serialisation helpers ───────────────────────────────────────────────


def dictation_fit_dict(a: DictationFitAssessment) -> dict[str, object]:
    """Wire-format a dictation assessment for the WS payload."""
    return {
        "severity": a.severity.value,
        "target": a.target.value,
        "required_bytes": a.required_bytes,
        "available_bytes": a.available_bytes,
        "reasons": [r.value for r in a.reasons],
    }


def ollama_fit_dict(a: OllamaFitAssessment) -> dict[str, object]:
    """Wire-format an Ollama assessment for the WS payload."""
    return {
        "severity": a.severity.value,
        "target": a.target.value,
        "required_bytes": a.required_bytes,
        "available_bytes": a.available_bytes,
        "reasons": [r.value for r in a.reasons],
    }
