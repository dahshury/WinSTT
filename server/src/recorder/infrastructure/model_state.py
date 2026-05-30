"""Aggregate model catalog + cache state + hardware fitness for the UI.

The render-time question is: "for this model, is it downloaded, partial,
or missing — and will it run comfortably on my hardware?". This module
wraps the catalog with HF cache probes (``model_cache.probe_cache_state``)
and system-info-driven fitness heuristics so the WS handler can serve
that whole payload in a single command.

Fitness heuristic:
  - estimate resident bytes = ``param_count`` (int8 quantization, 1 B/param)
    or ``param_count * 4`` for full-precision exports
  - GPU comfortable: ``vram_total >= estimate * 1.5``
  - CPU comfortable: ``ram_total >= estimate * 2``
  - "uncomfortable" surfaces a warning sign in the selector; the user
    can still pick it (we don't refuse a load, just inform)

Conservative numbers — int8 is the typical onnx-asr quantization choice
in our catalog. The user picks ``onnx_quantization`` at recorder boot;
we don't currently re-fit on that change but the heuristic is generous
enough that fp32 catches the same downgrade tier.
"""

from __future__ import annotations

from typing import Any

from src.recorder.domain.model_registry import ModelInfo
from src.recorder.infrastructure.model_cache import (
    ModelCacheState,
    probe_cache_state,
    probe_cache_state_by_quantization,
    resolve_hf_repo,
    would_download_on_load,
)
from src.recorder.infrastructure.system_info import SystemInfo, get_system_info

#: int8 quantization uses ~1 byte/param + activations. Round up a bit so
#: the fitness check is conservative; over-warning is better than the
#: opposite.
_BYTES_PER_PARAM_INT8 = 1.5
#: Multiplier of resident bytes required for "comfortable" — gives the
#: model headroom for activations, scratch buffers, and concurrent OS work.
_GPU_HEADROOM = 1.5
_CPU_HEADROOM = 2.0


def estimate_runtime_bytes(model: ModelInfo) -> int:
    """Rough resident-bytes estimate for ``model`` under int8 quantization.

    Returns 0 when ``param_count`` is unknown — the caller renders no
    fitness warning in that case (we don't want to scare users away
    from models we can't size).
    """
    if model.param_count <= 0:
        return 0
    return int(model.param_count * _BYTES_PER_PARAM_INT8)


def is_comfortable_on_gpu(model: ModelInfo, sys_info: SystemInfo | None = None) -> bool:
    """True iff every reporting GPU has VRAM >= estimate * _GPU_HEADROOM."""
    si = sys_info if sys_info is not None else get_system_info()
    if not si.gpus:
        return False
    needed = estimate_runtime_bytes(model)
    if needed <= 0:
        return True
    return all(g.total_vram_bytes >= needed * _GPU_HEADROOM for g in si.gpus)


def is_comfortable_on_cpu(model: ModelInfo, sys_info: SystemInfo | None = None) -> bool:
    """True iff total system RAM >= estimate * _CPU_HEADROOM."""
    si = sys_info if sys_info is not None else get_system_info()
    needed = estimate_runtime_bytes(model)
    if needed <= 0:
        return True
    if si.total_ram_bytes <= 0:
        return True  # RAM detection failed — don't warn; we don't know
    return si.total_ram_bytes >= needed * _CPU_HEADROOM


def model_state_dict(
    model: ModelInfo,
    sys_info: SystemInfo | None = None,
    *,
    effective_quantization: str = "",
) -> dict[str, Any]:
    """Bundle the catalog entry, cache state, and fitness for ``model``.

    Returned dict shape (consumed by the renderer's model picker):
      - ``id``: catalog id
      - ``cache``: ``{"state", "downloaded_bytes", "total_bytes", "progress"}``
        — overall (any variant present)
      - ``cache_by_quantization``: ``{quant: cache_dict}`` per precision;
        ``{}`` for legacy aliases without an HF repo
      - ``available_quantizations``: precisions the upstream repo ships
      - ``effective_quantization``: the precision the server will ACTUALLY
        load for this model given the current ``onnx_quantization`` setting.
        The auto/default sentinel (``""``) is re-resolved per model — NeMo /
        Cohere / GigaAM / Kaldi / SenseVoice families load as ``int8`` on
        non-CUDA accelerators even on ``auto``. The picker keys its
        "downloaded?" decision off THIS precision so a model whose default
        export is cached but whose effective ``int8`` weights aren't no
        longer paints a green badge and then silently re-downloads on swap.
        Resolved by the caller (control_handler) via ``_resolve_quantization``
        so this module stays free of the bootstrap dependency.
      - ``estimated_bytes``: resident-bytes estimate at int8
      - ``comfortable_on_gpu`` / ``comfortable_on_cpu``: bool
    """
    si = sys_info if sys_info is not None else get_system_info()
    per_quant = _per_quant_states(model)
    # "Downloaded" at the model level means "the precision that will actually
    # load is ready" — i.e. the EFFECTIVE quant (auto→int8 for the int8-pre-
    # ferred families). Falling back to the overall heuristic only when the
    # effective precision has no entry (legacy aliases with no HF repo).
    overall = per_quant.get(effective_quantization) or _verify_quant_cache(
        model, effective_quantization, _cache_state_for(model)
    )
    return {
        "id": model.id,
        "cache": _cache_dict(overall),
        "cache_by_quantization": {quant: _cache_dict(state) for quant, state in per_quant.items()},
        "available_quantizations": model.available_quantizations,
        "effective_quantization": effective_quantization,
        "estimated_bytes": estimate_runtime_bytes(model),
        "comfortable_on_gpu": is_comfortable_on_gpu(model, si),
        "comfortable_on_cpu": is_comfortable_on_cpu(model, si),
    }


def _cache_dict(state: ModelCacheState) -> dict[str, Any]:
    return {
        "state": state.state,
        "downloaded_bytes": state.downloaded_bytes,
        "total_bytes": state.total_bytes,
        "progress": state.progress,
    }


def _per_quant_states(model: ModelInfo) -> dict[str, ModelCacheState]:
    """Per-precision cache state, keyed by quantization suffix (``""`` = default).

    Each entry is the fast ``*.onnx`` glob heuristic, then VERIFIED against the
    loader's own resolver (:func:`_verify_quant_cache`) so a "cached" verdict
    can never hide a missing required file. Empty for catalog entries with no
    HF repo (legacy aliases) — the UI falls back to the flat ``cache`` field.
    """
    hf_repo = resolve_hf_repo(model.onnx_model_name)
    if hf_repo is None:
        return {}
    heuristic = probe_cache_state_by_quantization(hf_repo, model.available_quantizations)
    return {quant: _verify_quant_cache(model, quant, state) for quant, state in heuristic.items()}


def _verify_quant_cache(model: ModelInfo, quantization: str, state: ModelCacheState) -> ModelCacheState:
    """Reconcile the fast ``*.onnx`` glob heuristic with the loader's OWN
    resolver, which knows this precision's EXACT required file set.

    Two corrections, both driven by :func:`would_download_on_load` (the single
    source of truth for "would a load fetch anything?"):

    - heuristic ``"cached"`` but the resolver WOULD download → demote to
      ``"partial"`` so a swap can't silently background-fetch a missing required
      file (vocab / second decoder graph / ``.onnx_data`` shard).
    - heuristic ``"partial"`` but the resolver would NOT download → upgrade to
      ``"cached"``. The heuristic's ``partial`` is often a FALSE alarm: the
      repo-wide ``.incomplete`` / ``.partial`` blob scan in
      :func:`~....model_cache._state_from_weight_files` can't attribute a marker
      to a precision, so ONE abandoned download (e.g. an old quant's orphan
      ``.incomplete``) makes EVERY precision of that repo read ``partial`` — even
      ones whose files are all present. The resolver checks THIS precision's
      files only, so it clears the false alarm. A genuinely-incomplete (or
      actively-downloading) precision still has a missing file → the resolver
      returns ``True`` → it stays ``partial``.

    ``not_cached`` is left untouched (no files on disk → a load always
    downloads; no point paying for the resolver). ``None`` (undeterminable)
    leaves the heuristic verdict as-is.
    """
    if state.state == "not_cached":
        return state
    would_download = would_download_on_load(
        model.onnx_model_name,
        local_path=model.local_path,
        quantization=quantization,
    )
    if state.state == "cached" and would_download is True:
        return ModelCacheState(
            state="partial",
            downloaded_bytes=state.downloaded_bytes,
            total_bytes=max(state.total_bytes, state.downloaded_bytes + 1),
        )
    if state.state == "partial" and would_download is False:
        return ModelCacheState(
            state="cached",
            downloaded_bytes=state.downloaded_bytes,
            total_bytes=state.downloaded_bytes,
        )
    return state


def _cache_state_for(model: ModelInfo) -> ModelCacheState:
    """Probe HF cache for ``model``. Falls back to ``not_cached`` on unknown HF ids."""
    hf_repo = resolve_hf_repo(model.onnx_model_name)
    if hf_repo is None:
        # Catalog entries without an HF repo (legacy aliases) can't be
        # cached in the HF hub sense. Render as not_cached so the UI
        # at least won't claim they're ready.
        return ModelCacheState(state="not_cached")
    return probe_cache_state(hf_repo)


def system_info_dict(sys_info: SystemInfo | None = None) -> dict[str, Any]:
    """Serialise SystemInfo to a dict for the WS payload."""
    si = sys_info if sys_info is not None else get_system_info()
    return {
        "total_ram_bytes": si.total_ram_bytes,
        "gpus": [{"name": g.name, "total_vram_bytes": g.total_vram_bytes} for g in si.gpus],
    }
