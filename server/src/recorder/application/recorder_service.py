from __future__ import annotations

import collections
import gc
import logging
import queue
import re
import threading
import time
from dataclasses import dataclass
from types import TracebackType
from typing import TYPE_CHECKING, Any, ClassVar

import numpy as np

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.building_blocks.types import AudioChunk, BufferSize, SampleRate

if TYPE_CHECKING:
    from collections.abc import Callable

    from src.building_blocks.types import TextCallback
    from src.recorder.application.swap_benchmark import SwapBenchmark
    from src.recorder.domain.events import SpeakerSegment
    from src.recorder.domain.model_registry import ModelInfo
    from src.recorder.domain.ports.transcriber import TranscriptionResult
from src.recorder.application.pipeline import RecordingPipeline
from src.recorder.application.realtime_stabilizer import RealtimeStabilizer
from src.recorder.domain.audio_buffer import AudioBuffer
from src.recorder.domain.config import RecorderConfig
from src.recorder.domain.errors import DownloadCancelledError, InvalidStateTransition
from src.recorder.domain.events import (
    DiarizationToggleCompleted,
    DiarizationToggleFailed,
    DiarizationToggleStarted,
    DownloadProgress,
    ModelSwapCompleted,
    ModelSwapFailed,
    ModelSwapStarted,
    NoAudioDetected,
    RealtimeTranscriptionStabilized,
    RealtimeTranscriptionUpdate,
    SpeakerSegmentsDetected,
    TranscriptionCompleted,
    TranscriptionStarted,
)
from src.recorder.domain.ports.audio_source import IAudioSource
from src.recorder.domain.ports.diarizer import IDiarizer
from src.recorder.domain.ports.transcriber import ITranscriber
from src.recorder.domain.ports.vad import IVoiceActivityDetector
from src.recorder.domain.ports.wake_word import IWakeWordDetector
from src.recorder.domain.state_machine import RecorderState, RecorderStateMachine
from src.recorder.domain.swap_errors import (
    SwapErrorCategory,
    SwapErrorInfo,
    classify_swap_error,
    superseded_info,
)

logger = logging.getLogger(__name__)

# Stable-text accumulator constants for the realtime worker.
#
# Whisper isn't a streaming model: faster_whisper's BatchedInferencePipeline
# splits audio at 30s VAD chunk boundaries. If we feed it the full growing
# buffer, the first chunk's transcribed text becomes byte-identical on every
# call (same audio → same output), pushing similarity past 0.99 and tripping
# the noise-repetition stop in stt_server/text_processing.py. If we instead
# feed only a sliding window, the live preview shows only the recent audio
# and earlier dictation appears to "scroll out".
#
# The accumulator pattern resolves both: every ~REALTIME_COMMIT_AFTER_SECONDS
# of fresh audio we transcribe-and-commit a chunk into _realtime_committed_text
# and advance a frame watermark; ongoing realtime calls only ever transcribe
# audio past the watermark (always ≤ commit interval), and we emit
# committed_text + current_text so the preview keeps growing for the whole
# recording. Mirrors RealtimeSTT's text_storage / safetext idea but uses a
# bounded input window so latency stays flat for 30+ minute recordings.
REALTIME_COMMIT_AFTER_SECONDS = 20.0


@dataclass
class _RealtimeLoopState:
    """Per-loop mutable state for the realtime worker (was loop-local vars)."""

    last_transcription: float
    recording_seen_at: float | None = None
    # Last frame_count we actually transcribed. The realtime worker skips
    # iterations where the audio buffer hasn't grown since this value —
    # otherwise a stuck recording state (the pipeline never transitions
    # to TRANSCRIBING after PTT release for some reason) would spin the
    # worker tight-looping on the same stale audio, burning CPU/GPU and
    # republishing the same preview text endlessly. Reset to -1 each
    # time recording transitions inactive → active so the first real
    # iteration of a new utterance always proceeds.
    last_processed_frame_count: int = -1


class _SwapProgress:
    """Download-progress callback that doubles as a cancellation checkpoint.

    onnx-asr fires this synchronously from within ``load_model``; raising
    ``DownloadCancelledError`` here aborts the HuggingFace download mid-fetch
    (partial bytes stay on disk and ``huggingface_hub`` resumes them next
    time). Replaces the former ``progress_with_cancel`` closure so it is
    independently unit-testable.
    """

    def __init__(self, service: RecorderService, name: str, cancel_event: threading.Event) -> None:
        self._service = service
        self._name = name
        self._cancel_event = cancel_event

    def __call__(self, info: DownloadProgress) -> None:
        if self._cancel_event.is_set():
            raise DownloadCancelledError(self._name)
        self._forward(info)

    def _forward(self, info: DownloadProgress) -> None:
        sink = self._service._swap_progress_sink
        if sink is None:
            return
        try:
            sink(info)
        except Exception:
            logger.exception("swap progress sink raised")


class RecorderService:
    def __init__(
        self,
        *,
        audio_source: IAudioSource,
        vad: IVoiceActivityDetector,
        transcriber: ITranscriber,
        wake_word_detector: IWakeWordDetector | None = None,
        realtime_transcriber: ITranscriber | None = None,
        diarizer: IDiarizer | None = None,
        config: RecorderConfig,
        event_bus: EventBus,
        clock: Clock | None = None,
    ) -> None:
        self._audio_source = audio_source
        self._vad = vad
        self._transcriber = transcriber
        self._wake_word_detector = wake_word_detector
        self._realtime_transcriber = realtime_transcriber
        # Diarizer is optional — None means "no per-utterance speaker labels".
        # Wired by the facade only when ``DiarizationConfig.enabled`` is true.
        self._diarizer = diarizer
        self._config = config
        self._event_bus = event_bus
        self._clock = clock if clock is not None else Clock.system_clock()

        self._state_machine = RecorderStateMachine()
        self._audio_buffer = AudioBuffer(
            sample_rate=SampleRate(config.audio.sample_rate),
            buffer_size=BufferSize(config.audio.buffer_size),
            pre_recording_buffer_duration=config.vad.pre_recording_buffer_duration,
        )

        self._pipeline = RecordingPipeline(
            audio_source=audio_source,
            vad=vad,
            transcriber=transcriber,
            wake_word_detector=wake_word_detector,
            config=config,
            event_bus=event_bus,
            clock=self._clock,
            state_machine=self._state_machine,
            audio_buffer=self._audio_buffer,
        )

        self._is_running = False
        self._microphone_enabled: bool = config.audio.use_microphone
        self._external_audio_mode: bool = False
        self._audio_reader_thread: threading.Thread | None = None
        self._realtime_thread: threading.Thread | None = None
        self._transcription_result: queue.Queue[str] = queue.Queue()
        self._feed_buffer = bytearray()
        # Per-slot transcriber locks. The realtime worker and main ``text()``
        # both call ``_safe_transcribe``; when the slots hold *different*
        # transcriber instances (the default — ``use_main_model_for_realtime``
        # is off), serialising them on a single lock means main waits behind
        # an in-flight realtime full-buffer transcribe at end of dictation
        # (the realtime fresh-window pass can be ~equal in size to the final
        # main pass right before PTT release). Profiling showed ~390 ms added
        # to a JFK-length dictation from that contention. Per-slot locks make
        # main + realtime independent for the common case while still pinning
        # the same lock to both slots when they share a transcriber instance
        # (so the ORT session — which isn't reentrant-safe — is still
        # serialised against itself).
        self._main_transcriber_lock = threading.Lock()
        self._realtime_transcriber_lock: threading.Lock = self._pick_realtime_lock(transcriber, realtime_transcriber)
        # Canonical "fully warm" gate. Flipped to True at the end of
        # :meth:`warmup` once main + realtime + diarizer have all run a
        # dummy inference. The WS server consults :attr:`is_warm` when
        # building the structured ``server_ready`` payload, and the
        # renderer's connection chip greens only when this is true.
        # ``_background_warmup_event`` is the threading primitive the
        # event wraps so callers (tests, runtime-info builders) can
        # ``wait_for_background_warmup(timeout=…)`` without polling.
        self._is_warm = False
        self._background_warmup_event = threading.Event()
        # Realtime stable-text accumulator state — owned and reset by the
        # realtime worker thread.
        self._realtime_committed_text: str = ""
        self._realtime_committed_frames: int = 0
        # RealtimeSTT-faithful text stabilizer: turns Whisper's flickery
        # per-call output into a UI-safe monotonic stream. See
        # ``realtime_stabilizer.py`` for the algorithm. Reset alongside
        # ``_realtime_committed_text`` at the start of each fresh recording.
        self._realtime_stabilizer = RealtimeStabilizer()
        # Last full text the realtime worker published (committed + fresh).
        # Survives the recording-end accumulator reset so ``text()`` can reuse
        # it as the final transcription when ``use_main_model_for_realtime`` is
        # on — skipping a duplicate whole-buffer pass through the same model.
        # Cleared at the start of each fresh recording.
        self._last_realtime_text: str = ""
        # Per-kind in-flight model swap bookkeeping. ``request_model_swap``
        # cancels prior swaps for the same kind by setting their event.
        self._swap_threads: dict[str, threading.Thread] = {}
        self._swap_cancel_events: dict[str, threading.Event] = {}
        # Optional download-progress sink reused by ``request_model_swap``
        # so swap downloads report through the same callback chain as
        # boot-time downloads (renderer subscribes once at startup).
        # Wired by the facade in __init__.py when DownloadCallbacks are
        # available; ``None`` means progress events are dropped (still
        # safe — the swap completes either way).
        self._swap_progress_sink: Any = None
        # Diarization toggle bookkeeping — single-slot (only one kind of
        # toggle, unlike model_swap which has main + realtime). A second
        # request mid-flight sets the event so the worker exits its next
        # checkpoint and emits a SUPERSEDED failure for the prior attempt.
        self._diar_toggle_thread: threading.Thread | None = None
        self._diar_toggle_cancel_event: threading.Event | None = None
        # Atomic-ish lock for diarizer slot mutations. ``_safe_diarize``
        # reads ``self._diarizer is None`` (CPython atomic), so a torn
        # read is impossible — this lock just serialises the toggle
        # worker against itself + any future concurrent updaters.
        self._diarizer_lock = threading.Lock()
        # Idle-unload bookkeeping. ``_last_activity_at`` is bumped on
        # every ``transcribe()`` completion and on ``listen()`` so a
        # waiting-for-PTT session counts as "active" and never trips the
        # timer mid-conversation. The timer thread polls every 30 s and
        # tears down the main + realtime transcribers if the configured
        # timeout has elapsed. Next ``transcribe()`` synchronously
        # reloads via :meth:`_ensure_models_loaded` so the first PTT
        # after a tear-down pays the cold-load cost but subsequent
        # presses are free.
        #
        # Three modes, mirroring Handy's :class:`ModelUnloadTimeout`:
        #   * ``None``          — never unload (Handy's ``Never``)
        #   * ``0``             — unload right after every transcription
        #                         (Handy's ``Immediately``). The poller
        #                         thread is NOT started in this mode;
        #                         tear-down happens synchronously from
        #                         the end of ``text()`` / ``transcribe()``.
        #   * positive ``int``  — idle seconds; poller wakes every 30 s.
        self._unload_timeout_seconds: int | None = config.transcription.model_unload_timeout_seconds
        self._last_activity_at: float = self._clock.get_current_time()
        self._unload_check_thread: threading.Thread | None = None
        self._unload_stop_event = threading.Event()
        # Remember the names we loaded with so a lazy-reload after
        # tear-down rebuilds the SAME models the user had configured at
        # boot. A model_swap between unload events also updates these
        # via the install-transcriber path. Empty string for realtime
        # when the worker is disabled.
        self._saved_main_model_name: str = config.transcription.model
        self._saved_realtime_model_name: str = (
            config.realtime.realtime_model_type if config.realtime.enable_realtime_transcription else ""
        )
        # Lock for serializing lazy-reload attempts so two concurrent
        # transcribe paths (e.g. main text() and the realtime worker)
        # don't both try to rebuild the same model at the same time.
        # The transcriber lock alone isn't sufficient because the load
        # itself happens *outside* the slot lock (long-running) — we
        # need a separate gate that says "someone is already reloading,
        # wait for them."
        self._lazy_reload_lock = threading.Lock()
        if self._unload_timeout_seconds is not None and self._unload_timeout_seconds > 0:
            self._start_unload_check_thread()

    def _pick_realtime_lock(
        self,
        transcriber: ITranscriber,
        realtime_transcriber: ITranscriber | None,
    ) -> threading.Lock:
        """Share the main lock when both slots hold the same transcriber OR when
        either is running on ORT's DirectML execution provider.

        Two cases force a shared lock:

        1. **Same instance in both slots.** A shared ORT session isn't
           reentrant-safe, so the same instance in both slots must serialise
           against itself.

        2. **DirectML in the active provider list.** ORT-DirectML 1.x has a
           documented concurrent-session reentrancy bug: two independent
           ``InferenceSession``s on the same ``IDMLDevice`` running inference
           back-to-back from different threads trip
           ``Windows fatal exception: code 0xc0000374`` (STATUS_HEAP_CORRUPTION)
           deep inside ``run_with_iobinding`` — most reliably on the whisper
           decoder's KV-cache binding path. The Microsoft-recommended
           workaround (see onnxruntime/issues #15883 / #22034 and the
           DirectML EP docs' "thread safety" note) is to serialise every
           inference call through one process-wide mutex; the underlying
           ``IDMLDevice`` is single-threaded by D3D12 design. Sharing the
           main lock with the realtime slot does exactly that, and matches
           the user-facing design intent ("once realtime finishes, main
           takes over and transcribes the whole thing"). The 80-100 ms of
           added end-of-dictation latency (main waiting for the last
           realtime tick on a whisper-tiny window) is well below the
           perception threshold and worth trading for stability.

        Distinct CUDA / CoreML / CPU instances still get independent locks
        so main + realtime run in parallel where the EP is thread-safe.
        """
        if realtime_transcriber is not None and realtime_transcriber is transcriber:
            return self._main_transcriber_lock
        if self._uses_directml(transcriber) or self._uses_directml(realtime_transcriber):
            logger.warning(
                "Serialising realtime + main transcribers on a single lock "
                "(DirectML EP detected — ORT-DirectML's concurrent-session "
                "heap-corruption workaround). Costs ~80-100 ms at end-of-dictation; "
                "buys process stability.",
            )
            return self._main_transcriber_lock
        return threading.Lock()

    @staticmethod
    def _uses_directml(transcriber: ITranscriber | None) -> bool:
        """True when ``transcriber`` reports DirectML in its active providers.

        ``OnnxAsrTranscriber.active_providers`` is a ``@property`` returning
        ``list[str]`` — not a method — so we read it directly via ``getattr``
        with a default of ``[]`` to defend against transcriber adapters
        that don't expose it (cloud remote transcribers, fakes in tests).
        Those return False so they keep the historical independent-lock fast path.
        """
        if transcriber is None:
            return False
        providers: object = getattr(transcriber, "active_providers", [])
        # Properties return the value; callables (legacy or test fakes) need invoking.
        if callable(providers):
            try:
                providers = providers()
            except Exception:  # pragma: no cover — defensive
                logger.debug("active_providers() raised; assuming non-DML", exc_info=True)
                return False
        try:
            iterator = iter(providers)  # type: ignore[arg-type]
        except TypeError:
            return False
        return any("DmlExecutionProvider" in str(p) for p in iterator)

    def text(self, on_transcription_finished: TextCallback | None = None) -> str:
        # Idle-unload daemon (Handy parity) tears the transcribers down
        # after N minutes of inactivity. Rebuild lazily on first use so
        # the user's PTT after a long idle works transparently — pay the
        # cold-load cost once on this press, then back to fast.
        self._mark_activity()
        self._ensure_main_transcriber_loaded()
        self.listen()
        if not self.wait_audio():
            self._audio_buffer.clear()
            return ""
        frame_count = self._audio_buffer.frame_count
        audio_seconds = self._audio_buffer.duration_seconds
        raw_audio = b"".join(self._audio_buffer.frames)
        audio = self._pad_short_audio(self._audio_buffer.get_audio_array())
        self._audio_buffer.clear()
        self._event_bus.publish(TranscriptionStarted(timestamp=self._clock.get_current_time(), audio=raw_audio))

        # Reuse the realtime worker's last committed+fresh output when it ran
        # the SAME model end-to-end. Skips a duplicate whole-buffer pass that
        # would produce the same answer the user already saw in the live
        # preview. The realtime worker chunks audio into committed pieces plus
        # one fresh window — that piecewise output is acceptable as a final
        # result when use_main_model_for_realtime is on and the user has opted
        # into that tradeoff via the toggle.
        reused = self._reuse_realtime_text_if_eligible()
        if reused is not None:
            text = reused
            logger.warning(
                "[main-transcribe] REUSED realtime text (%d frames, %.2fs) — %d chars",
                frame_count,
                audio_seconds,
                len(text),
            )
        else:
            text = self._run_full_transcription(audio, frame_count, audio_seconds)

        wav_path = self._maybe_save_wav(raw_audio)
        self._event_bus.publish(
            TranscriptionCompleted(
                timestamp=self._clock.get_current_time(),
                text=text,
                wav_path=wav_path,
            )
        )
        self._maybe_emit_speaker_segments(audio, text)
        self._finalize_transcription_state()
        self._dispatch_transcription_callback(on_transcription_finished, text)
        self._maybe_unload_immediately()
        return text

    def _maybe_save_wav(self, raw_audio: bytes) -> str:
        """Persist the just-captured PCM to a WAV under ``HistoryConfig.recordings_dir``.

        Returns the absolute path on success, "" when:
          * ``HistoryConfig.save_wav`` is False (default),
          * the audio buffer is empty (PTT release with no speech),
          * the recordings dir is unwritable (logged + swallowed).

        Kept tiny + branch-light so the per-utterance hot path stays cheap
        when the feature is off — short-circuits before importing the writer
        module.
        """
        history = self._config.history
        if not history.save_wav:
            return ""
        # Import lazily so a config-disabled run never imports the wave stdlib
        # or hits the recordings dir.
        from src.recorder.application.wav_writer import write_pcm_wav

        return write_pcm_wav(
            history.recordings_dir,
            raw_audio,
            sample_rate=self._config.audio.sample_rate,
            timestamp=self._clock.get_current_time(),
        )

    def _maybe_emit_speaker_segments(self, audio: np.ndarray[Any, Any], text: str) -> None:
        """Diarize and publish speaker segments after the transcript event.

        Runs *after* :class:`TranscriptionCompleted` so a slow diarizer
        never delays text delivery — the segments reach the client a beat
        later and are applied to the already-rendered text. No-op when no
        diarizer is wired or the transcript is empty.
        """
        if self._diarizer is None or not text:
            return
        segments = self._safe_diarize(audio)
        self._event_bus.publish(SpeakerSegmentsDetected(timestamp=self._clock.get_current_time(), segments=segments))

    def _safe_diarize(self, audio: np.ndarray[Any, Any]) -> tuple[SpeakerSegment, ...]:
        """Diarize, swallowing any failure (never crash ``text()``)."""
        diarizer = self._diarizer
        if diarizer is None:  # pragma: no cover - guarded by caller
            return ()
        try:
            return diarizer.diarize(audio)
        except Exception:
            logger.exception("[diarizer] diarize failed; skipping speaker_segments emission")
            return ()

    @staticmethod
    def _audio_stats(audio: np.ndarray[Any, Any]) -> tuple[float, float, float]:
        """Peak / RMS / nonzero-fraction of an audio buffer (0.0 when empty)."""
        if audio.size == 0:
            return 0.0, 0.0, 0.0
        peak = float(np.max(np.abs(audio)))
        rms = float(np.sqrt(np.mean(audio * audio)))
        nonzero_frac = float(np.count_nonzero(audio)) / audio.size
        return peak, rms, nonzero_frac

    def _pad_short_audio(self, audio: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
        """Zero-pad sub-1 s clips up to 1.25 s so Whisper still gets a usable
        encoder window. Mirrors Handy's ``stop_recording`` policy at
        ``examples/Handy/src-tauri/src/managers/audio.rs`` — they pad to
        ``WHISPER_SAMPLE_RATE * 5 / 4`` whenever the clip is non-empty and
        shorter than one second. Empty buffers pass through untouched."""
        sample_rate = self._config.audio.sample_rate
        if 0 < audio.size < sample_rate:
            target = sample_rate * 5 // 4
            return np.pad(audio, (0, target - audio.size))
        return audio

    def _safe_transcribe(
        self,
        transcriber: ITranscriber | None,
        audio: np.ndarray[Any, Any],
        language: str,
        *,
        lock: threading.Lock | None = None,
        use_prompt: bool = True,
    ) -> TranscriptionResult | None:
        """Call ``transcriber.transcribe`` under the slot's lock if available.

        Returns ``None`` when the slot is empty or the transcriber is
        mid-shutdown — both transient states during a model swap. The
        lock is held for the whole call so the swap worker can't yank
        the model out from under us between the readiness check and the
        transcribe call.

        ``lock`` defaults to the main lock for backward compatibility with
        ``transcribe()`` and warmup paths; explicit per-slot locks are
        passed by the main-text and realtime-worker call sites so they no
        longer block each other on different transcriber instances.

        ``use_prompt`` gates the Whisper initial-prompt prefix that biases
        the decoder toward user ``custom_words``. The realtime worker
        sets it to ``False`` — its windows are short and the prompt
        latency overhead would compound per tick. The realtime path uses
        the post-decode rapidfuzz pass for custom-word correction
        instead. The realtime worker also passes ``custom_words=None``
        implicitly via this gate.
        """
        if lock is None:
            lock = self._main_transcriber_lock
        cw = self._config.text_correction.custom_words if use_prompt else None
        # ``initial_prompt`` (free-form prior-text from the frontend's UIA
        # composer) is the preferred decoder-bias channel; it's richer than
        # the dictionary list because it carries the actual caret-leading
        # text. The transcriber falls back to ``custom_words`` when this is
        # empty, preserving the legacy dict-only behaviour.
        ipt: str | None
        if use_prompt:
            cfg_ipt = self._config.transcription.initial_prompt
            ipt = cfg_ipt if isinstance(cfg_ipt, str) else None
        else:
            ipt = None
        with lock:
            if not self._transcriber_ready(transcriber):
                return None
            assert transcriber is not None  # narrowed by _transcriber_ready
            try:
                return transcriber.transcribe(
                    audio,
                    language,
                    use_prompt=use_prompt,
                    custom_words=cw,
                    initial_prompt_text=ipt,
                )
            except Exception:
                # Catch-all because the failure modes here are dominated by
                # backend-specific exceptions we can't import without taking
                # a hard dep on every provider's pybind module:
                #   * ``onnxruntime.capi.onnxruntime_pybind11_state.RuntimeException``
                #     — kernel exception in the EP (e.g. DML's ``node_view``
                #     Reshape crashing on Canary-180M-int8, seen in the wild).
                #   * ``onnxruntime.capi.onnxruntime_pybind11_state.Fail``
                #     — session-level dispatch failure.
                #   * CUDA OOM surfacing through CuPy/torch on the
                #     sentence-classifier path.
                # Without this guard the exception propagates up through
                # ``text()`` → ``_recorder_thread`` (see ``server.py``) and
                # kills the worker thread silently — the user then has to
                # restart the server to dictate again. Returning ``None``
                # routes through the same caller path as a swap-in-flight
                # skip, which produces an empty TranscriptionCompleted and
                # keeps the recorder alive for the next utterance.
                # ``logger.exception`` preserves the full traceback so the
                # underlying kernel error stays diagnosable in stt-server.log.
                logger.exception("[transcribe] transcriber raised; treating as skipped (returning None)")
                return None

    @staticmethod
    def _transcriber_ready(transcriber: ITranscriber | None) -> bool:
        """Whether ``transcriber`` is wired and past its readiness check."""
        return transcriber is not None and transcriber.is_ready()

    def _run_full_transcription(
        self,
        audio: np.ndarray[Any, Any],
        frame_count: int,
        audio_seconds: float,
    ) -> str:
        # Audio statistics — proves whether the buffer holds real speech
        # samples or zeros/silence at the moment we hand it to the model.
        # If peak ≈ 0 the mic stream has been overwritten with silence
        # somewhere; if peak is healthy (> 0.05) and we still get an
        # empty transcription, the VAD inside BatchedInferencePipeline is
        # discarding the audio.
        audio_peak, audio_rms, nonzero_frac = self._audio_stats(audio)
        logger.warning(
            "[main-transcribe] starting on %d frames (%.2fs of audio) — "
            "samples=%d peak=%.4f rms=%.4f nonzero_frac=%.4f",
            frame_count,
            audio_seconds,
            audio.size,
            audio_peak,
            audio_rms,
            nonzero_frac,
        )
        transcribe_start = time.time()
        result = self._safe_transcribe(self._transcriber, audio, self._config.transcription.language)
        if result is None:
            # Swap-in-flight: the user's dictation can't be transcribed
            # right now. Log it so the gap is visible in logs but don't
            # crash the pipeline. The UI is already showing "Switching
            # to {model}..." so the user understands why.
            logger.warning("[main-transcribe] skipped — model swap in progress")
            return ""
        text = self._preprocess_output(result.text, language=result.language)
        logger.warning(
            "[main-transcribe] done in %.2fs — text length=%d chars",
            time.time() - transcribe_start,
            len(text),
        )
        return text

    def _finalize_transcription_state(self) -> None:
        if self._state_machine.state == RecorderState.TRANSCRIBING:
            self._state_machine.transition(RecorderState.INACTIVE)

    @staticmethod
    def _dispatch_transcription_callback(
        on_transcription_finished: TextCallback | None,
        text: str,
    ) -> None:
        if on_transcription_finished is not None:
            threading.Thread(target=on_transcription_finished, args=(text,), daemon=True).start()

    def _reuse_realtime_text_if_eligible(self) -> str | None:
        """Return realtime worker's last text when it can stand in for a full pass.

        Eligible iff: realtime transcription is enabled, the realtime worker
        was wired to the SAME transcriber instance as the main one (the
        ``use_main_model_for_realtime`` toggle), and we actually have a
        non-empty text from the most recent realtime tick. Otherwise the
        caller must run the full transcription itself.
        """
        if not self._realtime_reuse_enabled():
            return None
        cached = self._last_realtime_text
        # Clear immediately so a later text() call after a short recording with
        # no realtime output falls back to the real transcribe path instead of
        # reusing yesterday's preview.
        self._last_realtime_text = ""
        return cached if cached else None

    def _realtime_reuse_enabled(self) -> bool:
        """True iff the realtime worker ran the same model end-to-end."""
        rt = self._config.realtime
        return (
            rt.enable_realtime_transcription
            and rt.use_main_model_for_realtime
            and self._realtime_transcriber is self._transcriber
        )

    def start(self) -> RecorderService:
        # Property-test finding (test_recorder_service_stateful): start() during
        # TRANSCRIBING (or any other non-startable state) races a pending
        # transcription. PTT callers expect this to be a quiet no-op rather than
        # crash with the lower-level InvalidStateTransition leaking out.
        current_state = self._state_machine.state
        try:
            self._pipeline.request_start()
        except InvalidStateTransition:
            logger.info("start() ignored: pipeline busy (state=%s)", current_state.name)
        return self

    def stop(
        self,
        backdate_stop_seconds: float = 0.0,
        backdate_resume_seconds: float = 0.0,
    ) -> RecorderService:
        self._pipeline.request_stop(backdate_seconds=backdate_stop_seconds)
        return self

    def listen(self) -> None:
        if not self._is_running:
            self._start_pipeline()
        self._pipeline.request_listen()

    def feed_audio(
        self,
        chunk: AudioChunk | np.ndarray[Any, Any],
        original_sample_rate: int = 16000,
    ) -> None:
        if isinstance(chunk, np.ndarray):
            chunk = self._ndarray_to_pcm_bytes(chunk, original_sample_rate)

        # Buffer small chunks before feeding the pipeline (Silero VAD
        # needs exactly buffer_size samples = buffer_size*2 bytes).
        # Matches the monolith: buf_size = 2 * buffer_size (in bytes).
        self._feed_buffer += chunk
        buf_size = 2 * self._config.audio.buffer_size  # 2 bytes per int16 sample
        while len(self._feed_buffer) >= buf_size:
            to_process = bytes(self._feed_buffer[:buf_size])
            self._feed_buffer = self._feed_buffer[buf_size:]
            self._pipeline.feed_audio(to_process)

    def _ndarray_to_pcm_bytes(
        self,
        arr: np.ndarray[Any, Any],
        original_sample_rate: int,
    ) -> bytes:
        if arr.ndim == 2:
            arr = np.mean(arr, axis=1)
        if original_sample_rate != self._config.audio.sample_rate:
            from scipy.signal import resample_poly

            # Polyphase (not FFT `resample`): the FFT path assumes a
            # periodic signal and rings at the edges of every fed chunk —
            # audible/measurable boundary artifacts on the loopback/external
            # feed. resample_poly applies a windowed-sinc anti-alias FIR and
            # has no periodicity assumption. Mirrors pyaudio_source._resample.
            arr = resample_poly(arr.astype(np.float64), self._config.audio.sample_rate, original_sample_rate)
        arr = arr.astype(np.int16)
        return bytes(arr.tobytes())

    def set_microphone(self, microphone_on: bool = True) -> None:
        """Toggle microphone capture on/off.

        When ``microphone_on=True``: resume hardware capture so the
        audio reader thread starts feeding real chunks to the pipeline.
        When ``microphone_on=False``: pause hardware capture (the OS
        mic-in-use indicator turns off, no further audio chunks are
        produced) AND, if a recording is currently in progress, stop
        it immediately so transcription kicks off without waiting for
        silence-based endpoint detection (PTT release should feel snappy).

        Wake-word mode is the exception: when a wake-word detector is
        configured, the recorder needs continuous capture to listen for
        the hotword. In that case pause()/resume() are skipped — the
        ``_microphone_enabled`` flag still gates feed_audio so the
        pipeline state machine still sees the on/off transition.

        When ``microphone_on=False`` AND
        ``AudioConfig.extra_recording_buffer_ms > 0`` AND a recording is
        in progress, the pause + stop sequence is deferred to a daemon
        thread that sleeps the configured ms first. The mic keeps
        capturing during the sleep so trailing syllables that escape
        just after the PTT key-up still land in the buffer. Mirrors
        Handy's ``extra_recording_buffer_ms`` (see
        ``examples/Handy/src-tauri/src/managers/audio.rs``).
        """
        self._microphone_enabled = microphone_on
        if not microphone_on and self._should_defer_microphone_off():
            self._spawn_tail_buffer_thread()
            return
        # Wake-word backends require always-on capture so the detector
        # can listen for the trigger word; for everything else we toggle
        # the hardware stream so the OS mic indicator follows user intent.
        if self._wake_word_detector is None:
            self._toggle_hardware_capture(microphone_on)
        if not microphone_on:
            self._handle_microphone_off()

    def _should_defer_microphone_off(self) -> bool:
        """Whether to delay the off-sequence to capture a recording tail.

        Only meaningful when (a) a tail window is configured, (b) we're
        actively recording so there's something to extend, and (c) the
        wake-word backend isn't in play (those keep capturing anyway, so
        the tail buffer is already implicit in their always-on capture).
        Returning False here falls through to the immediate flow.
        """
        return (
            self._config.audio.extra_recording_buffer_ms > 0
            and self._state_machine.is_recording
            and self._wake_word_detector is None
        )

    def _spawn_tail_buffer_thread(self) -> None:
        """Run the off-sequence after the configured tail window.

        Daemon thread so server shutdown doesn't have to join. Single
        daemon per call — a second ``set_microphone(False)`` arriving
        during the sleep would spawn its own thread, but the state-
        machine guards in ``_handle_microphone_off`` make the duplicate
        call a no-op (recording is no longer in progress by then).
        """
        threading.Thread(
            target=self._run_delayed_microphone_off,
            daemon=True,
            name="extra-recording-buffer",
        ).start()

    def _run_delayed_microphone_off(self) -> None:
        """Sleep the tail window, then run the normal off sequence."""
        sleep_seconds = self._config.audio.extra_recording_buffer_ms / 1000.0
        time.sleep(sleep_seconds)
        if self._wake_word_detector is None:
            self._toggle_hardware_capture(False)
        self._handle_microphone_off()

    def _toggle_hardware_capture(self, microphone_on: bool) -> None:
        action = self._audio_source.resume if microphone_on else self._audio_source.pause
        try:
            action()
        except Exception:
            logger.exception("audio_source capture toggle raised (microphone_on=%s)", microphone_on)

    def _handle_microphone_off(self) -> None:
        if self._state_machine.is_recording:
            logger.warning("[set_microphone] off → request_stop (PTT release / toggle off)")
            self._pipeline.request_stop()
        elif self._state_machine.state in (RecorderState.LISTENING, RecorderState.INACTIVE):
            # User released without producing any speech — surface that.
            self._event_bus.publish(NoAudioDetected(timestamp=self._clock.get_current_time()))

    def clear_feed_buffer(self) -> None:
        """Discard any partial audio data buffered by ``feed_audio``."""
        self._feed_buffer = bytearray()

    def set_input_device(self, device_index: int | None) -> None:
        """Hot-swap the OS input device on the running audio source.

        The recorder's audio reader thread keeps draining; the swap blocks
        only for ~one buffer cycle while the underlying stream is closed
        and re-opened.  If the new device fails to open, the source falls
        back to the system default.

        Updates ``self._config.audio.input_device_index`` so subsequent
        ``getattr`` from the control handler reflects the live state.
        """
        self._audio_source.switch_device(device_index)
        self._config.audio.input_device_index = device_index

    def set_external_audio_mode(self, active: bool) -> None:
        """Enable/disable external audio mode (e.g. loopback capture).

        When active, the audio reader thread drains the OS buffer but
        discards frames instead of injecting silence.  This prevents
        silence frames from interleaving with externally fed audio and
        disrupting VAD speech detection.
        """
        self._external_audio_mode = active

    def shutdown(self) -> None:
        """Gracefully shutdown all components with independent error handling.

        Each cleanup step is wrapped in try-except to ensure all resources
        are released even if individual steps fail.
        """
        self._is_running = False
        # Signal the unload-check daemon to exit before we tear down the
        # transcribers it might race against.
        self._unload_stop_event.set()
        # Stop pipeline first to halt audio processing.
        self._safe_step("stopping pipeline", lambda: self._pipeline.stop(timeout=2.0))
        self._safe_step("cleaning up audio source", self._audio_source.cleanup)
        self._join_worker_threads()
        self._shutdown_transcribers()
        self._shutdown_wake_word_detector()
        self._safe_step("aborting state machine", self._state_machine.abort)

    # ── Idle-unload daemon ──────────────────────────────────────────────
    #
    # Ports Handy's ``model_unload_timeout`` lifecycle. A daemon thread
    # polls every 30 s; if no transcription has happened in the
    # configured idle window AND models are still loaded, it tears them
    # down so the OS reclaims their RAM/VRAM. The next
    # ``text()`` / ``transcribe()`` call detects the empty slot and
    # synchronously rebuilds via ``_load_transcriber`` — first PTT after
    # a tear-down pays the cold-load cost, subsequent presses are fast
    # again (the saved model name is what we rebuild with, so the user
    # keeps whatever they were on).
    #
    # The check cadence is 30 s rather than tied to the timeout itself
    # because (a) timer accuracy isn't critical, (b) checking more
    # frequently means catching the edge soon after it crosses, and
    # (c) timeouts of "after 2 min" still trip within ~30 s of the
    # exact mark, which is well within human "did it forget about me?"
    # tolerance.

    _UNLOAD_CHECK_INTERVAL_SECONDS: ClassVar[float] = 30.0

    def _start_unload_check_thread(self) -> None:
        """Spin up the daemon poller iff a positive timeout was configured."""
        worker = threading.Thread(
            target=self._unload_check_loop,
            name="model-unload-check",
            daemon=True,
        )
        self._unload_check_thread = worker
        worker.start()

    def set_unload_timeout_seconds(self, timeout: int | None) -> None:
        """Retune the idle-unload daemon at runtime.

        ``None``/negative → never unload (stop the poller).
        ``0``             → tear down immediately after each transcription
                            (handled by :meth:`_maybe_unload_immediately`;
                            the poller is unnecessary).
        positive int      → seconds of idleness before tear-down; the
                            poller is (re)started if not already running.

        Renderer counterpart: the ``model_unload_timeout_seconds``
        :func:`set_parameter` handler reaches the facade setter which
        forwards here. Existed previously only as a CLI-arg / constructor
        knob; this method removes the last "model.* keys force restart"
        entry from the Electron-side ``STARTUP_ONLY_KEYS_LIST``.
        """
        normalized: int | None
        if timeout is None or timeout < 0:
            normalized = None
        else:
            normalized = int(timeout)
        self._unload_timeout_seconds = normalized
        self._config.transcription.model_unload_timeout_seconds = normalized
        # Decide what to do with the poller. Two cases need it running:
        #   * positive timeout — periodic idle check
        #   * (nothing else; 0 and None don't need polling)
        wants_poller = normalized is not None and normalized > 0
        poller = self._unload_check_thread
        poller_alive = poller is not None and poller.is_alive()
        if wants_poller and not poller_alive:
            # Reset the stop event so a previously-killed loop can be
            # restarted (without this, the new thread exits immediately
            # because the event is still set from the prior shutdown).
            self._unload_stop_event.clear()
            # Bump the activity timestamp so a fresh window starts now
            # rather than measuring idle from the original boot time.
            self._last_activity_at = self._clock.get_current_time()
            self._start_unload_check_thread()
            return
        if not wants_poller and poller_alive:
            # Signal the loop to exit on its next wait wake-up. We don't
            # join here — the poller is daemon and any pending wait
            # returns within `_UNLOAD_CHECK_INTERVAL_SECONDS`.
            self._unload_stop_event.set()
            self._unload_check_thread = None

    def reconfigure_audio_source(
        self,
        *,
        always_on_microphone: bool | None = None,
        lazy_stream_close: bool | None = None,
        lazy_close_timeout_seconds: float | None = None,
    ) -> None:
        """Forward audio-source policy updates to the underlying adapter.

        :class:`PyAudioSource` exposes a matching ``reconfigure`` method
        that updates the three mic-release knobs in place. Other
        :class:`IAudioSource` adapters (``FileAudioSource``, fakes) lack
        the method — we duck-type and silently no-op so non-PyAudio
        setups (file transcription, tests) aren't surprised by a
        runtime ``AttributeError``.
        """
        reconfigure = getattr(self._audio_source, "reconfigure", None)
        if not callable(reconfigure):
            return
        reconfigure(
            always_on_microphone=always_on_microphone,
            lazy_stream_close=lazy_stream_close,
            lazy_close_timeout_seconds=lazy_close_timeout_seconds,
        )
        if always_on_microphone is not None:
            self._config.audio.always_on_microphone = bool(always_on_microphone)
        if lazy_stream_close is not None:
            self._config.audio.lazy_stream_close = bool(lazy_stream_close)
        if lazy_close_timeout_seconds is not None:
            self._config.audio.lazy_close_timeout_seconds = float(lazy_close_timeout_seconds)

    def _unload_check_loop(self) -> None:
        """Poll for idleness; fire :meth:`_unload_models_for_idle` when due."""
        while not self._unload_stop_event.is_set():
            # Sleep first so a fresh boot doesn't trip the timer on the
            # initial activity timestamp; the user just opened the app,
            # they shouldn't see "unloading" log spam before they've
            # done anything. Event-based wait so shutdown() wakes us
            # immediately rather than waiting out the interval.
            woken = self._unload_stop_event.wait(timeout=self._UNLOAD_CHECK_INTERVAL_SECONDS)
            if woken:
                return
            self._maybe_unload_for_idle()

    def _maybe_unload_immediately(self) -> None:
        """Tear models down right after a transcription if the user
        picked Handy's ``Immediately`` mode (``timeout == 0``).

        Called from the end of :meth:`text` / :meth:`transcribe` so the
        ORT sessions are released the moment the result is dispatched —
        no need to wait for the idle poller's next 30 s tick. Skips when
        a swap is in flight (the swap pipeline owns the slots) and when
        both slots are already empty.
        """
        if self._unload_timeout_seconds != 0:
            return
        if self._swap_threads:
            return
        if self._transcriber is None and self._realtime_transcriber is None:
            return
        logger.info("[unload] immediate-mode tear-down after transcription")
        self._unload_models()

    def _maybe_unload_for_idle(self) -> None:
        """Tear models down iff the idle window has elapsed.

        Reads ``_last_activity_at`` (atomically updated on every
        transcription event). Skips when models are already gone, when
        a swap is in flight (the swap pipeline owns the slots), or when
        the timeout is non-positive (disabled — ``0`` is the
        Immediately mode handled by :meth:`_maybe_unload_immediately`).
        """
        timeout = self._unload_timeout_seconds
        if timeout is None or timeout <= 0:
            return
        idle = self._clock.get_current_time() - self._last_activity_at
        if idle < timeout:
            return
        # Active swap? The swap worker is mid-rebuild; don't fight it.
        if self._swap_threads:
            return
        # Already unloaded — nothing to do.
        if self._transcriber is None and self._realtime_transcriber is None:
            return
        logger.warning(
            "[unload] idle for %.0fs (>= %ss) — releasing transcribers",
            idle,
            timeout,
        )
        self._unload_models()

    def _unload_models(self) -> None:
        """Null both transcriber slots and shut down the held instances.

        Releases ORT sessions + their CUDA / DML resources back to the
        OS. The slot writes happen under the per-slot locks; shutdowns
        run outside the locks so a concurrent transcribe waiter doesn't
        block on the ORT cleanup walk (mirrors the swap worker's
        unload-first pattern).
        """
        old_main: ITranscriber | None
        old_rt: ITranscriber | None
        with self._main_transcriber_lock:
            old_main = self._transcriber
            self._transcriber = None  # type: ignore[assignment]
        with self._realtime_transcriber_lock:
            old_rt = self._realtime_transcriber
            self._realtime_transcriber = None
        if old_main is not None:
            try:
                old_main.shutdown()
            except Exception:
                logger.exception("[unload] main transcriber shutdown raised")
        # Realtime might have been the same instance as main when
        # use_main_model_for_realtime is on — skip the second shutdown
        # in that case so we don't double-close the same ORT session.
        if old_rt is not None and old_rt is not old_main:
            try:
                old_rt.shutdown()
            except Exception:
                logger.exception("[unload] realtime transcriber shutdown raised")
        gc.collect()

    def _ensure_main_transcriber_loaded(self) -> None:
        """Synchronously rebuild ``self._transcriber`` if it was unloaded.

        Called from the top of ``text()`` / ``transcribe()`` so the
        first call after an idle tear-down transparently reloads. Holds
        a coarse lock (``_lazy_reload_lock``) so two concurrent paths
        don't both try to rebuild — the second waits and then sees the
        slot populated by the first.
        """
        if self._transcriber is not None:
            return
        with self._lazy_reload_lock:
            if self._transcriber is not None:
                return
            logger.warning("[unload] lazy-reload of main transcriber: %s", self._saved_main_model_name)
            try:
                new = self._load_transcriber(self._saved_main_model_name, None)
            except Exception:
                logger.exception("[unload] lazy-reload failed; transcribe will return empty")
                return
            if new is None:
                return
            with self._main_transcriber_lock:
                self._transcriber = new
            # If the realtime slot was supposed to mirror main, restore
            # that linkage. Otherwise the next realtime tick will lazy-
            # reload its own dedicated instance via the worker path.
            if self._config.realtime.use_main_model_for_realtime:
                with self._realtime_transcriber_lock:
                    self._realtime_transcriber = new

    def _mark_activity(self) -> None:
        """Bump the idle timestamp. Cheap; called from hot paths."""
        self._last_activity_at = self._clock.get_current_time()

    @staticmethod
    def _safe_step(what: str, action: Callable[[], object]) -> None:
        """Run a cleanup step, swallowing + logging any exception."""
        try:
            action()
        except Exception as e:
            logger.debug("Error %s: %s", what, e)

    def _join_worker_threads(self) -> None:
        self._audio_reader_thread = self._join_thread(self._audio_reader_thread, "Audio reader thread")
        self._realtime_thread = self._join_thread(self._realtime_thread, "Realtime worker thread")

    @classmethod
    def _join_thread(cls, thread: threading.Thread | None, label: str) -> None:
        if thread is None:
            return None
        cls._safe_step(f"joining {label}", lambda: cls._join_alive(thread, label))
        return None

    @staticmethod
    def _join_alive(thread: threading.Thread, label: str) -> None:
        thread.join(timeout=2.0)
        if thread.is_alive():
            logger.warning("%s did not terminate within timeout", label)

    def _shutdown_transcribers(self) -> None:
        # Slots can be transiently ``None`` if shutdown races with a
        # model swap that just detached the old transcriber.
        if self._transcriber is not None:
            self._safe_step("shutting down transcriber", self._transcriber.shutdown)
        if self._has_distinct_realtime_transcriber():
            rt = self._realtime_transcriber
            assert rt is not None  # narrowed by _has_distinct_realtime_transcriber
            self._safe_step("shutting down realtime transcriber", rt.shutdown)

    def _has_distinct_realtime_transcriber(self) -> bool:
        """Whether a separate realtime transcriber instance needs shutdown."""
        rt = self._realtime_transcriber
        return rt is not None and rt is not self._transcriber

    def _shutdown_wake_word_detector(self) -> None:
        if self._wake_word_detector is not None:
            self._safe_step("cleaning up wake word detector", self._wake_word_detector.cleanup)

    def _warm_transcriber(self, transcriber: ITranscriber | None, dummy: np.ndarray[Any, Any], lang: str) -> None:
        """Run a dummy inference through ``transcriber`` if its slot is set.

        The slot is Optional via the swap bookkeeping — guard for type
        safety / defensive code (a swap can leave it transiently ``None``).
        """
        if transcriber is not None:
            transcriber.transcribe(dummy, lang)

    def warmup(self) -> None:
        """Run a dummy inference to eagerly compile CUDA kernels.

        Sequential across slots — main, then realtime (if distinct),
        then diarizer (if present). All warmups must complete before
        we mark the recorder warm; this matches the renderer's
        "everything hot before chip greens" contract for ``server_ready``.

        History note — we tried both parallel warmup via
        ``ThreadPoolExecutor`` and "deferred" realtime/diarizer warmup
        in a daemon thread. The parallel path silently deadlocked on
        real CUDA hardware (two transcribers issuing inference on the
        shared default stream); the deferred path conflicted with the
        chosen ready threshold (renderer wants all-hot before green).
        The genuine root-cause fix that unblocked sequential warmup
        was pinning Silero VAD to CPU at the cache layer (see
        ``onnxasr_transcriber._get_or_load_silero_vad``), which removes
        the stream contention without giving up parallelism we don't
        actually need.
        """
        dummy = np.zeros(16000, dtype=np.float32)  # 1 s silence @ 16 kHz
        lang = self._config.transcription.language
        self._warm_transcriber(self._transcriber, dummy, lang)
        # De-dup when realtime aliases the main slot (use_main_model_for_realtime).
        if self._realtime_transcriber is not None and self._realtime_transcriber is not self._transcriber:
            self._warm_transcriber(self._realtime_transcriber, dummy, lang)
        # Eagerly load the diarizer's ORT sessions (pyannote-segmentation +
        # wespeaker, ~32 MB first-run download). Fail-soft via _safe_diarize.
        if self._diarizer is not None:
            self._safe_diarize(dummy)
        self._is_warm = True
        # Keep the event API alive — callers (tests, runtime-info builders)
        # use it as the canonical "fully warm" gate. Set unconditionally
        # at the end of a successful warmup.
        self._background_warmup_event.set()

    @property
    def is_warm(self) -> bool:
        """True after :meth:`warmup` has run to completion successfully.

        The structured ``server_ready`` payload broadcast by the WS layer
        consults this; the renderer chip greens only when this is true
        (per the all-hot-before-green threshold the user picked).

        Returns ``False`` between construction and the end of warmup,
        and stays ``False`` if warmup raises. A warmup failure does NOT
        block PTT — the recorder is still callable (state.recorder is
        non-None); the first real call just pays the JIT cost.
        """
        return self._is_warm

    def wait_for_background_warmup(self, timeout: float | None = None) -> bool:
        """Block until :meth:`warmup` finishes (timeout in seconds).

        Pre-Option-C this gated on a separate daemon-thread warmup;
        post-Option-C the event is set by :meth:`warmup` itself once it
        returns. Kept as a public API so tests + the runtime-info
        builder don't need to know whether warmup is sync or async.
        """
        return self._background_warmup_event.wait(timeout=timeout)

    def abort(self) -> None:
        self._pipeline.request_abort()
        # Put a sentinel on the queue to unblock wait_audio() immediately
        self._pipeline.transcription_queue.put_nowait(None)
        # Defense-in-depth: wipe the realtime accumulator + stabilizer +
        # last_realtime_text on the abort thread itself. The realtime worker
        # already resets these at the next recording start (via
        # _realtime_mark_recording_start), but that gives a brief window
        # where `_reuse_realtime_text_if_eligible` could observe the
        # previous session's stabilized text, and where the stabilizer's
        # text_storage deque still holds session-A prefixes that could
        # mis-anchor the very first realtime call of session B. Clearing
        # here closes that window. Operations are individual field assigns
        # + deque.clear() — all atomic under the GIL, so the worker
        # thread's concurrent stabilizer.update() either runs entirely
        # before or after this reset (eventually consistent on the next
        # _realtime_mark_recording_start regardless).
        self._reset_realtime_accumulator(clear_last=True)

    def wait_audio(self) -> bool:
        """Block until the pipeline signals a recording is ready.

        Returns ``True`` when audio is ready for transcription,
        ``False`` on timeout (no recording was produced).

        Uses short polling intervals so Ctrl+C is not blocked on Windows
        (``queue.get`` with a long timeout swallows ``KeyboardInterrupt``).

        The 60s deadline is only enforced **before** a recording has
        actually started (state == INACTIVE/LISTENING) — it covers the
        "user started ``text()`` but never spoke" case. Once we're in
        RECORDING, audio is actively accumulating and timing out would
        cause ``text()`` to clear the buffer mid-utterance — exactly the
        truncation symptom users see on long press-to-talk holds.
        """
        idle_deadline = time.time() + 60.0
        while True:
            ready, idle_deadline = self._wait_audio_tick(idle_deadline)
            if ready is not None:
                return ready

    def _wait_audio_tick(self, idle_deadline: float) -> tuple[bool | None, float]:
        """One poll cycle. Returns ``(result, new_deadline)``.

        ``result`` is True/False once decided, else None to keep polling.
        """
        ready = self._poll_transcription_queue()
        if ready is not None:
            return ready, idle_deadline
        return self._wait_audio_idle(idle_deadline)

    def _wait_audio_idle(self, idle_deadline: float) -> tuple[bool | None, float]:
        """Decide what to do when the queue poll came back empty."""
        if self._recording_in_progress():
            # Active recording — extend deadline indefinitely so we
            # never clear the user's in-flight audio.
            return None, time.time() + 60.0
        if time.time() >= idle_deadline:
            logger.debug("Timed out waiting for audio (no recording started within 60s)")
            return False, idle_deadline
        return None, idle_deadline

    def _poll_transcription_queue(self) -> bool | None:
        """One 0.1s poll: True/False if an item arrived, None if the queue is empty."""
        try:
            item = self._pipeline.transcription_queue.get(timeout=0.1)
        except queue.Empty:
            return None
        return item is not None  # False if abort sentinel (None), True otherwise

    def _recording_in_progress(self) -> bool:
        return self._state_machine.is_recording or self._state_machine.state == RecorderState.TRANSCRIBING

    def wakeup(self) -> None:
        self._pipeline.request_listen()

    def clear_audio_queue(self) -> None:
        self._audio_buffer.clear()

    def transcribe(self) -> str:
        self._mark_activity()
        self._ensure_main_transcriber_loaded()
        audio = self._pad_short_audio(self._audio_buffer.get_audio_array())
        result = self._safe_transcribe(self._transcriber, audio, self._config.transcription.language)
        if result is None:
            logger.warning("transcribe() skipped — model swap in progress")
            return ""
        text = self._preprocess_output(result.text, language=result.language)
        self._maybe_unload_immediately()
        return text

    def swap_transcriber(self, new: ITranscriber) -> None:
        with self._main_transcriber_lock:
            old = self._transcriber
            self._transcriber = new
        if old is not None:
            old.shutdown()

    # ── Live model swap ─────────────────────────────────────────────────
    #
    # The pattern (unload-first): ``request_model_swap`` spawns a daemon
    # thread that emits ``ModelSwapStarted`` immediately and then runs
    # three phases under the bench:
    #   1. **unload** — detach the current transcriber from its slot
    #      under ``_transcriber_lock`` (so concurrent transcribe callers
    #      see ``None`` and skip via ``_safe_transcribe``) and call
    #      ``shutdown()`` outside the lock so transcribe callers waiting
    #      on it aren't blocked on the ORT cleanup walk.
    #   2. **gc** — ``gc.collect()`` so the ORT session graph (and its
    #      CUDA allocations) is released *before* we ask CUDA to allocate
    #      for the new model. Without this the new load may briefly
    #      contend for VRAM that's still pending dtor.
    #   3. **load + commit** — build the new transcriber on this thread,
    #      then atomically install it under ``_transcriber_lock``.
    #
    # This costs a brief "no transcriber" window — transcribe attempts
    # during the swap return empty (main) or skip silently (realtime) —
    # but the peak memory is now ``max(old, new)`` instead of ``old + new``,
    # which is the relevant constraint on the GPU build.
    #
    # **Cancellation**: a per-kind ``threading.Event`` is checked from
    # the download progress callback; setting it raises
    # ``DownloadCancelledError`` mid-download. The worker emits
    # ``ModelSwapFailed("cancelled")`` and then attempts to rebuild the
    # previous model from its saved name (``_attempt_restore``) so the
    # slot is back to a usable state.
    #
    # **Concurrency**: only one swap per kind ("main" / "realtime") at a
    # time. A second request for the same kind cancels the in-flight one
    # (its half-built transcriber is shut down) before kicking off the
    # new one.
    #
    # Every swap emits a single ``[swap-benchmark]`` ``logger.info`` line
    # with phase timings, RSS deltas, and CPU% — that's the only place
    # the diagnostic numbers are exposed; nothing on the event bus
    # carries them.
    def set_swap_progress_sink(self, sink: Any | None) -> None:  # noqa: ANN401 — duck-typed callback
        """Install a download-progress callback used by ``request_model_swap``.

        Receives ``DownloadProgress`` instances per HF download chunk during
        a swap. Typically wired by the facade to the same callback chain
        used for boot-time downloads, so the renderer only needs one
        subscription.
        """
        self._swap_progress_sink = sink

    def request_model_swap(self, kind: str, name: str) -> None:
        """Kick off a background model swap.

        Args:
            kind: ``"main"`` for the primary transcriber, ``"realtime"`` for
                the live-preview transcriber. ``"realtime"`` is a no-op if
                ``enable_realtime_transcription`` is False.
            name: HuggingFace model id to load (e.g. ``onnx-community/whisper-base``).

        Returns immediately. Watch the event bus for
        ``ModelSwapStarted`` / ``ModelSwapCompleted`` / ``ModelSwapFailed``.
        """
        if not self._validate_swap_request(kind, name):
            return

        # Cancel any in-flight swap for the same kind. The prior thread
        # observes the set event on its next progress callback (or before
        # commit if it was about to swap) and exits without touching the
        # current transcriber.
        self._cancel_inflight_swap(kind)

        cancel_event = threading.Event()
        self._swap_cancel_events[kind] = cancel_event

        worker = threading.Thread(
            target=self._swap_worker,
            args=(kind, name, cancel_event),
            name=f"model-swap-{kind}",
            daemon=True,
        )
        self._swap_threads[kind] = worker
        worker.start()

    def _validate_swap_request(self, kind: str, name: str) -> bool:
        """Reject unknown kinds (raises) / disabled realtime (emits + returns False)."""
        if kind not in {"main", "realtime"}:
            msg = f"Unknown model swap kind: {kind!r}"
            raise ValueError(msg)
        rejection = self._swap_rejection(kind)
        if rejection is None:
            return True
        self._publish_swap_failed(kind, name, rejection)
        return False

    _DISABLED_INFO = SwapErrorInfo(
        category=SwapErrorCategory.UNKNOWN,
        user_message=("Realtime transcription is disabled — enable it in Settings → Model to swap the realtime model."),
        technical_detail="realtime transcription is disabled",
    )
    _SLAVED_INFO = SwapErrorInfo(
        category=SwapErrorCategory.UNKNOWN,
        user_message=(
            "The realtime worker is slaved to the main model — "
            "turn off 'Use main model for realtime' before "
            "picking a separate realtime model."
        ),
        technical_detail="use_main_model_for_realtime is on",
    )

    def _swap_rejection(self, kind: str) -> SwapErrorInfo | None:
        """First applicable rejection reason for a realtime swap, or ``None``."""
        for predicate, info in (
            (self._realtime_swap_disabled, self._DISABLED_INFO),
            (self._realtime_swap_slaved, self._SLAVED_INFO),
        ):
            if predicate(kind):
                return info
        return None

    def _realtime_swap_disabled(self, kind: str) -> bool:
        return kind == "realtime" and not self._config.realtime.enable_realtime_transcription

    def _realtime_swap_slaved(self, kind: str) -> bool:
        """A realtime swap while slaved would silently un-slave the worker.

        The UI disables the realtime picker when the toggle is on, but a
        direct WebSocket caller (or a stale renderer state) could still
        send the command — rejecting it here keeps the slot invariant
        intact instead of letting the new instance overwrite the shared
        main pointer.
        """
        return kind == "realtime" and self._config.realtime.use_main_model_for_realtime

    def _cancel_inflight_swap(self, kind: str) -> None:
        prior_cancel = self._swap_cancel_events.get(kind)
        if prior_cancel is not None:
            prior_cancel.set()

    # ── Runtime diarization toggle ──────────────────────────────────────
    #
    # ``request_diarization_toggle(enabled)`` lets the renderer flip
    # diarization on or off without rebooting the server. The transition
    # runs on a daemon thread (so we never block the WS handler), emits
    # ``DiarizationToggleStarted`` immediately, then either
    # ``DiarizationToggleCompleted`` once the new state is committed or
    # ``DiarizationToggleFailed`` with a stable category if anything went
    # wrong. A second request mid-flight cancels the prior attempt
    # (SUPERSEDED) the same way model swaps do.
    #
    # No-op fast path: a request whose target matches the live state
    # still publishes Started → Completed so the renderer's pending
    # spinner clears. We never publish "already in that state" as a
    # failure — the user-facing semantics are "you asked for it on, it's
    # on", regardless of whether work was actually needed.

    def request_diarization_toggle(self, enabled: bool) -> None:
        """Kick off a background diarization on/off transition.

        ``enabled`` is the *target* state. The pre-flight checks reject
        requests we can't possibly honor (no segmentation/embedding model
        configured) up-front so the worker thread only runs when there is
        actual work to do. Cancels any in-flight prior toggle.
        """
        cancel_event = threading.Event()
        prior_cancel = self._diar_toggle_cancel_event
        if prior_cancel is not None:
            prior_cancel.set()
        self._diar_toggle_cancel_event = cancel_event

        worker = threading.Thread(
            target=self._diar_toggle_worker,
            args=(enabled, cancel_event),
            name=f"diar-toggle-{'on' if enabled else 'off'}",
            daemon=True,
        )
        self._diar_toggle_thread = worker
        worker.start()

    def _diarization_already_in_state(self, enabled: bool) -> bool:
        """``True`` when the requested toggle direction is already live.

        Reads ``self._diarizer is None`` (atomic in CPython) so we don't
        need to take the slot lock for a no-op check.
        """
        currently_enabled = self._diarizer is not None
        return currently_enabled == enabled

    def _publish_diarization_toggle_failed(self, enabled: bool, info: SwapErrorInfo) -> None:
        """Emit ``DiarizationToggleFailed`` mirroring the model-swap pattern."""
        self._event_bus.publish(
            DiarizationToggleFailed(
                timestamp=self._clock.get_current_time(),
                enabled=enabled,
                reason=info.user_message,
                category=info.category.value,
                detail=info.technical_detail,
            )
        )

    def _diar_toggle_worker(self, enabled: bool, cancel_event: threading.Event) -> None:
        """Background worker for a diarization on/off transition.

        Publishes the lifecycle events and (for ``enabled=True``) builds
        the diarizer on this thread — the first ORT session load can
        take a few hundred ms, which is exactly why we never run it
        inline on the WS handler thread.
        """
        self._event_bus.publish(DiarizationToggleStarted(timestamp=self._clock.get_current_time(), enabled=enabled))

        # No-op fast path — UI still sees Started → Completed so the
        # pending spinner clears without a misleading "no change needed"
        # toast.
        if self._diarization_already_in_state(enabled):
            self._event_bus.publish(
                DiarizationToggleCompleted(
                    timestamp=self._clock.get_current_time(),
                    enabled=enabled,
                )
            )
            return

        if enabled:
            self._diar_toggle_enable(cancel_event)
            return
        self._diar_toggle_disable()

    def _diar_toggle_enable(self, cancel_event: threading.Event) -> None:
        """Build and install the diarizer; emit terminal event."""
        diar_cfg = self._config.diarization
        if not diar_cfg.segmentation_model or not diar_cfg.embedding_model:
            self._publish_diarization_toggle_failed(
                enabled=True,
                info=SwapErrorInfo(
                    category=SwapErrorCategory.MODEL_NOT_FOUND,
                    user_message=(
                        "Diarization models are not configured — set "
                        "segmentation_model and embedding_model in DiarizationConfig."
                    ),
                    technical_detail=(
                        f"segmentation_model={diar_cfg.segmentation_model!r}, "
                        f"embedding_model={diar_cfg.embedding_model!r}"
                    ),
                ),
            )
            return

        # ``build_diarizer`` is imported lazily so the application layer
        # doesn't pin the infrastructure import at module load (matches the
        # facade's pattern). The bootstrap module is the canonical site for
        # adapter construction.
        from src.recorder.bootstrap import build_diarizer

        try:
            new_diarizer = build_diarizer(diar_cfg)
        except Exception as exc:
            info = classify_swap_error(exc)
            logger.exception(
                "Diarization enable failed [%s]: %s",
                info.category.value,
                info.technical_detail,
            )
            self._publish_diarization_toggle_failed(enabled=True, info=info)
            return

        # A second toggle landed while we were loading — drop the
        # half-built diarizer and report SUPERSEDED so the renderer
        # collapses its spinner without flipping state. The half-built
        # diarizer was never installed, so no lock is needed here (this
        # diverges from the swap worker's tear-down path, which does
        # take the slot lock because the slot was already updated).
        if cancel_event.is_set():
            self._shutdown_diarizer_safely(new_diarizer)
            self._publish_diarization_toggle_failed(
                enabled=True,
                info=SwapErrorInfo(
                    category=SwapErrorCategory.UNKNOWN,
                    user_message="A newer diarization toggle superseded this one.",
                    technical_detail="cancel_event set before commit",
                ),
            )
            return

        with self._diarizer_lock:
            self._diarizer = new_diarizer
        self._event_bus.publish(DiarizationToggleCompleted(timestamp=self._clock.get_current_time(), enabled=True))

    def _diar_toggle_disable(self) -> None:
        """Tear down the live diarizer; emit terminal event.

        Disable never fails in practice: we null the slot first (so the
        next ``_safe_diarize`` short-circuits cleanly) then call
        ``shutdown()`` outside the lock so any pending diarize call
        finishes against the slot's previous instance without blocking
        us on its ORT cleanup.
        """
        with self._diarizer_lock:
            old = self._diarizer
            self._diarizer = None
        self._shutdown_diarizer_safely(old)
        # Free the ORT sessions' memory eagerly — same reasoning as the
        # ``gc.collect()`` in the model-swap worker, just less critical
        # because the diarizer's footprint is ~200 MB rather than
        # multi-GB. Still worth doing so a user toggling off mid-session
        # actually gets the memory back.
        gc.collect()
        self._event_bus.publish(DiarizationToggleCompleted(timestamp=self._clock.get_current_time(), enabled=False))

    @staticmethod
    def _shutdown_diarizer_safely(diarizer: IDiarizer | None) -> None:
        """Call ``shutdown()`` on a diarizer, swallowing failures.

        IDiarizer has no formal ``shutdown`` in the port today; the
        concrete OnnxAsrDiarizer just lets Python GC reclaim its
        sessions. We still ``getattr`` defensively so a future port
        addition is picked up automatically.
        """
        if diarizer is None:
            return
        shutdown = getattr(diarizer, "shutdown", None)
        if not callable(shutdown):
            return
        try:
            shutdown()
        except Exception:
            logger.exception("Diarizer shutdown raised — continuing anyway")

    def _publish_swap_failed(self, kind: str, name: str, info: SwapErrorInfo) -> None:
        """Emit a structured ``ModelSwapFailed`` carrying category + detail.

        ``info.user_message`` becomes ``reason`` — the renderer treats
        that as the toast headline. ``info.category`` is the stable
        enum code the renderer keys off to pick its localised variant.
        ``info.technical_detail`` is for the log line / bug report.
        """
        self._event_bus.publish(
            ModelSwapFailed(
                timestamp=self._clock.get_current_time(),
                kind=kind,
                name=name,
                reason=info.user_message,
                category=info.category.value,
                detail=info.technical_detail,
            )
        )

    def _swap_worker(self, kind: str, name: str, cancel_event: threading.Event) -> None:
        """Background worker: unload old → load new → commit.

        Unload-first ordering eliminates the brief memory peak where both
        models coexist in RAM/VRAM. While the new model is being loaded
        the slot is None, so concurrent transcribe attempts short-circuit
        (see ``_safe_transcribe``). If the new load fails or is
        superseded, we attempt to rebuild the previous model from its
        saved name so the user isn't left without a transcriber.

        Every swap emits a single ``[swap-benchmark]`` log line with
        per-phase timings, RSS deltas, and CPU% — that's the only place
        these numbers are exposed; nothing on the event bus has the
        diagnostic payload.
        """
        from src.recorder.application.swap_benchmark import SwapBenchmark

        bench = SwapBenchmark(kind, name)
        self._event_bus.publish(ModelSwapStarted(timestamp=self._clock.get_current_time(), kind=kind, name=name))

        # Remember which model was loaded before we tear it down, so a
        # failed load can put it back. The config still holds the old
        # name at this point — ``_install_transcriber`` writes the new
        # one only after a successful commit.
        previous_name = self._previous_model_name(kind)

        # ── Phase 1: unload old + GC ───────────────────────────────
        old = self._detach_current_transcriber(kind)
        with bench.phase("unload"):
            self._shutdown_transcriber_safely(kind, old)
        # gc.collect() forces Python to drop the now-unreferenced ORT
        # session graph synchronously. Without it, the dtor (and the
        # corresponding CUDA free) runs on a later GC pass and the new
        # load may briefly contend for VRAM that's still pending release.
        with bench.phase("gc"):
            gc.collect()
        bench.sample_memory("after_unload")

        # ── Phase 2: load new ──────────────────────────────────────
        new_transcriber, load_outcome, failure_info = self._load_new_for_swap(kind, name, cancel_event, bench)
        bench.sample_memory("after_load")

        if self._swap_aborted(new_transcriber, cancel_event):
            load_outcome = self._handle_aborted_swap(kind, name, new_transcriber, cancel_event, load_outcome)
            restore_outcome = self._attempt_restore(kind, previous_name, bench)
            # Emit failure AFTER restore so the on_model_swap_failed
            # callback can push a fresh ``runtime_info`` reflecting the
            # restored slot. The renderer's reconciler reads
            # ``runtimeInfo.model`` to decide whether the rollback
            # transition matches the server's actual state; emitting before
            # restore leaves it stale and triggers a redundant secondary
            # swap (status-bar stuck on "Switching..."). The superseded
            # case in ``_handle_aborted_swap`` already published — we only
            # need to fire here for genuine load failures.
            if failure_info is not None:
                self._publish_swap_failed(kind, name, failure_info)
            bench.log(f"{load_outcome}_{restore_outcome}")
            return

        # ── Phase 3: commit ────────────────────────────────────────
        assert new_transcriber is not None  # narrowed by _swap_aborted guard above
        with bench.phase("commit"):
            self._install_transcriber(kind, name, new_transcriber)

        self._event_bus.publish(ModelSwapCompleted(timestamp=self._clock.get_current_time(), kind=kind, name=name))
        bench.log("completed")

    @staticmethod
    def _swap_aborted(new_transcriber: ITranscriber | None, cancel_event: threading.Event) -> bool:
        """Whether the load produced nothing or was superseded mid-flight."""
        return new_transcriber is None or cancel_event.is_set()

    def _handle_aborted_swap(
        self,
        kind: str,
        name: str,
        new_transcriber: ITranscriber | None,
        cancel_event: threading.Event,
        load_outcome: str,
    ) -> str:
        """Tear down an orphaned half-built transcriber, return the outcome tag.

        Drops the now-orphan new transcriber when a newer swap superseded us
        between load and commit; the newer swap's worker handles the next
        install. Returns the (possibly updated) load-outcome tag.
        """
        if new_transcriber is not None and cancel_event.is_set():
            self._shutdown_transcriber_safely(kind, new_transcriber)
            self._publish_swap_failed(kind, name, superseded_info(name))
            return "superseded"
        return load_outcome

    def _previous_model_name(self, kind: str) -> str:
        """Return the model name currently recorded in config for ``kind``.

        Called *before* the swap mutates anything, so the value reflects
        what was loaded prior to this swap attempt — exactly the right
        thing to rebuild on failure.
        """
        if kind == "main":
            return self._config.transcription.model
        return self._config.realtime.realtime_model_type

    def _detach_current_transcriber(self, kind: str) -> ITranscriber | None:
        """Atomically pull the current transcriber out of its slot.

        Briefly holds the matching per-slot lock to make the pointer null;
        concurrent transcribe callers then see ``None`` and skip via
        ``_safe_transcribe``. The shutdown itself happens *outside* the
        lock so transcribe callers waiting on it aren't blocked on the
        ORT cleanup walk.
        """
        old: ITranscriber | None
        lock = self._main_transcriber_lock if kind == "main" else self._realtime_transcriber_lock
        with lock:
            if kind == "main":
                old = self._transcriber
                self._transcriber = None  # type: ignore[assignment]  # transient swap state — guarded by _safe_transcribe
                return old
            old = self._realtime_transcriber
            self._realtime_transcriber = None
            return old

    @staticmethod
    def _shutdown_transcriber_safely(kind: str, t: ITranscriber | None) -> None:
        """``t.shutdown()`` with logging; swallows exceptions so the swap
        worker can keep making progress toward installing the new model."""
        if t is None:
            return
        try:
            t.shutdown()
        except Exception:
            logger.exception("Old %s transcriber shutdown raised", kind)

    def _load_new_for_swap(
        self,
        kind: str,
        name: str,
        cancel_event: threading.Event,
        bench: SwapBenchmark,
    ) -> tuple[ITranscriber | None, str, SwapErrorInfo | None]:
        """Load the new transcriber inside the bench's ``load`` phase.

        Returns ``(transcriber_or_None, outcome_tag, failure_info_or_None)``.
        Failure info is returned (not published here) so the caller can run
        ``_attempt_restore`` BEFORE emitting the event — the renderer relies
        on ``runtime_info`` being post-restore when the failure handler
        fires (mirrors :func:`on_model_swap_completed`'s "load-bearing
        emission order" requirement). Without this ordering, the renderer's
        ``useSyncActiveModel`` reconciler sees a stale runtime model after
        rollback and fires a redundant second swap, leaving the status-bar
        chip stuck in "Switching..." indefinitely.
        """
        with bench.phase("load"):
            try:
                new = self._load_transcriber(name, _SwapProgress(self, name, cancel_event))
            except (DownloadCancelledError, Exception) as e:
                info = classify_swap_error(e)
                # CANCELLED stays at INFO level; anything else logs the
                # full traceback so support has it for diagnosis.
                if info.category is SwapErrorCategory.CANCELLED:
                    logger.info(
                        "Model swap %s → %s cancelled mid-download: %s",
                        kind,
                        name,
                        info.technical_detail,
                    )
                else:
                    logger.exception(
                        "Model swap %s → %s failed [%s]: %s",
                        kind,
                        name,
                        info.category.value,
                        info.technical_detail,
                    )
                return None, info.category.value, info
        return new, "completed", None

    def _attempt_restore(self, kind: str, previous_name: str, bench: SwapBenchmark) -> str:
        """Rebuild the previously-loaded model after a failed/cancelled swap.

        Returns a short tag for the benchmark line:
        ``"restored"`` (slot is healthy again), ``"no_previous"`` (this
        swap was the first install — nothing to fall back to), or
        ``"lost"`` (rebuild itself failed — the slot stays empty and the
        user must pick another model or restart the server).

        Uses a no-op progress sink: the rebuild typically hits the HF
        cache and finishes in seconds, and surfacing fake "downloading"
        events would just confuse the UI right after a failure.
        """
        if not previous_name:
            return "no_previous"
        with bench.phase("restore"):
            try:
                restored = self._load_transcriber(previous_name, lambda _progress: None)
            except Exception:
                logger.exception(
                    "Restore of %s transcriber to previous model %s failed — slot left empty",
                    kind,
                    previous_name,
                )
                return "lost"
        self._install_transcriber(kind, previous_name, restored)
        return "restored"

    def _load_transcriber(
        self,
        name: str,
        on_progress: Callable[[DownloadProgress], None],
    ) -> ITranscriber:
        # Late import to keep the application layer free of infrastructure imports
        # at module load time. The hexagonal rulebook keeps bootstrap as the only
        # composition root; swaps are a tactical exception scoped to this method.
        # Both helpers below are the same ones :func:`bootstrap.build_transcriber`
        # uses, so the swap path picks up the auto-int8 quant promotion (NeMo /
        # Cohere etc. on non-CUDA) AND the family-based CPU EP override (NeMo
        # encoders crash DML — see :func:`_override_dml_to_cpu_for_incompatible_family`).
        # Without this, the swap path silently bypasses both fixes and reproduces
        # the original ``ModelFileNotFoundError`` (quant the model doesn't publish)
        # / DML reshape crash on swap.
        from src.recorder.bootstrap import (
            _override_dml_to_cpu_for_incompatible_family,
            _resolve_quantization,
        )
        from src.recorder.domain.model_registry import ModelCatalog
        from src.recorder.infrastructure.device import providers_for_settings
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        info = ModelCatalog().get(name)
        quantization = _resolve_quantization(
            self._config.transcription.onnx_quantization,
            self._config.transcription.device,
            info.param_count if info else 0,
            info.available_quantizations if info else None,
            family=info.family if info else "",
            accelerator=self._config.transcription.accelerator,
        )
        providers = providers_for_settings(
            self._config.transcription.device,
            self._config.transcription.accelerator,
        )
        providers = _override_dml_to_cpu_for_incompatible_family(
            providers,
            family=info.family if info else "",
            accelerator=self._config.transcription.accelerator,
            device=self._config.transcription.device,
        )
        return OnnxAsrTranscriber(
            model_name=self._resolve_onnx_name(info, name),
            quantization=quantization,
            providers=providers,
            on_download_progress=on_progress,
            normalize_audio=self._config.transcription.normalize_audio,
        )

    @staticmethod
    def _resolve_onnx_name(info: ModelInfo | None, name: str) -> str:
        if info is not None and info.onnx_model_name:
            return info.onnx_model_name
        return name

    def _install_transcriber(self, kind: str, name: str, new_transcriber: ITranscriber) -> None:
        """Commit ``new_transcriber`` into the kind's slot and update config.

        When ``use_main_model_for_realtime`` is on and we just committed a
        new main model, also re-point the realtime slot at the new
        instance. The two slots are wired to the same object at bootstrap
        (see ``__init__.py`` / ``bootstrap.py``), but a ``main`` swap
        detaches and shuts down that shared object — leaving the realtime
        slot pointing at a now-shut-down transcriber whose ``is_ready()``
        returns ``False``. The realtime worker would then emit nothing
        for the rest of the session even though the main slot pastes
        correctly. Re-linking restores the slaving invariant and lets
        ``_reuse_realtime_text_if_eligible`` continue to short-circuit
        the duplicate end-of-recording pass.
        """
        is_main = kind == "main"
        lock = self._main_transcriber_lock if is_main else self._realtime_transcriber_lock
        with lock:
            self._assign_transcriber_slot(is_main, name, new_transcriber)
        self._maybe_relink_realtime(is_main, new_transcriber, name)

    def _maybe_relink_realtime(self, is_main: bool, new_main: ITranscriber, name: str) -> None:
        """Re-slave the realtime slot to a freshly-committed main model."""
        if is_main and self._realtime_slaved_to_main():
            self._relink_realtime_to_main(new_main, name)

    def _assign_transcriber_slot(self, is_main: bool, name: str, new_transcriber: ITranscriber) -> None:
        """Point the chosen slot at ``new_transcriber`` and persist its name.

        Also bumps the idle-unload daemon's saved-name fields so that a
        future tear-down's lazy reload rebuilds the model the user just
        switched to, not the original boot-time model.
        """
        if is_main:
            self._transcriber = new_transcriber
            self._config.transcription.model = name
            self._saved_main_model_name = name
            return
        self._realtime_transcriber = new_transcriber
        self._config.realtime.realtime_model_type = name
        self._saved_realtime_model_name = name

    def _realtime_slaved_to_main(self) -> bool:
        """True iff configuration says the realtime slot must mirror main."""
        rt = self._config.realtime
        return rt.enable_realtime_transcription and rt.use_main_model_for_realtime

    def _relink_realtime_to_main(self, new_main: ITranscriber, name: str) -> None:
        """Bring the realtime slot back in sync with the main slot.

        Called after a main swap commits while
        ``use_main_model_for_realtime`` is on. Both slots must share the
        same instance — and the same lock — so the ORT session isn't
        called reentrantly and ``_reuse_realtime_text_if_eligible`` keeps
        recognising the slaving via its identity check.
        """
        with self._realtime_transcriber_lock:
            self._realtime_transcriber = new_main
            self._config.realtime.realtime_model_type = name
        # When slaved, both slots share one lock so the ORT session is
        # serialised against itself across main+realtime callers. Re-pin
        # in case construction left them on separate locks (e.g. the
        # facade wired a separate realtime instance first and the user
        # later set ``use_main_model_for_realtime`` via a restart that
        # somehow lost the identity guarantee).
        self._realtime_transcriber_lock = self._main_transcriber_lock

    @property
    def state(self) -> RecorderState:
        return self._state_machine.state

    @property
    def is_recording(self) -> bool:
        return self._state_machine.is_recording

    @property
    def post_speech_silence_duration(self) -> float:
        return self._pipeline.post_speech_silence_duration

    @post_speech_silence_duration.setter
    def post_speech_silence_duration(self, value: float) -> None:
        self._pipeline.post_speech_silence_duration = value

    @property
    def silence_endpoint_enabled(self) -> bool:
        return self._pipeline.silence_endpoint_enabled

    @silence_endpoint_enabled.setter
    def silence_endpoint_enabled(self, value: bool) -> None:
        self._pipeline.silence_endpoint_enabled = value

    @property
    def frames(self) -> list[AudioChunk]:
        return self._pipeline.frames

    @property
    def last_words_buffer(self) -> collections.deque[AudioChunk]:
        return self._pipeline.last_words_buffer

    @property
    def wake_word_activation_delay(self) -> float:
        return self._pipeline.wake_word_activation_delay

    @wake_word_activation_delay.setter
    def wake_word_activation_delay(self, value: float) -> None:
        self._pipeline.wake_word_activation_delay = value

    @property
    def use_microphone(self) -> bool:
        return self._microphone_enabled

    def runtime_info(self) -> dict[str, Any]:
        """Snapshot of the live ORT runtime state for UI honesty.

        Returned dict carries:
          - ``device``: the user-requested device string from config (informational)
          - ``providers``: actual ORT execution providers attached to the main
            transcriber's primary session (e.g. ``["CUDAExecutionProvider",
            "CPUExecutionProvider"]``)
          - ``is_gpu``: True iff any GPU-class provider is in ``providers``
          - ``model``: the main model name (HF id)
          - ``realtime_model``: realtime model name when realtime is enabled,
            ``None`` otherwise
          - ``onnx_quantization``: quantization suffix currently loaded
            (empty string for the default fp32 export), or ``None`` when
            no quantization is set
          - ``realtime_quantization``: same, for the realtime transcriber.
            Mirrors ``onnx_quantization`` today (we don't split the setting
            per slot), but exposed explicitly so the fit-assessment code
            never has to assume the two match.

        Drives the frontend's bottom-left GPU/CPU chip — the renderer can no
        longer guess from ``nvidia-smi`` because that lies when the user
        installs the CPU-only onnxruntime wheel on a machine with an NVIDIA
        card.
        """
        info: dict[str, Any] = {
            "device": self._config.transcription.device,
            "providers": self._active_providers(),
            "is_gpu": self._transcriber_is_gpu(),
            "model": self._config.transcription.model,
            "realtime_model": self._realtime_model_name(),
            "onnx_quantization": self._config.transcription.onnx_quantization or "",
            "realtime_quantization": self._config.transcription.onnx_quantization or "",
        }
        return info

    def _active_providers(self) -> list[str]:
        # ``active_providers`` only exists on OnnxAsrTranscriber.
        active_providers = getattr(self._transcriber, "active_providers", None)
        if active_providers is None:
            return []
        return list(active_providers)

    def _transcriber_is_gpu(self) -> bool:
        # ``is_gpu`` only exists on OnnxAsrTranscriber.
        is_gpu = getattr(self._transcriber, "is_gpu", None)
        if is_gpu is None:
            return False
        return bool(is_gpu)

    def _realtime_model_name(self) -> str | None:
        if self._realtime_transcriber is None:
            return None
        return self._config.realtime.realtime_model_type

    def _start_pipeline(self) -> None:
        if self._config.audio.use_microphone:
            self._audio_source.setup()
        self._pipeline.start()
        self._is_running = True
        self._start_audio_reader_thread()
        self._start_realtime_thread()

    def _start_audio_reader_thread(self) -> None:
        if not self._config.audio.use_microphone:
            return
        self._audio_reader_thread = threading.Thread(target=self._audio_reader_loop, daemon=True)
        self._audio_reader_thread.start()

    def _start_realtime_thread(self) -> None:
        rt_enabled = self._config.realtime.enable_realtime_transcription
        rt_has_transcriber = self._realtime_transcriber is not None
        if not (rt_enabled and rt_has_transcriber):
            # INFO when realtime is intentionally disabled by config; only escalate
            # to WARNING on the surprising case where the user asked for it
            # (rt_enabled=True) but the transcriber failed to build.
            log_fn = logger.warning if (rt_enabled and not rt_has_transcriber) else logger.info
            log_fn(
                "Realtime worker NOT started (enabled=%s, has_transcriber=%s)",
                rt_enabled,
                rt_has_transcriber,
            )
            return
        self._realtime_thread = threading.Thread(target=self._realtime_worker, daemon=True)
        self._realtime_thread.start()
        logger.info("Realtime worker STARTED (model=%s)", self._config.realtime.realtime_model_type)

    def _realtime_worker(self) -> None:
        """Periodically transcribe accumulated audio for live display.

        Uses a stable-text accumulator: only audio past the committed
        watermark is fed to the realtime model, and once that fresh region
        exceeds ``REALTIME_COMMIT_AFTER_SECONDS`` the older portion is
        transcribed once, appended to ``_realtime_committed_text``, and the
        watermark advances. The published text is
        ``committed + current_fresh_transcription`` so the live preview
        keeps growing for the entire recording while the model never sees
        more than ~commit-interval of audio per call. Watermark and
        committed text reset whenever recording transitions inactive →
        active.
        """
        assert self._realtime_transcriber is not None
        state = _RealtimeLoopState(last_transcription=time.time())
        while self._is_running:
            self._realtime_step(state)

    def _reset_realtime_accumulator(self, *, clear_last: bool) -> None:
        """Empty the committed-text accumulator + watermark.

        ``clear_last`` also wipes ``_last_realtime_text`` — done at the start
        of a fresh recording, but NOT when a recording ends (``text()``
        consumes it as the final transcription when
        ``use_main_model_for_realtime`` is on).
        """
        self._realtime_committed_text = ""
        self._realtime_committed_frames = 0
        if clear_last:
            self._last_realtime_text = ""
            # New recording: the stabilizer's prior safetext is irrelevant
            # to the next utterance and would mis-anchor on stale content.
            self._realtime_stabilizer.reset()

    def _realtime_step(self, state: _RealtimeLoopState) -> None:
        """One realtime-worker loop iteration (mirrors the old loop body)."""
        if not self._state_machine.is_recording:
            self._reset_realtime_accumulator(clear_last=False)
            state.recording_seen_at = None
            state.last_processed_frame_count = -1
            time.sleep(0.01)
            return
        self._realtime_mark_recording_start(state)
        if not self._realtime_ready(state):
            return
        # ── Stale-audio guard ─────────────────────────────────────────
        # If the audio buffer hasn't grown since our last transcribe, the
        # recording has effectively stopped feeding frames even though the
        # state machine still says is_recording=True. Re-transcribing the
        # same content is pure waste — we'd publish the same preview text
        # at every iteration, hammer the GPU, and (with the post-Option C
        # CUDA-thread tuning making transcribe ~17 ms on Canary) spin a
        # ~30 ms-per-iteration tight loop. Back off to a 50 ms sleep
        # instead and try again next tick. The frame_count counter
        # advances monotonically as the audio reader feeds new chunks,
        # so we resume normal cadence as soon as fresh audio actually
        # arrives. Loses zero responsiveness on the happy path.
        current_frame_count = self._audio_buffer.frame_count
        if current_frame_count == state.last_processed_frame_count:
            time.sleep(0.05)
            return
        state.last_processed_frame_count = current_frame_count
        state.last_transcription = time.time()
        self._realtime_process_once()

    def _realtime_mark_recording_start(self, state: _RealtimeLoopState) -> None:
        if state.recording_seen_at is not None:
            return
        state.recording_seen_at = time.time()
        # Fresh recording — clear any stale accumulator state.
        self._reset_realtime_accumulator(clear_last=True)

    def _realtime_ready(self, state: _RealtimeLoopState) -> bool:
        """Gate on init delay + processing pause; sleeps + returns False if not yet."""
        rt_config = self._config.realtime
        # ``_realtime_mark_recording_start`` runs first every iteration, so the
        # timestamp is always set by the time we gate on it.
        assert state.recording_seen_at is not None
        recording_seen_at = state.recording_seen_at
        if time.time() - recording_seen_at < rt_config.init_realtime_after_seconds:
            time.sleep(0.001)
            return False
        if time.time() - state.last_transcription < rt_config.realtime_processing_pause:
            time.sleep(0.001)
            return False
        return True

    def _realtime_process_once(self) -> None:
        committed_frames = self._realtime_committed_frames
        if self._audio_buffer.frame_count - committed_frames <= 0:
            return
        try:
            new_committed = self._realtime_commit_if_needed()
            self._realtime_publish_fresh(new_committed)
        except Exception as e:
            logger.error(
                "Realtime transcription error (committed_frames=%d, total_frames=%d): %s",
                self._realtime_committed_frames,
                self._audio_buffer.frame_count,
                e,
                exc_info=True,
            )
            # Continue processing - realtime transcription is non-critical

    def _realtime_commit_if_needed(self) -> int:
        """Commit the older portion once the fresh window exceeds the threshold.

        Returns the (possibly advanced) committed-frame watermark.
        """
        frames_per_second = self._audio_buffer.frames_per_second()
        commit_chunk_frames = max(1, int(REALTIME_COMMIT_AFTER_SECONDS * frames_per_second))
        committed_frames = self._realtime_committed_frames
        fresh_frames = self._audio_buffer.frame_count - committed_frames
        if fresh_frames <= commit_chunk_frames:
            return committed_frames
        self._commit_chunk(committed_frames, commit_chunk_frames)
        # Always advance the watermark, even on empty/whitespace output, so we
        # don't re-process the same audio region.
        self._realtime_committed_frames = committed_frames + commit_chunk_frames
        return self._realtime_committed_frames

    def _commit_chunk(self, committed_frames: int, commit_chunk_frames: int) -> None:
        commit_audio = self._audio_buffer.get_audio_array_slice(
            committed_frames, committed_frames + commit_chunk_frames
        )
        if len(commit_audio) == 0:
            return
        self._maybe_append_commit_text(self._transcribe_realtime_window(commit_audio))

    def _maybe_append_commit_text(self, commit_text: str | None) -> None:
        # commit_text is ``None`` when the realtime transcriber is mid-swap;
        # both ``None`` and ``""`` indicate "no usable commit this tick".
        if commit_text and commit_text.strip():
            self._append_committed_text(commit_text)

    def _transcribe_realtime_window(self, audio: np.ndarray[Any, Any]) -> str | None:
        """Transcribe a realtime audio slice; ``None`` when the slot is mid-swap.

        Realtime preview must not block when the realtime transcriber is
        mid-swap — returning ``None`` (vs ``""``) lets callers skip the tick
        entirely instead of publishing a stale/empty preview.
        """
        result = self._safe_transcribe(
            self._realtime_transcriber,
            audio,
            self._config.transcription.language,
            lock=self._realtime_transcriber_lock,
            use_prompt=False,
        )
        if result is None:
            return None
        return self._preprocess_output(result.text, language=result.language)

    def _append_committed_text(self, commit_text: str) -> None:
        if self._realtime_committed_text:
            self._realtime_committed_text = self._realtime_committed_text + " " + commit_text
        else:
            self._realtime_committed_text = commit_text

    def _realtime_publish_fresh(self, committed_frames: int) -> None:
        # Transcribe the fresh window past the watermark for the live preview.
        # ``is_recording`` is re-checked just before the (potentially long)
        # transcribe call: when the user releases PTT the state machine has
        # already flipped to TRANSCRIBING but the realtime worker may have
        # already entered this method. Bailing here saves an entire fresh
        # whisper-base pass that main is about to do anyway — measured as
        # ~390 ms of saved end-of-dictation latency on a JFK-length clip.
        audio_array = self._fresh_realtime_slice(committed_frames)
        if audio_array is None:
            return
        fresh_text = self._transcribe_realtime_window(audio_array)
        if fresh_text is None:
            return
        raw_text = self._assemble_realtime_text(fresh_text)
        # Run the assembled text through the RealtimeSTT-faithful stabilizer.
        # The committed prefix is already monotonic (frozen older chunks); the
        # stabilizer's commonprefix trivially keeps it and works on the fresh
        # tail to kill Whisper-rerank flicker.
        stabilized_text = self._realtime_stabilizer.update(raw_text)
        self._publish_realtime_update(stabilized_text, raw_text)

    def _fresh_realtime_slice(self, committed_frames: int) -> np.ndarray[Any, Any] | None:
        """Audio past the watermark, or ``None`` to skip this realtime tick.

        ``is_recording`` is re-checked here: when the user releases PTT the
        state machine has already flipped to TRANSCRIBING but the realtime
        worker may have already entered ``_realtime_publish_fresh``. Bailing
        saves a full fresh whisper-base pass main is about to do anyway
        (~390 ms on a JFK-length clip).
        """
        if not self._state_machine.is_recording:
            return None
        audio_array = self._audio_buffer.get_audio_array_slice(committed_frames, None)
        if len(audio_array) == 0:  # pragma: no cover
            return None
        return audio_array

    def _publish_realtime_update(self, stabilized_text: str, raw_text: str) -> None:
        """Emit live-preview updates, retaining the stabilized text for reuse.

        Two events fire on every realtime tick (mirrors RealtimeSTT's
        ``on_realtime_transcription_stabilized`` then ``..._update`` ordering
        in audio_recorder.py:2476/2493):

        * ``RealtimeTranscriptionStabilized`` — UI-safe monotonic text from
          the stabilizer. This is what the renderer's live-preview pane and
          the dynamic-silence classifier should consume.
        * ``RealtimeTranscriptionUpdate`` — raw assembled Whisper output for
          consumers that genuinely need the latest (potentially regressed)
          text (e.g. logging, the suffix-repetition "noise break" detector).

        ``_last_realtime_text`` is set to the stabilized text so the
        ``text()`` reuse path serves the same UI-safe string the user just
        saw — not a transient Whisper rerank.

        ``is_recording`` is re-checked because the user may have released PTT
        during the (potentially long) transcribe — the state machine flips to
        TRANSCRIBING and main is about to run its own pass.
        """
        if self._state_machine.is_recording:  # pragma: no branch
            self._last_realtime_text = stabilized_text
            ts = self._clock.get_current_time()
            self._event_bus.publish(RealtimeTranscriptionStabilized(timestamp=ts, text=stabilized_text))
            self._event_bus.publish(RealtimeTranscriptionUpdate(timestamp=ts, text=raw_text))

    def _assemble_realtime_text(self, fresh_text: str) -> str:
        committed = self._realtime_committed_text
        if not committed:
            return fresh_text
        if not fresh_text:
            return committed
        return committed + " " + fresh_text

    def _audio_reader_loop(self) -> None:
        """Read chunks from the audio source and feed the pipeline.

        The stream is always drained so the OS buffer doesn't overflow.
        When the microphone is logically disabled, silence frames are
        fed instead so the pipeline/VAD can still detect the speech →
        silence transition (required for push-to-talk).
        """
        consecutive_errors = 0
        while self._is_running:
            chunk, consecutive_errors = self._read_audio_chunk(consecutive_errors)
            if chunk is None:
                # Error path already handled (back-off / stop). Re-checking
                # ``_is_running`` in the while header replaces the old
                # ``break`` — when the error handler sets it False the loop
                # exits, otherwise we retry after the back-off sleep.
                continue
            self._feed_chunk_if_enabled(chunk)

    _MAX_CONSECUTIVE_AUDIO_ERRORS = 10

    def _read_audio_chunk(self, consecutive_errors: int) -> tuple[AudioChunk | None, int]:
        """Read one chunk. On error, handle back-off/stop and return ``(None, n)``."""
        try:
            chunk = self._audio_source.read_chunk()
        except Exception as e:
            return None, self._handle_audio_read_error(e, consecutive_errors)
        return chunk, 0  # reset error count on success

    def _handle_audio_read_error(self, error: Exception, consecutive_errors: int) -> int:
        if not self._is_running:
            return consecutive_errors
        consecutive_errors += 1
        logger.warning(
            "Audio reader error (attempt %d/%d): %s",
            consecutive_errors,
            self._MAX_CONSECUTIVE_AUDIO_ERRORS,
            error,
        )
        if consecutive_errors >= self._MAX_CONSECUTIVE_AUDIO_ERRORS:
            logger.error(
                "Audio reader: too many consecutive errors (%d), stopping",
                consecutive_errors,
            )
            self._is_running = False
            return consecutive_errors
        time.sleep(0.1)  # Back off before retry
        return consecutive_errors

    def _feed_chunk_if_enabled(self, chunk: AudioChunk) -> None:
        if self._microphone_enabled and not self._external_audio_mode:
            self._pipeline.feed_audio(chunk)
        # else: drain. With set_microphone(False) the audio source is
        # already paused — read_chunk returns silence on a sleep cadence
        # and feeding it would just publish meaningless AudioLevelComputed
        # events. PTT-release end-of-recording is handled by set_microphone
        # calling request_stop() directly, not by VAD-on-injected-silence.

    def _preprocess_output(self, text: str, language: str = "") -> str:
        text = re.sub(r"\s+", " ", text.strip())
        text = self._apply_custom_words(text)
        text = self._apply_filler_filter(text, language)
        text = self._apply_starting_uppercase(text)
        return self._apply_trailing_period(text)

    def _apply_filler_filter(self, text: str, language: str) -> str:
        """Locale-aware filler-word strip + stutter collapse.

        Runs AFTER the fuzzy dictionary so user-defined brand names
        (which may legitimately overlap with disfluency tokens in some
        weird edge case) get a chance to anchor first. ``language`` is
        the detected language from the transcriber; we fall back to
        the configured Whisper language if detection came back empty,
        and the filter itself falls back to a conservative cross-lang
        list when the resolved code is unknown. Empty input
        short-circuits cleanly inside :func:`filter_transcription_output`.
        """
        cfg = self._config.text_correction
        if not cfg.filter_fillers or not text:
            return text
        from src.recorder.text.filler_filter import filter_transcription_output

        lang = language or self._config.transcription.language
        custom = cfg.custom_filler_words if cfg.custom_filler_words else None
        return filter_transcription_output(text, lang, custom)

    def _apply_custom_words(self, text: str) -> str:
        """Deterministic fuzzy correction against the user's word list.

        Runs BEFORE the LLM modifier pipeline (which lives in the
        Electron main process and consumes the text we return). If the
        deterministic pass already corrected a brand/jargon misrecognition
        the LLM still sees a polished input — and if anything remains
        unfixed, the LLM gets a second crack at it. Empty word list is the
        common case and short-circuits cleanly inside ``apply_custom_words``.
        """
        cfg = self._config.text_correction
        if not cfg.custom_words or not text:
            return text
        # Local import keeps the application layer free of the rapidfuzz /
        # jellyfish modules at process import time; they only load when the
        # user has actually configured a non-empty custom-word list.
        from src.recorder.text.dictionary import apply_custom_words

        return apply_custom_words(text, cfg.custom_words, cfg.threshold)

    def _apply_starting_uppercase(self, text: str) -> str:
        if self._config.ui.ensure_sentence_starting_uppercase and text:
            return text[0].upper() + text[1:]
        return text

    def _apply_trailing_period(self, text: str) -> str:
        if self._needs_trailing_period(text):
            return text + "."
        return text

    def _needs_trailing_period(self, text: str) -> bool:
        if not self._config.ui.ensure_sentence_ends_with_period:
            return False
        return bool(text) and text[-1].isalnum()

    def __enter__(self) -> RecorderService:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        self.shutdown()
