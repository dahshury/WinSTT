from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

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
        providers: list[str] | None = None,
        on_download_progress: Callable[[DownloadProgress], None] | None = None,
        segment_with_vad: bool = True,
    ) -> None:
        if onnx_asr is None:
            msg = "onnx_asr is not installed"
            raise RuntimeError(msg)

        providers_tuple: tuple[str, ...] | None = tuple(providers) if providers else None

        kwargs: dict[str, Any] = {"quantization": quantization}
        if providers_tuple is not None:
            kwargs["providers"] = providers_tuple
        if on_download_progress is not None:
            kwargs["progress_callback"] = _make_progress_adapter(model_name, on_download_progress)

        logger.info("Loading onnx-asr model %s (quantization=%s)", model_name, quantization)
        self._model: Any = onnx_asr.load_model(model_name, **kwargs)
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
        self._segment_with_vad = segment_with_vad
        self._vad: Any = None
        if segment_with_vad:
            vad_kwargs: dict[str, Any] = {}
            if providers_tuple is not None:
                vad_kwargs["providers"] = providers_tuple
            logger.info("Loading Silero VAD for transcription-time segmentation")
            self._vad = onnx_asr.load_vad("silero", **vad_kwargs)
            logger.info("Silero VAD loaded")
        else:
            logger.info("Silero VAD skipped (segment_with_vad=False — bounded-short caller)")

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
        """
        if self._segment_with_vad:
            return self._recognize_vad_segments(audio, lang_arg, merge=merge)
        return self._recognize_direct(audio, lang_arg)

    @override
    def is_ready(self) -> bool:
        return self._ready

    @override
    def shutdown(self) -> None:
        """Release the model and its ORT sessions via onnx-asr's lifecycle API.

        Releases both the ASR sessions and the always-loaded Silero VAD so
        a model swap doesn't leak GPU memory.
        """
        self._ready = False
        model = self._model
        vad = self._vad
        self._model = None
        self._vad = None
        if model is not None and hasattr(model, "close"):
            model.close()
        if vad is not None and hasattr(vad, "close"):
            vad.close()
