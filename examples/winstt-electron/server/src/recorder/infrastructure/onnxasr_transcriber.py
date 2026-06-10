from __future__ import annotations

import gzip
import json
import logging
import os
import re
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

import numpy as np
from typing_extensions import override

from src.building_blocks.types import AudioArray
from src.recorder.domain.events import DownloadProgress
from src.recorder.domain.ports.transcriber import ITranscriber, TranscriptionResult
from src.recorder.infrastructure.device import GPU_PROVIDERS

logger = logging.getLogger(__name__)

try:
    import onnx_asr
except ImportError:
    onnx_asr = None  # type: ignore[assignment]

# Decoder-side safety patches (consecutive-repeat guard for Canary AED +
# Cohere; suppress_blank / suppress_non_speech / no_speech_thold for
# Whisper; audio-aware max_length cap for Moonshine). Side effect of the
# import: ``apply_onnx_decoder_patches()`` runs at module load. Idempotent
# across import order. The module also exposes the
# ``maybe_pad_for_aed`` / ``maybe_prepend_silence_for_parakeet`` helpers
# used in ``_recognize`` below.
from src.recorder.infrastructure import onnx_decoder_patches  # noqa: E402

# ── Shared Silero VAD cache ────────────────────────────────────────────
#
# Silero is small (~3MB) but loading it into a fresh ORT session takes
# 100-400ms with CUDA (kernel JIT + provider init). Every previous swap
# paid that cost because the VAD was owned by the OnnxAsrTranscriber
# and went away with its ``shutdown()``. The cache below pins one
# instance per provider tuple so subsequent main-model swaps reuse it
# verbatim — first swap loads, every later swap on the same device hits
# the cache for free.
#
# Eviction is by provider key: switching CPU↔GPU (or changing the CUDA
# ordinals) creates a new ORT session bound to the new providers, so
# the entries are independent. The cached VAD stays alive for the
# process lifetime — the OS reclaims it at exit. ``_close_cached_vads``
# is exposed for tests that need a clean slate between cases.
_VAD_CACHE: dict[tuple[Any, ...], Any] = {}
_VAD_CACHE_LOCK = threading.Lock()

# Silero VAD is unconditionally loaded on CPU regardless of the parent
# transcriber's execution provider. Two reasons, in this order:
#
# 1. **Deadlock avoidance.** When the main transcriber session is created
#    on CUDA with ``do_copy_in_default_stream=1`` (see
#    ``device._CUDA_EP_OPTIONS``), routing Silero's load through the same
#    CUDA EP forces its weight-upload Memcpy onto the *same default
#    stream* the main session is still holding work on. ORT's session
#    create then waits for a memcpy that cannot dispatch — silent hang,
#    no exception, ``Recorder initialized`` never prints, the renderer
#    is pinned to "Reconnecting" forever. This was the live regression
#    triaged via the architect-mode investigation.
#
# 2. **Pure performance.** Silero v5's ONNX graph has at least one node
#    (the stateful LSTM tail) with no CUDA kernel; ORT inserts a
#    host↔device Memcpy to fall back. For a ~2 MB model running once per
#    32 ms hop, the PCIe round trip costs more than the entire forward
#    pass would on CPU. The facade's CompositeVAD Silero instance has
#    been pinned to CPU for this exact reason since the hexagonal rewrite
#    (recorder/__init__.py:443-448). We now unify the policy so both load
#    paths obey the same invariant — single source of truth.
#
# The cache is keyed by a constant sentinel since there is only ever one
# CPU-bound Silero instance per process. Tests that need a clean slate
# between cases call ``_close_cached_vads``.
_SILERO_CPU_PROVIDERS: tuple[str, ...] = ("CPUExecutionProvider",)
_SILERO_CACHE_KEY: tuple[str, ...] = _SILERO_CPU_PROVIDERS


def _vad_cache_key(providers_tuple: tuple[Any, ...] | None) -> tuple[Any, ...]:
    """Stable cache key for the Silero VAD. The argument is accepted for
    backwards-compat with call sites that pass the parent transcriber's
    providers, but is *ignored* — we always return the CPU key per the
    pinning rationale on :data:`_SILERO_CACHE_KEY`.
    """
    del providers_tuple  # intentionally unused; see module-level note
    return _SILERO_CACHE_KEY


def _get_or_load_silero_vad(providers_tuple: tuple[Any, ...] | None) -> Any:  # noqa: ANN401
    """Return the singleton CPU-bound Silero VAD, loading on first miss.

    The ``providers_tuple`` argument is accepted for backwards-compat with
    legacy call sites that thread the parent transcriber's providers
    through, but it is **ignored** — Silero is always loaded on
    ``CPUExecutionProvider`` regardless (see :data:`_SILERO_CACHE_KEY`).

    Concurrency: ``_VAD_CACHE_LOCK`` is held across the cache lookup +
    the load itself, so two transcribers constructed simultaneously
    can't double-load. The lock blocks for the full ``onnx_asr.load_vad``
    duration on a miss (100-400ms) — acceptable because the alternative
    is racy double-allocation in RAM.
    """
    del providers_tuple  # intentionally unused; Silero is always CPU
    assert onnx_asr is not None  # narrowing — caller has already checked
    with _VAD_CACHE_LOCK:
        cached = _VAD_CACHE.get(_SILERO_CACHE_KEY)
        if cached is not None:
            logger.info("Silero VAD cache hit (CPU)")
            return cached
        logger.info("Silero VAD cache miss — loading on CPU")
        vad = onnx_asr.load_vad("silero", providers=_SILERO_CPU_PROVIDERS)
        _VAD_CACHE[_SILERO_CACHE_KEY] = vad
        logger.info("Silero VAD loaded + cached (CPU)")
        return vad


def _close_cached_vads() -> None:
    """Drop the entire VAD cache. Test-only; production process exits drop it."""
    with _VAD_CACHE_LOCK:
        for vad in _VAD_CACHE.values():
            if hasattr(vad, "close"):
                try:
                    vad.close()
                except Exception:
                    logger.exception("Cached VAD close raised")
        _VAD_CACHE.clear()


#: Matches ORT's complaint about onnx-community Whisper fp16 merged-decoder
#: exports. The file path is embedded right in the message, so we lift it
#: out and feed it to :func:`patch_whisper_decoder` for a one-shot retry.
_FP16_DECODER_LOAD_ERROR = re.compile(
    r"Load model from (.+?\.onnx) failed:.*Subgraph output.*outer scope value",
    re.DOTALL,
)


def _extract_fp16_whisper_decoder_path(exc: BaseException) -> Path | None:
    """Return the malformed decoder path from an ORT load error, or ``None``.

    Only returns a path when the file name matches Whisper's merged-decoder
    naming (``decoder_model_merged*.onnx``) — guards against patching some
    unrelated future error that happens to mention "Subgraph output".
    """
    match = _FP16_DECODER_LOAD_ERROR.search(str(exc))
    if not match:
        return None
    path = Path(match.group(1))
    if not path.name.startswith("decoder_model_merged"):
        return None
    return path


#: ORT's signature for a missing external-data sidecar — the case where
#: the ``.onnx`` graph landed during an HF download but the ``.onnx.data``
#: (or ``.onnx_data``) weights file didn't. Matched substring-wise so
#: minor wording changes in future ORT releases don't break the recovery.
_EXTERNAL_DATA_MISSING_MARKER = "External data path does not exist"

#: A path that looks like an ONNX external-data sidecar — base form
#: (``.onnx.data`` / ``.onnx_data``) or a >2 GB sharded form
#: (``.onnx_data_1``, ``.onnx.data_2``, …). The shard suffix is what bit
#: cohere-transcribe fp16: its encoder spills across two sidecars but only
#: the first downloaded, so ORT failed to stat ``encoder_model_fp16.onnx_data_1``.
_ONNX_EXTERNAL_DATA_PATH_RE = re.compile(r"\.onnx[._]data(_\d+)?\b", re.IGNORECASE)

#: File-not-found phrasings ORT bubbles up per platform when a referenced
#: external-data file is absent. The Win32 / ENOENT variants don't contain
#: ``_EXTERNAL_DATA_MISSING_MARKER`` — they surface as a failed ``file_size``
#: call instead — so we match them separately to keep the auto-refetch firing.
_FILE_NOT_FOUND_MARKERS = (
    "The system cannot find the file specified",  # Win32 GetLastError 2 (ERROR_FILE_NOT_FOUND)
    "No such file or directory",  # POSIX ENOENT
    "file_size:",  # ORT's failing call site on a missing sidecar
)


def _is_external_data_missing_error(exc: BaseException) -> bool:
    """True when ``exc`` is the ORT error for a missing external-data sidecar.

    Covers two phrasings:

    1. ORT's own ``External data path does not exist`` (its validation path).
    2. A platform file-not-found (``file_size: The system cannot find the
       file specified`` on Windows, ``No such file or directory`` on POSIX)
       *on a path that is an ONNX external-data sidecar*. ORT raises this
       second form when a sharded ``.onnx_data_N`` weights file is missing
       — the case the original marker-only check silently skipped.
    """
    msg = str(exc)
    if _EXTERNAL_DATA_MISSING_MARKER in msg:
        return True
    return bool(_ONNX_EXTERNAL_DATA_PATH_RE.search(msg)) and any(marker in msg for marker in _FILE_NOT_FOUND_MARKERS)


def _refetch_hf_snapshot(model_name: str) -> bool:
    """Re-run ``snapshot_download`` for ``model_name`` to fill in missing files.

    Resolves the catalog alias to a real HF ``org/repo`` via the same
    upstream table onnx-asr uses (:func:`resolve_hf_repo`), then asks
    ``huggingface_hub`` to ensure every onnx-asr-relevant file is on disk
    (``.onnx`` / ``.onnx.data`` / ``.onnx_data`` / ``config.json`` /
    ``config.yaml``). The HF hub's content-addressable cache makes this a
    no-op for blobs that completed earlier — only the missing sidecar gets
    re-downloaded.

    Returns True when a refetch attempt was made (caller should retry the
    load); False when the repo can't be resolved or ``huggingface_hub``
    isn't importable. Network failures propagate — the caller's existing
    error handling surfaces them as a regular load failure.
    """
    try:
        from huggingface_hub import snapshot_download
    except ImportError:  # pragma: no cover — hf_hub is a hard dependency
        return False
    from src.recorder.infrastructure.model_cache import resolve_hf_repo

    repo = resolve_hf_repo(model_name)
    if repo is None:
        return False
    logger.warning(
        "Partial HF cache for %s detected — re-fetching %s to complete the download",
        model_name,
        repo,
    )
    # Mirror onnx-asr's resolver allow_patterns (resolver.py:_download_model)
    # so we pull the files the resolver expects — PLUS the sharded sidecars
    # it misses. ``*.onnx?data`` covers both istupakov ``.onnx.data`` and
    # onnx-community ``.onnx_data`` single-sidecar conventions; ``*.onnx?data_*``
    # adds the >2 GB sharded form (``.onnx_data_1`` / ``.onnx.data_2`` / …).
    # Upstream's pattern stops at the base sidecar, which is exactly why
    # cohere-transcribe fp16's second encoder shard never downloaded and the
    # load died on a missing ``encoder_model_fp16.onnx_data_1``.
    snapshot_download(
        repo,
        allow_patterns=[
            "*.onnx",
            "*.onnx?data",
            "*.onnx?data_*",
            "config.json",
            "config.yaml",
        ],
    )
    return True


def _pick_intra_op_threads(providers_tuple: tuple[Any, ...] | None) -> int:
    """Pick ``intra_op_num_threads`` based on whether the EP is GPU or CPU.

    ORT's default of 0 means "use all logical cores", which on consumer
    machines causes two failure modes:

    * **CPU EP** — on hybrid CPUs (Intel 12th gen+, Apple M-series, AMD
      with X3D V-Cache, …) all-logical-cores spreads inference across
      P-cores AND E-cores. The E-cores have very different SIMD/latency
      characteristics so they stall the join and turn what should be a
      120 ms run into a 1300 ms one (measured, Alder Lake i9-12900KF:
      intra=0 → 430 ms, intra=8 → 132 ms, intra=10+ → 1200 ms).
    * **GPU EP** — most compute is on device, with only small CPU-side
      ops (preprocessing, beam search). Many CPU threads adds scheduling
      overhead without parallel work to fill them. 2 threads is enough
      for the small CPU pieces and minimizes context-switch tax
      (measured, RTX 3080 Ti + Canary-180M: intra=0 → 33 ms,
      intra=2 → 17 ms, intra=8 → 62 ms).

    The output is byte-identical across all choices — only the host
    scheduler / thread pool changes. Property verified via
    :file:`scripts/bench_sess_opts.py` across Whisper / Moonshine /
    Canary, CPU and CUDA EPs.
    """
    provider_names: list[str] = []
    if providers_tuple:
        for entry in providers_tuple:
            if isinstance(entry, str):
                provider_names.append(entry)
            elif isinstance(entry, tuple) and entry:
                provider_names.append(str(entry[0]))
    if not provider_names:
        # No explicit selection — fall back to ORT's available providers.
        # On packaged Windows builds this is DirectML or CUDA when present,
        # else CPU. Make a sensible guess so the user still benefits.
        try:
            import onnxruntime as rt

            provider_names = list(rt.get_available_providers())
        except Exception:  # pragma: no cover — defensive
            return 2  # safe middle ground

    is_gpu = any(p in GPU_PROVIDERS for p in provider_names)
    if is_gpu:
        return 2

    # CPU EP — cap at 8 to dodge E-core collapse on hybrid CPUs.
    # Floor at 2 so dual-core hosts still oversubscribe slightly.
    import os

    cpu_count = os.cpu_count() or 4
    if cpu_count <= 4:
        return cpu_count
    if cpu_count <= 8:
        return cpu_count
    return 8


def _resolve_optimized_model_cache_dir() -> Path:
    """Return the directory used for ORT optimized-graph dumps.

    Per the platform convention shared with the TTS asset downloader
    (:func:`src.synthesizer.infrastructure.asset_downloader.resolve_cache_dir`),
    Windows defaults to ``%LOCALAPPDATA%/winstt/ort/optimized`` and POSIX
    falls back to ``~/.cache/winstt/ort/optimized``. The ORT runtime
    version is appended as a subdirectory so a bump invalidates the
    cache automatically — see :func:`_optimized_model_path`.

    The directory is created lazily; missing parents are auto-created.
    Failure to create is propagated so the caller can disable the
    optimization rather than silently writing nowhere.
    """
    override = os.environ.get("WINSTT_ORT_CACHE_DIR")
    if override:
        return Path(override).expanduser().resolve()
    appdata = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    base = Path(appdata) if appdata else Path.home() / ".cache"
    return base / "winstt" / "ort" / "optimized"


#: Characters that aren't safe in cross-platform filenames. The HF
#: convention uses ``/`` between org and repo, and onnx-asr aliases sometimes
#: include colons or spaces — collapse all to ``_`` so the resulting filename
#: is safe on every OS we ship to.
_MODEL_ID_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _slug_model_id(model_name: str, quantization: str | None) -> str:
    """Return a filesystem-safe slug uniquely identifying a model+quant pair.

    The slug embeds the quantization tag so e.g. ``whisper-tiny`` int8
    and fp16 don't collide in the cache. Anything that's not
    ``[A-Za-z0-9._-]`` is replaced with ``_``. Leading/trailing
    underscores are stripped so the result is a clean filename stem.
    """
    base = model_name or "unknown"
    quant_tag = (quantization or "default").strip() or "default"
    raw = f"{base}__{quant_tag}"
    return _MODEL_ID_SAFE_RE.sub("_", raw).strip("_") or "unknown"


def _optimized_model_path(model_name: str, quantization: str | None) -> Path | None:
    """Resolve the on-disk path ORT should dump the optimized graph into.

    Returns ``None`` when onnxruntime can't be imported (test envs that
    haven't installed any ORT wheel) or when the cache directory cannot
    be created — the caller leaves ``optimized_model_filepath`` unset
    in that case and just skips the dump.

    Cache layout:
        <cache_dir>/<ort_version>/<model_slug>.ort.bin

    The ORT version is embedded in the path so a wheel upgrade is a
    safe cache miss instead of an incompatible-graph crash. The
    ``.ort.bin`` suffix matches what onnxruntime expects when loading
    optimized-only graphs later. Idempotent — calling twice with the
    same arguments returns the same path.

    Known limitation: onnx_asr internally creates multiple ORT sessions
    (preprocessor, encoder, decoder, decoder_merged) sharing a single
    ``SessionOptions``. With ``optimized_model_filepath`` set, all of
    them write to the same path — only the last write wins. The dump
    is therefore best-effort and primarily useful for diagnostics /
    future per-session redirection rather than as a hot-load cache.
    A clean fix requires per-session SessionOptions in the onnx-asr
    fork; tracked but not delivered in this change.
    """
    try:
        import onnxruntime as rt
    except ImportError:
        return None
    try:
        cache_root = _resolve_optimized_model_cache_dir()
    except OSError:
        logger.debug("Failed to resolve ORT optimized-model cache dir", exc_info=True)
        return None
    ort_version = getattr(rt, "__version__", "unknown")
    versioned = cache_root / ort_version
    try:
        versioned.mkdir(parents=True, exist_ok=True)
    except OSError:
        logger.debug("Could not create ORT optimized-model cache dir %s", versioned, exc_info=True)
        return None
    return versioned / f"{_slug_model_id(model_name, quantization)}.ort.bin"


#: Whisper-family detection for the fp16 graph-optimization downgrade.
#: Matches the canonical "whisper" string anywhere in the model name —
#: also covers ``lite-whisper``, ``distil-whisper``, ``whisper-large-v3``,
#: ``onnx-community/whisper-tiny.en``, etc. Case-insensitive to handle
#: HF-style ``Whisper`` casing and our lowercase catalog ids uniformly.
def _is_whisper_family(model_name: str | None) -> bool:
    """True iff ``model_name`` belongs to the Whisper family (any variant).

    The fp16 ``ORT_ENABLE_EXTENDED`` workaround targets the
    ``SimplifiedLayerNormFusion`` bug in legacy onnx-community Whisper
    fp16 encoder exports. Parakeet, Moonshine, Canary, GigaAM, Cohere,
    and other non-Whisper fp16 models do NOT have this bug, so they
    keep the default ``ORT_ENABLE_ALL`` for full fusion savings (5-10 %
    per inference on fp16 paths.
    Axis IV.1).
    """
    if not model_name:
        return False
    return "whisper" in model_name.lower()


def _build_sess_options(
    providers_tuple: tuple[Any, ...] | None,
    *,
    fp16: bool = False,
    model_name: str | None = None,
    quantization: str | None = None,
    optimize_to_disk: bool = False,
) -> Any:  # noqa: ANN401 — onnxruntime.SessionOptions
    """SessionOptions tuned for the chosen execution provider.

    Always pinned ``intra_op_num_threads`` (see :func:`_pick_intra_op_threads`
    for the rationale and measurements). The fp16 graph-optimization
    downgrade to ``ORT_ENABLE_EXTENDED`` is now gated on the Whisper
    family (see :func:`_is_whisper_family`) — non-Whisper fp16 models
    don't have the ``SimplifiedLayerNormFusion`` bug and keep
    ``ORT_ENABLE_ALL`` for the full fusion savings (5-10 % per
    inference). Whisper fp16 still needs the downgrade because legacy
    onnx-community exports trigger the upstream ORT bug.

    ``model_name`` defaults to ``None`` so legacy callers that don't
    know the model (e.g. the ``_build_fp16_sess_options`` shim) keep
    the pre-2026 behaviour of unconditional downgrade on fp16. New
    call sites pass ``model_name`` to opt into per-family selection.

    ``optimize_to_disk=True`` additionally sets
    :attr:`SessionOptions.optimized_model_filepath` to a versioned
    cache path so ORT serializes the optimized graph for diagnostics
    and future per-session reload. The path includes
    ``onnxruntime.__version__`` so an ORT wheel bump auto-invalidates
    the cache. Best-effort: any error resolving the cache dir leaves
    the option unset (no behaviour change). See
    :func:`_optimized_model_path` for the known multi-session-shared-
    options limitation that makes this strictly opt-in.
    """
    import onnxruntime as rt

    opts = rt.SessionOptions()
    # Drop to EXTENDED only when fp16 AND the model is a Whisper variant.
    # Other fp16 paths (Parakeet, Moonshine, Canary, …) keep ORT_ENABLE_ALL.
    # The fallback when ``model_name`` is None preserves the legacy
    # behaviour so untyped callers don't accidentally lose the workaround.
    needs_whisper_workaround = fp16 and (model_name is None or _is_whisper_family(model_name))
    if needs_whisper_workaround:
        opts.graph_optimization_level = rt.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
    opts.intra_op_num_threads = _pick_intra_op_threads(providers_tuple)
    if optimize_to_disk and model_name is not None:
        cache_path = _optimized_model_path(model_name, quantization)
        if cache_path is not None:
            opts.optimized_model_filepath = str(cache_path)
            logger.debug("ORT optimized-model dump target: %s", cache_path)
    return opts


def _build_fp16_sess_options() -> Any:  # noqa: ANN401 — onnxruntime.SessionOptions
    """Backwards-compat shim — see :func:`_build_sess_options`.

    Defaults ``model_name=None`` which preserves the legacy unconditional
    downgrade on fp16, the safe behaviour for callers that pre-date the
    per-family gate.
    """
    return _build_sess_options(None, fp16=True)


class _OnnxAsrProgressEvent(Protocol):
    """Structural shape of ``onnx_asr.progress.DownloadProgress``.

    onnx-asr's progress events are duck-typed at the boundary — we only
    consume these three fields, so a local :class:`Protocol` lets us
    annotate the callback without importing the upstream untyped module.
    """

    filename: str
    downloaded: int
    total: int | None


def _make_progress_adapter(model_name: str, sink: Callable[[DownloadProgress], None]) -> Callable[[Any], None]:
    """Map onnx-asr's per-file :class:`onnx_asr.progress.DownloadProgress`
    events into the server's per-model :class:`DownloadProgress` event.

    onnx-asr fires one callback per file per chunk during HF downloads. The
    server-side event aggregates progress across all files in a model so the
    UI can show a single bar with speed / ETA. We track ``(downloaded, total)``
    per filename in a closure and emit aggregated rollups on each update.
    """
    per_file: dict[str, tuple[int, int]] = {}
    start_time = time.monotonic()

    def _on_progress(event: _OnnxAsrProgressEvent) -> None:
        per_file[event.filename] = (int(event.downloaded), int(event.total or 0))
        downloaded_bytes = sum(d for d, _ in per_file.values())
        total_bytes = sum(t for _, t in per_file.values())
        progress = (downloaded_bytes / total_bytes) if total_bytes > 0 else 0.0
        elapsed = max(time.monotonic() - start_time, 1e-6)
        speed_bps = downloaded_bytes / elapsed
        remaining = max(total_bytes - downloaded_bytes, 0)
        eta_seconds = (remaining / speed_bps) if speed_bps > 0 else 0.0

        sink(
            DownloadProgress(
                model=model_name,
                progress=progress,
                downloaded_bytes=downloaded_bytes,
                total_bytes=total_bytes,
                speed_bps=speed_bps,
                eta_seconds=eta_seconds,
            )
        )

    return _on_progress


#: Peak target for :func:`_peak_normalize`. Matches the RealtimeSTT
#: monolith's ``(audio / peak) * 0.95`` (audio_recorder.py:2392-2397 main
#: path / :185-188 realtime path). 0.95 (not 1.0) keeps a hair of headroom
#: so downstream float→mel math never rides the rail.
_NORMALIZE_TARGET_PEAK = 0.95


def _peak_normalize(audio: AudioArray) -> AudioArray:
    """Scale ``audio`` so its loudest sample sits at ~0.95 full-scale.

    Restores the behaviour the ``TranscriptionConfig.normalize_audio`` flag
    has documented and defaulted to ``True`` for all along — the actual
    implementation was lost in the hexagonal rewrite, leaving the flag
    dead. Quiet mics (peak ~0.1-0.2) otherwise fall under Silero VAD's
    confidence threshold and the *entire* utterance is discarded before it
    ever reaches Whisper. Pure scalar gain: no spectral artifacts, no
    train/test mismatch for the ASR model, and a strict no-op on silent
    (``peak == 0``) or empty buffers (the warmup dummy + swap-in-flight
    paths feed zeros). Mirrors examples/RealtimeSTT verbatim — the
    reference monolith is authoritative when behaviour diverges.
    """
    if audio.size == 0:
        return audio
    peak = float(np.max(np.abs(audio)))
    if peak <= 0.0:
        return audio
    return ((audio / peak) * _NORMALIZE_TARGET_PEAK).astype(np.float32)


#: Canonical Whisper base-BPE vocab (id → token), lazily loaded once from the
#: bundled gzip. Whisper's base vocab (ids < 50257) is identical across every
#: multilingual variant, so it doubles as the repair source for broken exports.
_WHISPER_BASE_VOCAB_PATH = Path(__file__).with_name("whisper_base_vocab.json.gz")
_whisper_base_vocab_cache: dict[int, str] | None = None


def _load_whisper_base_vocab() -> dict[int, str]:
    """Load + cache the bundled canonical Whisper base vocab (id → token).

    Returns an empty dict (repair disabled) if the asset is missing/unreadable —
    the fork's ``_decode_text`` ``.get()`` still guards against a hard KeyError.
    """
    global _whisper_base_vocab_cache  # module-level one-shot cache
    if _whisper_base_vocab_cache is None:
        try:
            with gzip.open(_WHISPER_BASE_VOCAB_PATH, "rt", encoding="utf-8") as f:
                tok_to_id: dict[str, int] = json.load(f)
            _whisper_base_vocab_cache = {int(i): t for t, i in tok_to_id.items()}
        except Exception:
            logger.exception("could not load bundled whisper base vocab; broken-export repair disabled")
            _whisper_base_vocab_cache = {}
    return _whisper_base_vocab_cache


def _find_whisper_vocab_holder(
    model: Any,  # noqa: ANN401 — walks loosely-typed onnx_asr internals
    _depth: int = 0,
    _seen: set[int] | None = None,
) -> Any:  # noqa: ANN401
    """Walk the onnx-asr adapter to the object holding a Whisper ``_vocab`` dict.

    Identified by the Whisper-specific pairing of a dict ``_vocab`` AND a
    ``_byte_decoder`` so non-Whisper families (which have no such attrs) return
    ``None`` and skip the repair entirely.
    """
    if _seen is None:
        _seen = set()
    if id(model) in _seen or _depth > 4:
        return None
    _seen.add(id(model))
    vocab = getattr(model, "_vocab", None)
    if isinstance(vocab, dict) and getattr(model, "_byte_decoder", None) is not None:
        return model
    for name in vars(model) if hasattr(model, "__dict__") else ():
        try:
            child = getattr(model, name)
        except Exception:  # defensive: some attrs raise on access
            continue
        if hasattr(child, "__dict__"):
            found = _find_whisper_vocab_holder(child, _depth + 1, _seen)
            if found is not None:
                return found
    return None


def _repair_whisper_vocab(model: Any) -> None:  # noqa: ANN401 — walks loosely-typed onnx_asr internals
    """Backfill a Whisper model's ``id → token`` map when its shipped vocab.json
    is truncated.

    ``onnx-community/CrisperWhisper-ONNX`` ships a vocab.json with only ~45k of
    the 51865 tokens, so emitted filler tokens like ``' uhm'`` (35007) / ``' hm'``
    (35481) have no string and are silently dropped by ``_decode_text`` — exactly
    the verbatim disfluencies CrisperWhisper exists to keep. Whisper's base BPE
    vocab is identical across all multilingual variants, so we fill ONLY the
    missing base ids from the bundled canonical reference; the model's own
    special / added tokens (>= 50257) are left untouched.

    Best-effort + idempotent: non-Whisper models and already-complete vocabs are
    no-ops, and any failure leaves the model as-is.
    """
    try:
        holder = _find_whisper_vocab_holder(model)
        if holder is None:
            return
        reference = _load_whisper_base_vocab()
        if not reference:
            return
        vocab: dict[int, str] = holder._vocab  # repairing onnx_asr internals by design
        missing = {tid: tok for tid, tok in reference.items() if tid not in vocab}
        if not missing:
            return
        vocab.update(missing)
        logger.info(
            "repaired incomplete Whisper vocab: backfilled %d missing base ids (vocab now %d)",
            len(missing),
            len(vocab),
        )
    except Exception:
        logger.exception("whisper vocab repair failed; continuing with shipped vocab")


def _snapshot_providers(model: Any) -> list[str]:  # noqa: ANN401 — walks loosely-typed onnx_asr internals
    """Find the ORT providers attached to ``model``'s primary InferenceSession.

    onnx-asr models hold several ORT sessions (preprocessor, encoder,
    decoder, vad, …). For "is this running on GPU?" the decoder/encoder is
    the meaningful answer — falling back to any other session that exposes
    ``get_providers`` if those aren't visible. Returns ``[]`` when nothing
    walkable is found so callers can fail safely closed (i.e. assume CPU).

    ``onnx_asr.load_model`` returns a ``TextResultsAsrAdapter`` wrapper
    whose real model hangs off ``.asr`` — unwrap one level if that
    attribute is present so we land on the WhisperHf / NemoConformerCtc /
    WhisperOrt instance that actually owns the ORT sessions. Without this
    unwrap, the runtime-info chip was always reporting CPU regardless of
    the resolved device (the adapter has no ``_decoder`` / ``_encoder``
    attribute and no top-level ``get_providers``).
    """
    target = getattr(model, "asr", model)
    # Preferred attribute order: decoder is the heavy compute path; encoder
    # is next; "_model" is the catch-all (WhisperOrt / Silero shape).
    # Anything not found falls through to a generic walk.
    for attr in ("_decoder", "decoder", "_encoder", "encoder", "_model"):
        sess = getattr(target, attr, None)
        get_providers = getattr(sess, "get_providers", None) if sess is not None else None
        if callable(get_providers):
            try:
                providers = get_providers()
            except Exception:
                logger.debug("get_providers() on %s.%s raised", type(target).__name__, attr, exc_info=True)
                continue
            if providers:
                return [str(p) for p in providers]
    # Generic walk over instance attributes — first session with providers wins.
    for value in vars(target).values():
        get_providers = getattr(value, "get_providers", None)
        if callable(get_providers):
            try:
                providers = get_providers()
            except Exception:
                continue
            if providers:
                return [str(p) for p in providers]
    return []


class OnnxAsrTranscriber(ITranscriber):
    """ITranscriber adapter backed by the onnx-asr library.

    Onnx-asr-only after the Track B step 1 refactor — no torch dependency.
    Download progress is wired via onnx-asr's native ``progress_callback``
    (no tqdm-monkey-patch hack anymore).

    Long audio is handled WhisperX-style: Silero VAD pre-segments the
    waveform, then it is transcribed per speech chunk so Whisper's 30 s
    mel window is never exceeded. The chunk granularity is output-aware
    (see :meth:`_recognize_vad_segments`): :meth:`transcribe` (plain text)
    *merges* adjacent speech into ~29 s chunks — naive per-pause VAD emits
    hundreds of sub-second segments and onnx-asr pads *each* to a full
    30 s mel window, so merging cut 827 segments → 66 on a 30-min file and
    improved both speed (22 → 37x realtime, +70 %) and accuracy (exact
    word count vs. boundary-inflated); :meth:`transcribe_segments` (SRT)
    keeps fine-grained cues for readable subtitles. Mirrors whisperX's
    ``merge_chunks``.

    Callers that only ever feed bounded-short audio (the realtime live
    preview, whose window is capped at ~20 s well under the 30 s wall)
    construct with ``segment_with_vad=False``: no Silero model is loaded
    and ``transcribe()`` does a single direct ``recognize()`` — faster per
    tick and, crucially, it does not let VAD trim trailing in-progress
    speech out of the growing preview.
    """

    # Maximum length of a single (merged) speech chunk. Whisper's
    # mel-spectrogram window is 30 s; we keep 1 s of headroom for the
    # 30 ms speech_pad applied on each end (see onnx-asr BaseVad).
    _VAD_MAX_SPEECH_DURATION_S = 29.0
    # Silence shorter than this is bridged instead of splitting the audio,
    # so VAD emits ~29 s chunks (capped by the duration above) rather than
    # one tiny segment per micro-pause. 2 s is comfortably longer than
    # intra-sentence pauses but still breaks on real topic/paragraph gaps
    # when they fall before the 29 s cap. Benchmark-tuned (2000 vs 4000 ms
    # produced identical 66-segment output on the 30-min reference file —
    # the duration cap is the binding constraint).
    _VAD_MIN_SILENCE_MS = 2000.0
    # AED merged-decoders (Cohere, Canary) are NOT Whisper: no fixed mel
    # window, trained on short utterances. Fed a long clip they emit EOS after
    # roughly the first ~13-15 s of speech and DROP the rest. A single 30 s
    # decode yields only ~half the words even with an explicit language, and
    # collapses to one sentence under the ``<|unklang|>`` auto-language token
    # the default (language="") path uses. Measured on a 30 s Arabic dictation:
    # cliff at ~17 s; explicit-lang single-pass 39/74 words; unklang VAD-slice
    # 5/74; VAD-chunked recovers the full ~74. This is INHERENT to the model,
    # not a WinSTT bug — reproduced with the decoder patches disabled and on
    # both fp16 and fp32. Cohere's own model card recommends running "a VAD
    # before the model"; its reference WebGPU demo single-passes (so it
    # truncates long audio too). So we do exactly what the card says — Silero
    # VAD before the model — but cap chunks below the ~16 s reliable single-
    # decode window so each piece decodes in full and merges back.
    # Whisper/Moonshine keep the 29 s window. See
    # ``memory/project_cohere_unklang_long_segment_truncation.md``.
    _VAD_MAX_SPEECH_DURATION_S_AED = 10.0

    def __init__(
        self,
        *,
        model_name: str,
        quantization: str | None = None,
        providers: list[str | tuple[str, dict[str, str]]] | None = None,
        on_download_progress: Callable[[DownloadProgress], None] | None = None,
        local_path: str | None = None,
        segment_with_vad: bool = True,
        normalize_audio: bool = True,
        translate_to_english: bool = False,
        use_optimized_model_cache: bool = False,
        whisper_beam_size: int = 1,
    ) -> None:
        if onnx_asr is None:
            msg = "onnx_asr is not installed"
            raise RuntimeError(msg)

        providers_tuple: tuple[str | tuple[str, dict[str, str]], ...] | None = tuple(providers) if providers else None

        kwargs: dict[str, Any] = {"quantization": quantization}
        if providers_tuple is not None:
            kwargs["providers"] = providers_tuple
        if on_download_progress is not None:
            kwargs["progress_callback"] = _make_progress_adapter(model_name, on_download_progress)
        # User-provided custom-model bundles go through ``path=`` so the
        # HF resolver is bypassed and onnx-asr loads weights from the local
        # directory directly. The model_name still drives onnx-asr's
        # adapter selection (e.g. "whisper" vs "nemo") but the file IO is
        # local-only — no network calls, no cache entries created.
        if local_path is not None:
            kwargs["path"] = local_path
        # SessionOptions are always provided so every load picks an
        # EP-tuned ``intra_op_num_threads`` (see
        # :func:`_pick_intra_op_threads`). Default ORT (intra=0 = "use
        # all logical cores") is benchmarked-worst by a wide margin on
        # both consumer CPUs (E-core collapse on Alder Lake) and GPUs
        # (over-subscribed CPU threads stall small device-fallback ops).
        # The fp16 flag additionally lowers the graph optimization level
        # to dodge a SimplifiedLayerNormFusion bug on Whisper fp16
        # encoder exports; orthogonal to threading. The ``model_name``
        # argument gates the fp16 downgrade per-family — only Whisper
        # variants pay the EXTENDED tax now (see
        # :func:`_is_whisper_family`).
        kwargs["sess_options"] = _build_sess_options(
            providers_tuple,
            fp16=(quantization == "fp16"),
            model_name=model_name,
            quantization=quantization,
            optimize_to_disk=use_optimized_model_cache,
        )

        logger.info("Loading onnx-asr model %s (quantization=%s)", model_name, quantization)
        self._model: Any = self._load_model_with_fp16_repair(model_name, kwargs)
        # Backfill a truncated Whisper vocab (e.g. CrisperWhisper-ONNX ships only
        # ~45k/51865 tokens, dropping its verbatim fillers). No-op for complete
        # vocabs and non-Whisper families. See _repair_whisper_vocab.
        _repair_whisper_vocab(self._model)
        self._ready = True
        self._model_name = model_name
        # Snapshot the actual ORT providers attached to a representative
        # session (decoder for Whisper, otherwise the first session walked).
        # Used by the runtime-info accessor to drive the frontend GPU/CPU
        # chip honestly — the user's onnxruntime install determines whether
        # CUDA / DML actually attach, regardless of what was requested.
        self._active_providers = _snapshot_providers(self._model)
        logger.info("onnx-asr model %s loaded; providers=%s", model_name, self._active_providers)

        # Silero VAD for transcription-time segmentation of long audio.
        # Skipped entirely for bounded-short callers (realtime): no model
        # load, and transcribe() takes the direct single-pass path below.
        #
        # The VAD is shared across every transcriber that uses the same
        # provider tuple — see ``_get_or_load_silero_vad``. We hold a
        # reference but the cache owns the lifetime; shutdown() drops our
        # reference but doesn't close the shared instance.
        # Peak-normalize the assembled waveform right before recognition
        # (and before the internal Silero segmentation VAD on the long-audio
        # path) — see ``_peak_normalize``. Honors
        # ``TranscriptionConfig.normalize_audio``; default True matches the
        # config default and the documented intent.
        self._normalize_audio = normalize_audio
        self._segment_with_vad = segment_with_vad
        self._vad: Any = None
        # Adapter cache for the VAD-segmented recognize path, keyed by
        # ``(merge, responsive)`` and lazily filled (see _recognize_vad_segments).
        # ``responsive`` adapters use ``batch_size=1`` so the cancel flag is
        # polled after EVERY chunk (file transcription) instead of every 8-chunk
        # batch — that batch granularity was the "cancel takes way too long" lag.
        self._vad_adapters: dict[tuple[bool, bool], Any] = {}
        # Serializes every recognition call on THIS transcriber instance. The
        # main model is shared between live dictation (RecordingPipeline) and
        # file transcription (the file_transcribe worker thread); two threads
        # driving the cached with_vad adapter at once would corrupt its
        # internal bookkeeping arrays. The realtime transcriber is a separate
        # instance with its own lock, so this never blocks the live preview.
        # File transcription cooperatively breaks its segment loop on cancel
        # (a cancel raised from ``on_chunk`` below), releasing this lock
        # promptly so a push-to-talk dictation can grab the model mid-queue.
        self._infer_lock = threading.Lock()
        if segment_with_vad:
            self._vad = _get_or_load_silero_vad(providers_tuple)
        else:
            logger.info("Silero VAD skipped (segment_with_vad=False — bounded-short caller)")

        # Translation request flows through two distinct engine APIs in
        # onnx_asr depending on the model family:
        #
        # * **Whisper family** — translation is baked into the decoder
        #   prompt at load time (``<|translate|>`` token replaces
        #   ``<|transcribe|>``). onnx_asr exposes no runtime
        #   ``target_language`` for Whisper, so we mutate the prompt
        #   arrays after load via :meth:`_patch_translate_prompt`.
        # * **NeMo Canary family** — ``_decoding`` consumes a
        #   ``target_language`` kwarg natively (see
        #   ``.venv/.../onnx_asr/models/nemo.py:236-238``). We inject it
        #   on every recognize call — :data:`_translate_target_language`
        #   is the value to pass.
        # * Other families (GigaAM, Moonshine, Kaldi, Cohere) don't
        #   support translation; the flag is a silent no-op for them.
        self._translate_to_english = translate_to_english
        self._translate_target_language: str | None = None
        if translate_to_english:
            if self._is_canary_engine():
                # Canary's native English-target sentinel.
                # Future work: surface the full Canary language
                # matrix (en/es/de/fr/zh/ja/ru/…) so users can pick the
                # destination instead of being pinned to English.
                self._translate_target_language = "en"
                logger.info(
                    "Translate-to-English enabled on Canary model %s — using target_language='en'",
                    model_name,
                )
            else:
                self._patch_translate_prompt()

        # Beam-search width for Whisper-family engines (greedy elsewhere).
        # Stashed on the underlying engine instance so the patched
        # ``_decoding`` picks it up via ``_winstt_beam_size``. No-op on
        # engines that aren't WhisperHf — they ignore the attribute.
        self._whisper_beam_size = int(max(1, whisper_beam_size))
        if self._whisper_beam_size > 1:
            target = self._resolve_whisper_engine()
            if target is not None:
                target._winstt_beam_size = self._whisper_beam_size
                logger.info(
                    "Whisper beam search enabled on %s — beam_size=%d",
                    model_name,
                    self._whisper_beam_size,
                )
            else:
                logger.info(
                    "whisper_beam_size=%d ignored on non-Whisper engine %s",
                    self._whisper_beam_size,
                    model_name,
                )

    def _is_canary_engine(self) -> bool:
        """Heuristic: detect a NeMo Canary engine without importing nemo."""
        engine = self._model
        for candidate in (engine, getattr(engine, "model", None)):
            if candidate is None:
                continue
            cls_name = type(candidate).__name__
            # onnx_asr's Canary classes are ``_Canary``, ``Canary``,
            # ``Canary1B``, etc. — the substring is the family marker.
            if "Canary" in cls_name or "canary" in cls_name.lower():
                return True
        # Fallback: model name string. Catalog ids start with "nemo-canary-"
        # and the HF repo paths contain "canary".
        name = (self._model_name or "").lower()
        return "canary" in name

    def _patch_translate_prompt(self) -> None:
        """Swap ``<|transcribe|>`` for ``<|translate|>`` in the prompt arrays.

        No-op on engines that aren't Whisper (no ``_tokens`` attribute),
        on English-only variants (``_is_multilingual=False``), or on
        engines whose vocab is missing the ``<|translate|>`` token. The
        guard is purpose-built to be invisible when the request can't be
        honored, so the user-facing toggle quietly falls through to
        normal transcription rather than crashing — and the catalog
        already gates the toggle to multilingual Whisper anyway.
        """
        engine = self._model
        # onnx_asr wraps the engine in TextResultsAsrAdapter; the actual
        # model with prompt arrays is on ``engine.model`` for adapters
        # or directly on the engine for raw models. Walk both.
        candidates = [engine, getattr(engine, "model", None)]
        for candidate in candidates:
            if candidate is None:
                continue
            tokens = getattr(candidate, "_tokens", None)
            if not isinstance(tokens, dict):
                continue
            translate_id = tokens.get("<|translate|>")
            transcribe_id = tokens.get("<|transcribe|>")
            if translate_id is None or transcribe_id is None:
                logger.warning(
                    "Translate-to-English requested but model %s lacks the <|translate|> token; "
                    "falling back to transcribe.",
                    self._model_name,
                )
                return
            if getattr(candidate, "_is_multilingual", True) is False:
                logger.warning(
                    "Translate-to-English requested on English-only model %s — no-op.",
                    self._model_name,
                )
                return
            self._replace_prompt_token(candidate, transcribe_id, translate_id)
            logger.info("Patched Whisper prompts for task=translate on %s", self._model_name)
            return
        logger.warning(
            "Translate-to-English requested on non-Whisper engine %s — no-op.",
            self._model_name,
        )

    @staticmethod
    def _replace_prompt_token(engine: Any, old_id: int, new_id: int) -> None:  # noqa: ANN401
        """Substitute one token id in every static prompt array on the engine.

        onnx_asr caches the static decoder prompts as numpy arrays on the
        engine instance (``_transcribe_input`` and
        ``_transcribe_input_with_timestamps``). Both are 2-D int64 arrays
        with shape ``(1, n)``. We mutate in place rather than reassign so
        any held references (the autoregressive loop reads the array on
        every step) stay valid.
        """
        for attr in ("_transcribe_input", "_transcribe_input_with_timestamps"):
            arr = getattr(engine, attr, None)
            if arr is None:
                continue
            try:
                # arr[arr == old_id] = new_id — but use numpy ops without
                # importing numpy at module top (already imported elsewhere
                # in this file via dependencies). The engine arrays are
                # known numpy arrays; ``__setitem__`` on a boolean mask
                # mutates in place.
                arr[arr == old_id] = new_id
            except Exception:
                logger.exception("Prompt-array patch failed on %s.%s", type(engine).__name__, attr)

    @staticmethod
    def _load_model_with_fp16_repair(model_name: str, kwargs: dict[str, Any]) -> Any:  # noqa: ANN401
        """Call ``onnx_asr.load_model`` with one-shot recovery retries.

        Two distinct failure modes get an automatic retry; everything
        else propagates.

        1. **Partial HF cache.** A previously interrupted download can
           leave the ``.onnx`` graph file present while the matching
           ``.onnx.data`` / ``.onnx_data`` external-weights sidecar is
           still missing. onnx-asr's resolver only checks for the
           ``.onnx`` file, so ``local_files_only=True`` succeeds and
           then ORT raises
           ``External data path does not exist: …onnx.data`` at session
           init. We re-run ``snapshot_download(local_files_only=False)``
           to fill the gap and reload.

        2. **fp16 Whisper subgraph defect.** onnx-community Whisper fp16
           merged-decoder exports declare subgraph outputs with
           outer-scope names (``logits``, ``present.*``) and fp32 dtype
           annotations on what is otherwise an fp16 graph. ORT 1.18+
           rejects the graph; we surgical-patch the file in-place (see
           :func:`src.recorder.infrastructure.onnx_patch.patch_whisper_decoder`)
           and retry once.
        """
        assert onnx_asr is not None  # narrowing — checked at call site
        try:
            return onnx_asr.load_model(model_name, **kwargs)
        except Exception as exc:
            if _is_external_data_missing_error(exc) and _refetch_hf_snapshot(model_name):
                return onnx_asr.load_model(model_name, **kwargs)
            decoder_path = _extract_fp16_whisper_decoder_path(exc)
            if decoder_path is None or not decoder_path.exists():
                raise
            from src.recorder.infrastructure.onnx_patch import (
                patch_whisper_decoder,
                should_skip_patch,
            )

            if should_skip_patch(decoder_path):
                # Already patched — the same error means a different bug we can't fix here.
                raise
            edits = patch_whisper_decoder(decoder_path)
            if edits == 0:
                # Patch was a no-op (different structural bug). Re-raise the original.
                raise
            logger.info(
                "Retrying load of %s after applying %d in-cache fp16 decoder fixes to %s",
                model_name,
                edits,
                decoder_path,
            )
            return onnx_asr.load_model(model_name, **kwargs)

    @property
    def model_name(self) -> str:
        return self._model_name

    @property
    def active_providers(self) -> list[str]:
        """Snapshot of ORT execution providers used by this model's primary session."""
        return list(self._active_providers)

    @property
    def is_gpu(self) -> bool:
        """True if any GPU-class ORT provider is active (CUDA / TensorRT / DirectML / ROCm)."""
        return any(p in GPU_PROVIDERS for p in self._active_providers)

    def _recognize_direct(
        self,
        audio: AudioArray,
        lang_arg: str | None,
        on_chunk: Callable[[float, float, str], None] | None = None,
    ) -> list[tuple[float, float, str]]:
        """Single-pass recognition for bounded-short callers (no VAD).

        Used when ``segment_with_vad=False`` (realtime live preview). The
        window is guaranteed under Whisper's 30 s mel limit, so VAD would
        only add per-tick latency and risk trimming trailing in-progress
        speech out of the growing preview. One zero-offset tuple keeps the
        ``(start, end, text)`` contract that :meth:`transcribe` consumes.
        """
        recognize_kwargs: dict[str, Any] = {"sample_rate": 16_000}
        if lang_arg is not None:
            recognize_kwargs["language"] = lang_arg
        if self._translate_target_language is not None:
            recognize_kwargs["target_language"] = self._translate_target_language
        with self._infer_lock:
            try:
                text = self._model.recognize(audio, **recognize_kwargs)
            except TypeError:
                # Engines that don't accept one of our kwargs (older
                # onnx_asr builds, custom adapters) — strip the optional
                # ones and retry with just the sample_rate baseline.
                recognize_kwargs.pop("language", None)
                recognize_kwargs.pop("target_language", None)
                text = self._model.recognize(audio, **recognize_kwargs)
        if on_chunk is not None:
            on_chunk(0.0, 0.0, text or "")
        return [(0.0, 0.0, text or "")]

    def _recognize_vad_segments(
        self,
        audio: AudioArray,
        lang_arg: str | None,
        *,
        merge: bool,
        on_chunk: Callable[[float, float, str], None] | None = None,
    ) -> list[tuple[float, float, str]]:
        """WhisperX-style VAD-segmented recognition.

        Silero VAD detects speech; the chunk granularity depends on
        ``merge``:

        * ``merge=True`` (plain text / :meth:`transcribe`): adjacent speech
          separated by less than ``_VAD_MIN_SILENCE_MS`` is coalesced into
          chunks capped at ``_VAD_MAX_SPEECH_DURATION_S``. Without this,
          naive per-pause VAD emits hundreds of sub-second segments and
          onnx-asr pads *each* to a full 30 s mel window — ~14x wasted
          compute on a 30-min file (827→66 chunks, +70 % throughput,
          benchmark-verified). Text is concatenated so coarse chunks lose
          nothing.
        * ``merge=False`` (SRT / :meth:`transcribe_segments`): no silence
          bridging, so cues stay short and readable as subtitles. Only the
          30 s-wall safety cap (``_VAD_MAX_SPEECH_DURATION_S``) is applied.
          SRT export is explicit and infrequent, so the slower
          fine-grained pass is the right trade.

        Returns ``(start_s, end_s, text)`` with *global* offsets (the VAD
        adapter maps segment-local times to absolute file time).
        """
        # Cache the with_vad adapter per ``merge`` flag — both possible
        # vad_kwargs dicts are constant for the lifetime of the transcriber,
        # so the adapter object itself is reusable. ``with_vad`` wraps the
        # base engine without rebinding ORT sessions, but it still creates
        # a fresh Python adapter on each call (with its own internal
        # bookkeeping arrays); reusing it skips that per-call construction
        # — a small but real win on the long-audio path, which fires the
        # adapter once per recording for `transcribe_segments` (SRT) and
        # once per utterance for the normal merged-VAD `transcribe`.
        # File transcription (``on_chunk`` set) uses ``batch_size=1`` so the
        # cancel flag is polled after EVERY chunk. The default batch_size (8)
        # made a cancel wait for a whole 8-chunk inference to finish — the
        # "cancel is heavy / takes way too long" lag the user hit on long files.
        # Dictation (``on_chunk`` is None) keeps the throughput-batched
        # default; its utterances are short so the granularity is moot there.
        #
        # AED engines (Cohere, Canary) ALSO force ``batch_size=1``, for
        # correctness rather than cancel-responsiveness: onnx-asr's VAD
        # adapter batches up to ``batch_size`` segments and zero-pads the
        # shorter ones up to the longest via ``pad_list`` (utils.py). These
        # merged-decoder ONNX exports carry no ``encoder_attention_mask``,
        # so the decoder cross-attends to those trailing zeros and
        # phrase-loops — re-emitting the segment's final sentence. This was
        # the live Cohere bug: a >29 s dictation split into two VAD chunks,
        # the shorter second chunk got zero-padded up to the first (several
        # seconds of trailing zeros), and Cohere looped on the padding.
        # ``batch_size=1`` makes ``pad_list`` pad each segment to itself →
        # no spurious silence. Free for dictation (≤ a handful of chunks).
        responsive = on_chunk is not None
        is_aed = onnx_decoder_patches.is_cohere_engine(self._model) or onnx_decoder_patches.is_canary_aed_engine(
            self._model
        )
        unbatched = responsive or is_aed
        cache_key = (merge, unbatched)
        adapter = self._vad_adapters.get(cache_key)
        if adapter is None:
            # AED merged-decoders early-EOS on long chunks (see
            # ``_VAD_MAX_SPEECH_DURATION_S_AED``); everyone else keeps Whisper's
            # 29 s window. Engine identity is fixed for this transcriber's
            # lifetime, so the cap is constant per ``cache_key``.
            max_speech = self._VAD_MAX_SPEECH_DURATION_S_AED if is_aed else self._VAD_MAX_SPEECH_DURATION_S
            vad_kwargs: dict[str, Any] = {"max_speech_duration_s": max_speech}
            if merge:
                vad_kwargs["min_silence_duration_ms"] = self._VAD_MIN_SILENCE_MS
            if unbatched:
                vad_kwargs["batch_size"] = 1
            adapter = self._model.with_vad(self._vad, **vad_kwargs)
            self._vad_adapters[cache_key] = adapter
        recognize_kwargs: dict[str, Any] = {"sample_rate": 16_000}
        if lang_arg is not None:
            recognize_kwargs["language"] = lang_arg
        if self._translate_target_language is not None:
            recognize_kwargs["target_language"] = self._translate_target_language

        # Progress + resume source: the VAD adapter yields one (already
        # transcribed) chunk at a time — see ``onnx_asr/vad.py::recognize_batch``,
        # whose inner generator runs ``asr.recognize_batch`` per batch then
        # ``yield``s each result lazily. Each chunk carries GLOBAL (start, end)
        # timestamps + text, forwarded to ``on_chunk`` so the file worker can
        # both drive the progress bar and accumulate finished chunks for resume.
        # Serialize on this instance (see ``_infer_lock`` in __init__). Held
        # across the whole lazy consume so the shared with_vad adapter is never
        # driven by two threads at once. ``on_chunk`` may raise (file
        # transcription's cancel path) — the ``with`` releases the lock as the
        # exception propagates, freeing the model for a push-to-talk dictation.
        with self._infer_lock:
            try:
                segments_iter = adapter.recognize(audio, **recognize_kwargs)
            except TypeError:
                # Some models don't accept the language kwarg through with_vad,
                # and ``target_language`` is even more selective (Canary only).
                # Strip both and retry with the bare baseline so unrelated
                # engines still transcribe rather than erroring out.
                recognize_kwargs.pop("language", None)
                recognize_kwargs.pop("target_language", None)
                segments_iter = adapter.recognize(audio, **recognize_kwargs)

            results: list[tuple[float, float, str]] = []
            for s in segments_iter:
                seg = (float(s.start), float(s.end), s.text)
                results.append(seg)
                # ``on_chunk`` (file transcription) observes each completed chunk
                # so the worker can report progress AND accumulate finished chunks
                # for resume — it may raise to cancel between chunks.
                if on_chunk is not None:
                    on_chunk(*seg)
            return results

    @override
    def transcribe(
        self,
        audio: AudioArray,
        language: str = "",
        use_prompt: bool = True,
        custom_words: list[str] | None = None,
        initial_prompt_text: str | None = None,
        on_chunk: Callable[[float, float, str], None] | None = None,
    ) -> TranscriptionResult:
        start_t = time.time()
        lang_arg = language if language else None

        # Decoder-bias prompt: we feed prior context into the decoder via
        # Whisper's classic ``<|startofprev|>`` mechanism — or, on Canary
        # AED and Cohere, via the trained ``<|startofcontext|>`` slot
        # (positions [1]→[2] of the upstream 10-token prompt). The
        # patched ``_decoding`` reads ``_winstt_initial_prompt_ids`` and
        # prepends / splices accordingly. Non-supported engines
        # (Moonshine, SenseVoice, CTC/RNN-T families) are no-ops.
        #
        # Two input shapes are supported:
        #   * ``initial_prompt_text`` — free-form prior text from the
        #     UIA snapshot composer on the frontend; this is the
        #     preferred path (richer signal than a comma-joined word list).
        #   * ``custom_words`` — legacy dictionary-only list. Used as a
        #     fallback when ``initial_prompt_text`` is empty so the
        #     personal-dictionary path keeps working on transcribers that
        #     don't get a live composed prompt push.
        #
        # Realtime callers pass ``use_prompt=False`` so the latency
        # overhead of decoder prompt-cache warmup doesn't compound per
        # tick.
        installed_prompt = False
        if use_prompt:
            prompt_text = initial_prompt_text.strip() if isinstance(initial_prompt_text, str) else ""
            if not prompt_text and custom_words:
                prompt_text = ", ".join(w.strip() for w in custom_words if w.strip())
            if prompt_text:
                installed_prompt = self._install_initial_prompt_text(prompt_text)
        try:
            # Plain text: merge VAD chunks for speed — granularity is irrelevant
            # once the segment texts are concatenated. ``on_chunk`` (file
            # transcription only) receives the real per-chunk completion
            # fraction; it may raise to cancel a long file mid-flight.
            segments = self._recognize(audio, lang_arg, merge=True, on_chunk=on_chunk)
        finally:
            if installed_prompt:
                self._uninstall_initial_prompt_text()
        text = " ".join(seg_text.strip() for _, _, seg_text in segments if seg_text.strip())

        elapsed = time.time() - start_t
        return TranscriptionResult(
            text=text,
            language=language,
            language_probability=0.0,
            duration_seconds=elapsed,
        )

    def align_words(self, wav_path: str, known_text: str = "") -> list[dict[str, Any]] | None:
        """Native per-word timestamps for ``wav_path`` using THIS model, or None.

        Returns ``[{text, start, end}]`` when the active engine can emit timings
        itself — Whisper ``*_timestamped`` (cross-attention DTW → ``.words``) or
        CTC / RNN-T / TDT (per-token emit times → grouped to words). Relabelled
        onto ``known_text`` when given (zero drift). Returns ``None`` when the
        model can't (plain Whisper ``WhisperOrt``, Canary AED, Moonshine, Cohere)
        so the caller falls back to the tiny timestamped-Whisper aligner.

        Single 30 s window (Whisper bound) — callers segment long audio first.
        """
        from src.recorder.infrastructure.word_aligner import group_tokens_to_words, map_timings_to_text

        try:
            # Serialize on ``_infer_lock`` like the other recognition entry
            # points: history word-alignment shares this model's ORT sessions
            # with live dictation and file transcription, so an unlocked
            # recognize() here would violate the lock's "every recognition call
            # on this instance is serialized" invariant (and, on DirectML, risk
            # the documented concurrent-Run heap corruption).
            with self._infer_lock:
                timestamped = self._model.with_timestamps()
                result = timestamped.recognize(wav_path, return_timestamps=True, return_word_timestamps=True)
        except Exception:
            logger.debug("align_words: native timestamps unavailable for this model", exc_info=True)
            return None

        native_words = getattr(result, "words", None)
        if native_words:
            words = [{"text": w.text, "start": float(w.start), "end": float(w.end)} for w in native_words]
        else:
            tokens = getattr(result, "tokens", None)
            stamps = getattr(result, "timestamps", None)
            if not (tokens and stamps):
                return None
            words = group_tokens_to_words(list(tokens), [float(s) for s in stamps])
        if not words:
            return None
        return map_timings_to_text(words, known_text) if known_text.strip() else words

    def _resolve_whisper_engine(self) -> Any:  # noqa: ANN401
        """Return the underlying ``WhisperHf`` engine, or ``None`` if not Whisper.

        Walks the optional ``onnx_asr.TextResultsAsrAdapter`` wrapper
        (``adapter.asr``) so we land on the class that owns ``_tokens`` and
        the ``_transcribe_input`` prompt array.
        """
        return self._resolve_engine_by_class_name("WhisperHf")

    def _resolve_engine_by_class_name(self, class_name: str) -> Any:  # noqa: ANN401
        """Walk the optional adapter wrapper to find an engine by class name.

        Used by all three prompt-bias install paths (Whisper / Canary AED /
        Cohere). Each engine type exposes its vocab on a slightly different
        attribute (``_tokens`` for Whisper + Canary, ``_token_to_id`` for
        Cohere) so callers do the attribute pick after this returns.
        """
        engine = self._model
        for candidate in (engine, getattr(engine, "asr", None), getattr(engine, "model", None)):
            if candidate is None:
                continue
            if type(candidate).__name__ == class_name:
                return candidate
        return None

    def _resolve_canary_aed_engine(self) -> Any:  # noqa: ANN401
        """Return the underlying ``NemoConformerAED`` engine, or ``None``."""
        return self._resolve_engine_by_class_name("NemoConformerAED")

    def _resolve_cohere_engine(self) -> Any:  # noqa: ANN401
        """Return the underlying ``CohereAsr`` engine, or ``None``."""
        return self._resolve_engine_by_class_name("CohereAsr")

    def _install_whisper_initial_prompt(self, custom_words: list[str]) -> bool:
        """Push an encoded prompt prefix onto the WhisperHf engine.

        Returns ``True`` when the prompt was installed (caller must invoke
        ``_uninstall_whisper_initial_prompt`` in a ``finally`` block) and
        ``False`` when there's nothing to do — engine isn't Whisper, vocab
        lacks ``<|startofprev|>``, or custom_words encode to nothing.
        """
        target = self._resolve_whisper_engine()
        if target is None:
            return False
        tokens_dict = getattr(target, "_tokens", None)
        if not isinstance(tokens_dict, dict):
            return False
        prompt_ids = onnx_decoder_patches.whisper_initial_prompt_tokens(custom_words, tokens_dict)
        if not prompt_ids:
            return False
        target._winstt_initial_prompt_ids = prompt_ids
        return True

    def _uninstall_whisper_initial_prompt(self) -> None:
        """Clear the prompt prefix attribute on the Whisper engine."""
        target = self._resolve_whisper_engine()
        if target is None:
            return
        try:
            target._winstt_initial_prompt_ids = None
        except Exception:  # pragma: no cover — defensive
            logger.exception("Failed to clear Whisper initial-prompt attribute")

    def _install_initial_prompt_text(self, text: str) -> bool:
        """Push a free-form prior-text prompt onto the engine, if supported.

        Currently dispatches ONLY to ``WhisperHf`` via the classic
        ``<|startofprev|>`` mechanism (encode via byte-BPE, prepend to
        the decoder input).

        Canary AED and Cohere are deliberately NOT wired here even
        though their vocabularies expose a ``<|startofcontext|>`` slot.
        Benchmarking against the released checkpoints (NeMo
        Canary-180M-flash, Canary-1B-v2, Cohere-transcribe q4) showed
        the slot is reserved-but-untrained: filling it either
          * Canary 180M: causes the decoder to emit EOS on the first
            generation step → empty transcript (hard regression);
          * Canary 1B: is silently ignored (byte-identical output);
          * Cohere: truncates ("Now, I want to.") or hallucinates novel
            content unrelated to the audio for ANY sentence-shaped
            prompt; single-word prompts are ignored.

        The slot was added to the vocab for a future context-conditioned
        training run that hasn't shipped; until NeMo / Cohere release a
        checkpoint with active context-slot training, attempting to use
        it is a transcription regression risk. The
        ``_canary_aed_decoding_patched`` / ``_cohere_decoding_patched``
        patches in :mod:`onnx_decoder_patches` still respect
        ``_winstt_initial_prompt_ids`` if anything sets it (e.g. a
        future revival via direct attribute write or by re-enabling
        the dispatcher branches), but no production codepath does. See
        ``memory/project_canary_cohere_prompt_slot_untrained.md`` for
        the per-prompt-shape failure data.

        Returns ``True`` when the prompt was installed; the caller must
        then invoke :meth:`_uninstall_initial_prompt_text` in a finally.
        Returns ``False`` for non-supported engines (Canary, Cohere,
        Moonshine, SenseVoice, CTC/RNN-T families) and for empty text.
        """
        stripped = text.strip() if isinstance(text, str) else ""
        if not stripped:
            return False
        # Whisper path — reuses the existing ``<|startofprev|>`` helper.
        whisper = self._resolve_whisper_engine()
        if whisper is None:
            return False
        tokens_dict = getattr(whisper, "_tokens", None)
        if not isinstance(tokens_dict, dict):
            return False
        sop = tokens_dict.get("<|startofprev|>")
        if sop is None:
            return False
        encoded = onnx_decoder_patches.encode_whisper_prompt(stripped, tokens_dict)
        if not encoded:
            return False
        whisper._winstt_initial_prompt_ids = [int(sop), *encoded]
        return True

    def _uninstall_initial_prompt_text(self) -> None:
        """Clear ``_winstt_initial_prompt_ids`` on whichever engine is live.

        Idempotent — clears on every supported engine type without checking
        which one was actually installed. The attribute is read-only-on-
        decode so leaving a stale ``None`` is harmless on engines we
        didn't touch.
        """
        for resolver in (
            self._resolve_whisper_engine,
            self._resolve_canary_aed_engine,
            self._resolve_cohere_engine,
        ):
            target = resolver()
            if target is None:
                continue
            try:
                target._winstt_initial_prompt_ids = None
            except Exception:  # pragma: no cover — defensive
                logger.exception(
                    "Failed to clear initial-prompt attribute on %s",
                    type(target).__name__,
                )

    def transcribe_segments(
        self,
        audio: AudioArray,
        language: str = "",
        on_chunk: Callable[[float, float, str], None] | None = None,
    ) -> list[tuple[float, float, str]]:
        """Segmented transcription with global timestamps, for SRT export.

        Same WhisperX-style VAD pipeline as :meth:`transcribe`, but with
        ``merge=False`` so cues stay short and readable — a 29 s merged
        subtitle block is unusable. Trades the merge speedup for correct
        subtitle granularity; SRT export is an explicit, infrequent action.
        """
        lang_arg = language if language else None
        return self._recognize(audio, lang_arg, merge=False, on_chunk=on_chunk)

    def _recognize(
        self,
        audio: AudioArray,
        lang_arg: str | None,
        *,
        merge: bool,
        on_chunk: Callable[[float, float, str], None] | None = None,
    ) -> list[tuple[float, float, str]]:
        """Dispatch to the VAD-segmented or direct path per ``segment_with_vad``.

        ``merge`` is forwarded to the VAD path (ignored on the direct path,
        which has no VAD to merge).

        Peak-normalization (when enabled) happens here, the single
        chokepoint shared by :meth:`transcribe`, :meth:`transcribe_segments`,
        the realtime windows, and file transcription (which reuses this
        instance) — so every path gets the same conditioning, and the
        long-audio path's internal Silero segmentation VAD sees the
        normalized signal too.

        Two engine-specific input-side pads also run here, since this is the
        single chokepoint every transcribe path flows through:

        * **AED short-audio pad** (Canary, Cohere): clips < 1 s confuse
          AED decoders into dot-loops. Pad to 1.25 s of trailing silence.
        * **Parakeet leading-silence pad** (RNN-T/TDT): models were
          trained against silence-prefixed inputs; without it the first
          word is occasionally dropped or duplicated. Add 250 ms.
        """
        if self._normalize_audio:
            audio = _peak_normalize(audio)
        audio = self._maybe_apply_engine_pads(audio)
        if self._segment_with_vad:
            return self._recognize_vad_segments(audio, lang_arg, merge=merge, on_chunk=on_chunk)
        return self._recognize_direct(audio, lang_arg, on_chunk=on_chunk)

    def _maybe_apply_engine_pads(self, audio: AudioArray) -> AudioArray:
        """Apply Canary/Cohere short-audio pad or Parakeet leading-silence pad.

        Engine detection is one-time per call (cheap, just an isinstance-
        equivalent class-name walk) so we don't cache it on the
        transcriber — engine identity is fixed for a transcriber's
        lifetime, but it's cheap enough to re-resolve and keeps the
        method side-effect-free w.r.t. instance state.

        The two AED families need OPPOSITE tail handling, so they branch:

        * **Canary AED** — trim leading silence, then ``maybe_pad_for_aed``
          extends the clip with trailing zeros up to ``AED_PAD_TO_SAMPLES``
          (1.25 s). Canary needs that end-of-utterance "rest" cue to emit
          EOS; without it short clips dot-loop. (The leading trim also
          kills the "I speak if I spe, ikkkkkkkk" stutter that the spliced
          ``vad_prefill_ms`` silence caused.)
        * **Cohere** — trim leading AND trailing silence, NEVER pad.
          Cohere's ONNX export has no ``encoder_attention_mask``, so the
          decoder cross-attends to any trailing silence and phrase-loops
          (re-emits the final sentence). Padding the tail — or leaving a
          silent tail in — is the loop trigger, the exact inverse of what
          Canary wants. See ``maybe_trim_trailing_silence_for_aed`` and
          the model card's noise-gate/VAD guidance.

        Order matters: trim FIRST so the pad/trim measures against the
        trimmed length, not the pre-trim length. Otherwise a 0.6 s clip
        with 0.45 s of leading silence would pass the
        ``shape[0] >= AED_MIN_SAMPLES`` check before trimming and exit
        the pad path with only 0.15 s of real audio.
        """
        engine = self._model
        if onnx_decoder_patches.is_canary_aed_engine(engine):
            trimmed = onnx_decoder_patches.maybe_trim_leading_silence_for_aed(audio)
            return onnx_decoder_patches.maybe_pad_for_aed(trimmed)
        if onnx_decoder_patches.is_cohere_engine(engine):
            trimmed = onnx_decoder_patches.maybe_trim_leading_silence_for_aed(audio)
            return onnx_decoder_patches.maybe_trim_trailing_silence_for_aed(trimmed)
        if onnx_decoder_patches.is_parakeet_transducer_engine(engine):
            return onnx_decoder_patches.maybe_prepend_silence_for_parakeet(audio)
        return audio

    @override
    def is_ready(self) -> bool:
        return self._ready

    @override
    def shutdown(self) -> None:
        """Release the ASR model's ORT sessions.

        The Silero VAD is *not* closed here — it lives in the shared
        ``_VAD_CACHE`` and is reused by the next transcriber loaded
        with the same provider tuple. Closing it would force the next
        swap to pay the load cost again, which is exactly the
        regression this cache exists to prevent.
        """
        self._ready = False
        model = self._model
        self._model = None
        # Drop our reference to the shared VAD — cache keeps the canonical one.
        self._vad = None
        # Drop the with_vad adapter cache — the model it wraps is going away.
        self._vad_adapters = {}
        if model is not None and hasattr(model, "close"):
            # Best-effort: onnx-asr's close() releases ORT sessions and, when a
            # (possibly partial) torch is importable, probes torch.cuda. A stray
            # cleanup error must never abort a swap's unload phase — the sessions
            # are dropped on GC regardless once we've nulled our reference.
            try:
                model.close()
            except Exception:
                logger.warning("onnx-asr model.close() raised during shutdown — ignoring", exc_info=True)
