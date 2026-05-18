from __future__ import annotations

import logging
import re
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

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


def _vad_cache_key(providers_tuple: tuple[Any, ...] | None) -> tuple[Any, ...]:
    """Stable cache key for a providers tuple (or the default when None)."""
    if providers_tuple is None:
        return ("__default__",)
    return providers_tuple


def _get_or_load_silero_vad(providers_tuple: tuple[Any, ...] | None) -> Any:  # noqa: ANN401
    """Return the singleton Silero VAD for these providers, loading on first miss.

    Concurrency: ``_VAD_CACHE_LOCK`` is held across the cache lookup +
    the load itself, so two transcribers constructed simultaneously
    can't double-load. The lock blocks for the full ``onnx_asr.load_vad``
    duration on a miss (100-400ms) — acceptable because the alternative
    is racy double-allocation in VRAM.
    """
    assert onnx_asr is not None  # narrowing — caller has already checked
    key = _vad_cache_key(providers_tuple)
    with _VAD_CACHE_LOCK:
        cached = _VAD_CACHE.get(key)
        if cached is not None:
            logger.info("Silero VAD cache hit (providers=%s)", key)
            return cached
        vad_kwargs: dict[str, Any] = {}
        if providers_tuple is not None:
            vad_kwargs["providers"] = providers_tuple
        logger.info("Silero VAD cache miss — loading for providers=%s", key)
        vad = onnx_asr.load_vad("silero", **vad_kwargs)
        _VAD_CACHE[key] = vad
        logger.info("Silero VAD loaded + cached")
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


def _is_external_data_missing_error(exc: BaseException) -> bool:
    """True when ``exc`` is the ORT error for a missing external-data sidecar."""
    return _EXTERNAL_DATA_MISSING_MARKER in str(exc)


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
    # Match onnx-asr's allow_patterns at examples/onnx-asr/.../resolver.py:110-115
    # so we pull exactly the files the resolver expects (no surprise extras).
    # ``*.onnx?data`` covers both istupakov ``.onnx.data`` and onnx-community
    # ``.onnx_data`` conventions in a single pattern.
    snapshot_download(
        repo,
        allow_patterns=["*.onnx", "*.onnx?data", "config.json", "config.yaml"],
    )
    return True


def _build_fp16_sess_options() -> Any:  # noqa: ANN401 — onnxruntime.SessionOptions
    """SessionOptions tuned to load onnx-community Whisper fp16 exports.

    Drops to ``ORT_ENABLE_EXTENDED``: the default ``ORT_ENABLE_ALL`` runs
    LAYOUT-level fusions including ``SimplifiedLayerNormFusion``, which
    crashes on the fp16 encoder export with ``Attempting to get index by
    a name which does not exist: InsertedPrecisionFreeCast_…``. The
    lower level is benign for our other (non-fp16) sessions when they
    happen to share this SessionOptions instance — the missing fusions
    are encoder-shape-specific and don't materially affect throughput on
    the small/mid Whisper variants.
    """
    import onnxruntime as rt

    opts = rt.SessionOptions()
    opts.graph_optimization_level = rt.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
    return opts


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

    def _on_progress(event: Any) -> None:  # noqa: ANN401 — onnx_asr.progress.DownloadProgress
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

    def __init__(
        self,
        *,
        model_name: str,
        quantization: str | None = None,
        providers: list[str | tuple[str, dict[str, str]]] | None = None,
        on_download_progress: Callable[[DownloadProgress], None] | None = None,
        segment_with_vad: bool = True,
        normalize_audio: bool = True,
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
        # Explicit fp16 selection on Whisper-family ONNX needs two
        # accommodations for the onnx-community export defects: lowered
        # session optimization to dodge an ORT SimplifiedLayerNormFusion
        # bug on the encoder, and a reactive in-cache patch of the merged
        # decoder (subgraph output names + dtype annotations). The patch
        # path fires only when the first load actually fails with the
        # specific subgraph-output error — fp16 exports of other model
        # families (or already-patched files) skip straight through.
        if quantization == "fp16":
            kwargs["sess_options"] = _build_fp16_sess_options()

        logger.info("Loading onnx-asr model %s (quantization=%s)", model_name, quantization)
        self._model: Any = self._load_model_with_fp16_repair(model_name, kwargs)
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
        if segment_with_vad:
            self._vad = _get_or_load_silero_vad(providers_tuple)
        else:
            logger.info("Silero VAD skipped (segment_with_vad=False — bounded-short caller)")

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

    def _recognize_direct(self, audio: AudioArray, lang_arg: str | None) -> list[tuple[float, float, str]]:
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
        try:
            text = self._model.recognize(audio, **recognize_kwargs)
        except TypeError:
            recognize_kwargs.pop("language", None)
            text = self._model.recognize(audio, **recognize_kwargs)
        return [(0.0, 0.0, text or "")]

    def _recognize_vad_segments(
        self,
        audio: AudioArray,
        lang_arg: str | None,
        *,
        merge: bool,
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
        vad_kwargs: dict[str, Any] = {"max_speech_duration_s": self._VAD_MAX_SPEECH_DURATION_S}
        if merge:
            vad_kwargs["min_silence_duration_ms"] = self._VAD_MIN_SILENCE_MS
        adapter = self._model.with_vad(self._vad, **vad_kwargs)
        recognize_kwargs: dict[str, Any] = {"sample_rate": 16_000}
        if lang_arg is not None:
            recognize_kwargs["language"] = lang_arg

        try:
            segments_iter = adapter.recognize(audio, **recognize_kwargs)
        except TypeError:
            # Some models don't accept the language kwarg through with_vad.
            recognize_kwargs.pop("language", None)
            segments_iter = adapter.recognize(audio, **recognize_kwargs)

        return [(float(s.start), float(s.end), s.text) for s in segments_iter]

    @override
    def transcribe(
        self,
        audio: AudioArray,
        language: str = "",
        use_prompt: bool = True,
    ) -> TranscriptionResult:
        start_t = time.time()
        lang_arg = language if language else None

        # Plain text: merge VAD chunks for speed — granularity is irrelevant
        # once the segment texts are concatenated.
        segments = self._recognize(audio, lang_arg, merge=True)
        text = " ".join(seg_text.strip() for _, _, seg_text in segments if seg_text.strip())

        elapsed = time.time() - start_t
        return TranscriptionResult(
            text=text,
            language=language,
            language_probability=0.0,
            duration_seconds=elapsed,
        )

    def transcribe_segments(
        self,
        audio: AudioArray,
        language: str = "",
    ) -> list[tuple[float, float, str]]:
        """Segmented transcription with global timestamps, for SRT export.

        Same WhisperX-style VAD pipeline as :meth:`transcribe`, but with
        ``merge=False`` so cues stay short and readable — a 29 s merged
        subtitle block is unusable. Trades the merge speedup for correct
        subtitle granularity; SRT export is an explicit, infrequent action.
        """
        lang_arg = language if language else None
        return self._recognize(audio, lang_arg, merge=False)

    def _recognize(self, audio: AudioArray, lang_arg: str | None, *, merge: bool) -> list[tuple[float, float, str]]:
        """Dispatch to the VAD-segmented or direct path per ``segment_with_vad``.

        ``merge`` is forwarded to the VAD path (ignored on the direct path,
        which has no VAD to merge).

        Peak-normalization (when enabled) happens here, the single
        chokepoint shared by :meth:`transcribe`, :meth:`transcribe_segments`,
        the realtime windows, and file transcription (which reuses this
        instance) — so every path gets the same conditioning, and the
        long-audio path's internal Silero segmentation VAD sees the
        normalized signal too.
        """
        if self._normalize_audio:
            audio = _peak_normalize(audio)
        if self._segment_with_vad:
            return self._recognize_vad_segments(audio, lang_arg, merge=merge)
        return self._recognize_direct(audio, lang_arg)

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
        if model is not None and hasattr(model, "close"):
            model.close()
