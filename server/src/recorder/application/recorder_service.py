from __future__ import annotations

import collections
import gc
import logging
import queue
import re
import threading
import time
from collections.abc import Iterable
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
from src.recorder.domain.config import DiarizationConfig, RecorderConfig
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
    TranscriptionFailed,
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

# Cloud-transcriber model-id prefixes. A model name carrying one of these is a
# RemoteTranscriber (OpenAI / ElevenLabs RPC), not a local ONNX session — so it
# holds no resident weights to unload. Mirrors ``bootstrap._CLOUD_PROVIDER_PREFIXES``
# (the canonical list used at construction time); kept here as a tiny local
# predicate so the application layer needn't import the bootstrap composition
# root at module load (it would pull infrastructure in transitively).
_CLOUD_MODEL_PREFIXES: tuple[str, ...] = ("openai:", "elevenlabs:")


def _is_cloud_model_name(name: str) -> bool:
    """True when ``name`` addresses a cloud (RemoteTranscriber) model."""
    return name.startswith(_CLOUD_MODEL_PREFIXES)


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
        self._transcriber: ITranscriber | None = transcriber
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
        # Bumped on every set_microphone() call so a tail-window release daemon
        # that wakes after a newer transition (re-press, or another release)
        # finds its generation stale and bails — see _run_release_pad.
        self._release_generation: int = 0
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
        self._swap_progress_sink: Callable[[DownloadProgress], None] | None = None
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
        # Three modes for the model-unload timeout:
        #   * ``None``          — never unload
        #   * ``0``             — unload right after every transcription
        #                         (the "immediately" mode). The poller
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
        self._saved_realtime_model_name: str = self._initial_realtime_model_name(config)
        # Set when a SEPARATE local realtime model was torn down because the
        # main model became cloud (a cloud main has no live-preview path and
        # the UI hides the realtime section, so a resident local realtime ONNX
        # session is pure waste). Drives the reload back to that local model
        # when the main model returns to local. See
        # ``_reconcile_separate_realtime_with_main``.
        self._realtime_unloaded_for_cloud_main: bool = False
        # Lock for serializing lazy-reload attempts so two concurrent
        # transcribe paths (e.g. main text() and the realtime worker)
        # don't both try to rebuild the same model at the same time.
        # The transcriber lock alone isn't sufficient because the load
        # itself happens *outside* the slot lock (long-running) — we
        # need a separate gate that says "someone is already reloading,
        # wait for them."
        self._lazy_reload_lock = threading.Lock()
        if self._wants_unload_poller(self._unload_timeout_seconds):
            self._start_unload_check_thread()

    @staticmethod
    def _initial_realtime_model_name(config: RecorderConfig) -> str:
        """Saved realtime model name at boot — empty when realtime is disabled."""
        if config.realtime.enable_realtime_transcription:
            return config.realtime.realtime_model_type
        return ""

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
        if all([realtime_transcriber is not None, realtime_transcriber is transcriber]):
            return self._main_transcriber_lock
        if any([self._uses_directml(transcriber), self._uses_directml(realtime_transcriber)]):
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
        providers = RecorderService._active_providers_of(transcriber)
        return any("DmlExecutionProvider" in str(p) for p in providers)

    @staticmethod
    def _active_providers_of(transcriber: ITranscriber | None) -> list[object]:
        """Resolve a transcriber's active ORT providers, defensively.

        Returns ``[]`` for adapters that don't expose ``active_providers``
        (cloud remote, test fakes) or expose a non-iterable, so they take the
        historical non-DirectML independent-lock fast path.
        """
        if transcriber is None:
            return []
        providers: object = getattr(transcriber, "active_providers", [])
        # Properties return the value; callables (legacy/test fakes) need invoking.
        providers = RecorderService._call_providers_if_callable(providers)
        return list(providers) if isinstance(providers, Iterable) else []

    @staticmethod
    def _call_providers_if_callable(providers: object) -> object:
        """Invoke ``active_providers`` when it's a method rather than a property."""
        if not callable(providers):
            return providers
        try:
            return providers()
        except Exception:  # pragma: no cover — defensive
            logger.debug("active_providers() raised; assuming non-DML", exc_info=True)
            return []

    def text(self, on_transcription_finished: TextCallback | None = None) -> str:
        # Idle-unload daemon tears the transcribers down
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
        # the SAME model end-to-end, else run a full transcription pass.
        text = self._resolve_transcript(audio, frame_count, audio_seconds)
        if text is None:
            # Genuine transcriber error: TranscriptionFailed was already
            # published with the real reason. Skip the empty
            # TranscriptionCompleted + finished-callback so the relay
            # doesn't mis-report the failure as "no audio detected".
            return self._finish_failed_transcription()

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

    def _resolve_transcript(
        self,
        audio: np.ndarray[Any, Any],
        frame_count: int,
        audio_seconds: float,
    ) -> str | None:
        """Resolve the final transcript for this utterance.

        Returns the reused realtime preview when eligible (skips a duplicate
        whole-buffer pass — the realtime worker chunks audio into committed
        pieces plus one fresh window, acceptable as a final result when
        ``use_main_model_for_realtime`` is on), the full-transcription text
        otherwise, or ``None`` to signal a *reported* transcriber failure
        (``TranscriptionFailed`` already published) so the caller can take the
        failed-transcription teardown path.
        """
        reused = self._reuse_realtime_text_if_eligible()
        if reused is not None:
            logger.warning(
                "[main-transcribe] REUSED realtime text (%d frames, %.2fs) — %d chars",
                frame_count,
                audio_seconds,
                len(reused),
            )
            return reused
        return self._run_full_transcription(audio, frame_count, audio_seconds)

    def _finish_failed_transcription(self) -> str:
        """Tear down recording state after a *reported* transcription failure.

        Mirrors the tail of :meth:`text` minus the ``TranscriptionCompleted``
        publish and the finished-callback dispatch: the renderer already
        received a ``TranscriptionFailed`` (→ ``transcription_failed`` WS
        event) carrying the real reason, so emitting an empty transcript here
        would only re-trigger the "no audio detected" mislabel we're fixing.
        Returns "" so the recorder loop's ``recorder.text()`` call still gets
        a string and keeps polling for the next utterance.
        """
        self._finalize_transcription_state()
        self._maybe_unload_immediately()
        return ""

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
        encoder window — pad to ``sample_rate * 5 / 4`` whenever the clip is
        non-empty and shorter than one second. Empty buffers pass through
        untouched."""
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
        on_error: Callable[[Exception], None] | None = None,
    ) -> TranscriptionResult | None:
        """Call ``transcriber.transcribe`` under the slot's lock if available.

        Returns ``None`` when the slot is empty or the transcriber is
        mid-shutdown — both transient states during a model swap. The
        lock is held for the whole call so the swap worker can't yank
        the model out from under us between the readiness check and the
        transcribe call.

        ``on_error`` (when provided) is invoked with the caught exception
        before returning ``None``, letting the main-text caller distinguish
        a genuine transcriber crash from a swap-in-flight skip — both still
        return ``None`` so realtime / warmup callers (which pass no
        ``on_error``) keep their silent best-effort behaviour.

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
        cw, ipt = self._resolve_prompt_inputs(use_prompt=use_prompt)
        with lock:
            if not self._transcriber_ready(transcriber):
                return None
            assert transcriber is not None  # narrowed by _transcriber_ready
            return self._guarded_transcribe(
                transcriber,
                audio,
                language,
                use_prompt=use_prompt,
                custom_words=cw,
                initial_prompt_text=ipt,
                on_error=on_error,
            )

    @staticmethod
    def _guarded_transcribe(
        transcriber: ITranscriber,
        audio: np.ndarray[Any, Any],
        language: str,
        *,
        use_prompt: bool,
        custom_words: list[str] | None,
        initial_prompt_text: str | None,
        on_error: Callable[[Exception], None] | None,
    ) -> TranscriptionResult | None:
        """Run ``transcriber.transcribe`` under the slot lock, swallowing crashes.

        Catch-all because the failure modes here are dominated by
        backend-specific exceptions we can't import without taking a hard dep
        on every provider's pybind module:
          * ``onnxruntime.capi.onnxruntime_pybind11_state.RuntimeException``
            — kernel exception in the EP (e.g. DML's ``node_view`` Reshape
            crashing on Canary-180M-int8, seen in the wild).
          * ``onnxruntime.capi.onnxruntime_pybind11_state.Fail``
            — session-level dispatch failure.
          * CUDA OOM surfacing through CuPy/torch on the sentence-classifier path.

        Without this guard the exception propagates up through ``text()`` →
        ``_recorder_thread`` (see ``server.py``) and kills the worker thread
        silently — the user then has to restart the server to dictate again.
        Returning ``None`` routes through the same caller path as a
        swap-in-flight skip, which produces an empty TranscriptionCompleted and
        keeps the recorder alive for the next utterance. ``logger.exception``
        preserves the full traceback so the underlying kernel error stays
        diagnosable in stt-server.log.
        """
        try:
            return transcriber.transcribe(
                audio,
                language,
                use_prompt=use_prompt,
                custom_words=custom_words,
                initial_prompt_text=initial_prompt_text,
            )
        except Exception as exc:
            logger.exception("[transcribe] transcriber raised; treating as skipped (returning None)")
            if on_error is not None:
                on_error(exc)
            return None

    def _resolve_prompt_inputs(self, *, use_prompt: bool) -> tuple[list[str] | None, str | None]:
        """Resolve the ``(custom_words, initial_prompt_text)`` decoder-bias pair.

        With ``use_prompt`` off (the realtime worker) both are ``None`` — its
        windows are short and the prompt latency would compound per tick; it
        relies on the post-decode rapidfuzz pass instead.

        ``initial_prompt`` (free-form prior-text from the frontend's UIA
        composer) is the preferred decoder-bias channel; it's richer than the
        dictionary list because it carries the actual caret-leading text. The
        transcriber falls back to ``custom_words`` when this is empty,
        preserving the legacy dict-only behaviour.
        """
        if not use_prompt:
            return None, None
        cw = self._config.text_correction.custom_words
        cfg_ipt = self._config.transcription.initial_prompt
        ipt = cfg_ipt if isinstance(cfg_ipt, str) else None
        return cw, ipt

    def _publish_transcription_failed(self, exc: Exception) -> None:
        """Publish :class:`TranscriptionFailed` so the WS server can report a
        genuine transcriber crash honestly to the renderer.

        The full traceback was already written by :meth:`_safe_transcribe`'s
        ``logger.exception``; this carries only a concise ``"Type: message"``
        detail for the UI / diagnostics. ``category`` stays ``"unknown"`` for
        now (the renderer's inline pill ignores it) but is plumbed through so
        a future richer error surface can branch on it like
        :class:`ModelSwapFailed` does.
        """
        self._event_bus.publish(
            TranscriptionFailed(
                timestamp=self._clock.get_current_time(),
                reason="Transcription failed",
                category="unknown",
                detail=f"{type(exc).__name__}: {exc}",
            )
        )

    @staticmethod
    def _transcriber_ready(transcriber: ITranscriber | None) -> bool:
        """Whether ``transcriber`` is wired and past its readiness check."""
        return transcriber is not None and transcriber.is_ready()

    def _run_full_transcription(
        self,
        audio: np.ndarray[Any, Any],
        frame_count: int,
        audio_seconds: float,
    ) -> str | None:
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
        # ``captured`` collects the exception when the transcriber *raises*
        # (vs. returning None because it's mid-swap and not ready). That
        # distinction is what lets us report a genuine failure honestly
        # instead of folding it into the swap-skip / no-audio path.
        captured: list[Exception] = []
        result = self._safe_transcribe(
            self._transcriber,
            audio,
            self._config.transcription.language,
            on_error=captured.append,
        )
        if result is None:
            if captured:
                # Genuine transcriber error (e.g. incomplete-vocab KeyError,
                # EP kernel crash, OOM). Publish TranscriptionFailed so the
                # renderer can say "transcription failed" rather than the
                # misleading "no audio detected", and signal the caller to
                # skip the empty TranscriptionCompleted by returning None.
                self._publish_transcription_failed(captured[0])
                return None
            # Swap-in-flight: the transcriber isn't ready yet. The UI is
            # already showing "Switching to {model}..." so the user
            # understands why this utterance produced nothing.
            logger.warning("[main-transcribe] skipped — transcriber not ready (model swap in progress)")
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

        ``microphone_on=True``: resume hardware capture so the audio reader
        thread starts feeding real chunks to the pipeline.

        ``microphone_on=False`` while recording: end the recording WITHOUT
        clipping its tail. Rather than snapping the stream shut and
        transitioning straight to TRANSCRIBING (which abandons audio still in
        the OS ring buffer and the pipeline's audio queue — the last fraction
        of a second the user spoke), we drain the OS-buffered tail, feed it,
        then stop *through the audio queue* so the pipeline worker buffers
        every queued chunk before finalizing. See ``_finish_release_stop``.

        ``AudioConfig.extra_recording_buffer_ms`` (default 0 = off) optionally
        keeps capturing for an extra window before that flush, for users who
        trail off just after the key-up; the mic keeps feeding during the
        window. ``0`` flushes immediately on release.

        Wake-word mode is the exception: the detector needs continuous
        capture, so pause()/resume() and the flush are skipped — the
        ``_microphone_enabled`` flag still gates feed_audio so the pipeline
        sees the on/off transition, and the stop runs immediately.
        """
        # Supersede any pending tail-window release: a re-press cancels the
        # daemon so it can't stop the fresh recording; a second release
        # replaces the prior daemon (only the latest generation acts).
        self._release_generation += 1
        if microphone_on:
            self._microphone_enabled = True
            self._apply_microphone_toggle(True)
            return
        self._route_microphone_off()

    def _route_microphone_off(self) -> None:
        """Turn the mic off, flushing the recording tail when mid-recording.

        A live (non-wake-word) recording takes the tail-preserving stop path;
        otherwise (released while LISTENING/INACTIVE, or wake-word mode) there
        is nothing in flight to flush, so the immediate off path runs.
        """
        if self._wake_word_detector is None and self._state_machine.is_recording:
            self._begin_release_stop()
            return
        self._microphone_enabled = False
        self._apply_microphone_toggle(False)

    def _begin_release_stop(self) -> None:
        """Stop a live recording without clipping its tail.

        With ``extra_recording_buffer_ms`` set, keep capturing for that window
        first (via a spawned daemon); otherwise flush-and-stop immediately.
        """
        tail_ms = self._config.audio.extra_recording_buffer_ms
        if tail_ms > 0:
            self._spawn_release_pad_thread(tail_ms, self._release_generation)
        else:
            self._finish_release_stop()

    def _apply_microphone_toggle(self, microphone_on: bool) -> None:
        """Immediate (non-deferred) mic on/off: toggle hardware + handle off."""
        # Wake-word backends require always-on capture so the detector
        # can listen for the trigger word; for everything else we toggle
        # the hardware stream so the OS mic indicator follows user intent.
        if self._wake_word_detector is None:
            self._toggle_hardware_capture(microphone_on)
        if not microphone_on:
            self._handle_microphone_off()

    def _spawn_release_pad_thread(self, tail_ms: int, generation: int) -> None:
        """Run the release flush after the optional ``extra_recording_buffer_ms``
        window. Daemon thread so the WS control thread isn't blocked during the
        sleep; the mic keeps feeding for the window so trailing syllables still
        land in the buffer. ``generation`` lets a stale daemon (superseded by a
        later set_microphone) bail without stopping a fresh recording.
        """
        threading.Thread(
            target=self._run_release_pad,
            args=(tail_ms, generation),
            daemon=True,
            name="extra-recording-buffer",
        ).start()

    def _run_release_pad(self, tail_ms: int, generation: int) -> None:
        time.sleep(tail_ms / 1000.0)
        if generation != self._release_generation:
            # A re-press (or another release) superseded this window.
            return
        self._finish_release_stop()

    def _finish_release_stop(self) -> None:
        """Flush captured audio, release the device, then stop via the queue.

        Order matters:
        1. drain the OS-buffered tail (audio captured between the reader's
           last read and now) and feed it as buffer-sized frames;
        2. stop the reader feeding new (post-release) reads;
        3. pause/close the device (OS mic indicator clears);
        4. enqueue the stop marker so the pipeline worker buffers every
           queued chunk — the drained tail and any backlog — BEFORE it
           transitions out of RECORDING. A direct ``request_stop`` here
           would abandon that in-flight audio, clipping the last words.

        Only reached for the non-wake-word recording path (the caller
        guarantees ``_wake_word_detector is None``).
        """
        self._feed_drained_tail(self._audio_source.drain_available())
        self._microphone_enabled = False
        self._toggle_hardware_capture(False)
        self._pipeline.request_stop_via_queue()

    def _feed_drained_tail(self, drained: AudioChunk) -> None:
        """Feed the drained release tail into the pipeline in buffer-sized
        frames so VAD's fixed-window invariant holds. A sub-frame remainder
        (<~32 ms) is dropped; empty input is a no-op.
        """
        frame_bytes = self._config.audio.buffer_size * 2  # int16 → 2 bytes/sample
        for start in range(0, len(drained) - frame_bytes + 1, frame_bytes):
            self._pipeline.feed_audio(drained[start : start + frame_bytes])

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
    # Implements the ``model_unload_timeout`` lifecycle. A daemon thread
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
        normalized = self._normalize_unload_timeout(timeout)
        self._unload_timeout_seconds = normalized
        self._config.transcription.model_unload_timeout_seconds = normalized
        # Decide what to do with the poller. Two cases need it running:
        #   * positive timeout — periodic idle check
        #   * (nothing else; 0 and None don't need polling)
        wants_poller = self._wants_unload_poller(normalized)
        poller_alive = self._unload_poller_alive()
        if all([wants_poller, not poller_alive]):
            self._restart_unload_poller()
            return
        if all([not wants_poller, poller_alive]):
            self._stop_unload_poller()

    @staticmethod
    def _normalize_unload_timeout(timeout: int | None) -> int | None:
        """``None``/negative → ``None`` (never unload); otherwise the int."""
        if timeout is None or timeout < 0:
            return None
        return int(timeout)

    @staticmethod
    def _wants_unload_poller(normalized: int | None) -> bool:
        """Only a positive timeout needs the periodic idle poller running."""
        return normalized is not None and normalized > 0

    def _unload_poller_alive(self) -> bool:
        """Whether the idle-unload poller thread is currently running."""
        poller = self._unload_check_thread
        return poller is not None and poller.is_alive()

    def _restart_unload_poller(self) -> None:
        """(Re)start the idle-unload poller from a fresh activity window."""
        # Reset the stop event so a previously-killed loop can be
        # restarted (without this, the new thread exits immediately
        # because the event is still set from the prior shutdown).
        self._unload_stop_event.clear()
        # Bump the activity timestamp so a fresh window starts now
        # rather than measuring idle from the original boot time.
        self._last_activity_at = self._clock.get_current_time()
        self._start_unload_check_thread()

    def _stop_unload_poller(self) -> None:
        """Signal the idle-unload poller to exit on its next wake-up."""
        # We don't join here — the poller is daemon and any pending wait
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
        self._mirror_audio_policy_config(
            always_on_microphone=always_on_microphone,
            lazy_stream_close=lazy_stream_close,
            lazy_close_timeout_seconds=lazy_close_timeout_seconds,
        )

    def _mirror_audio_policy_config(
        self,
        *,
        always_on_microphone: bool | None,
        lazy_stream_close: bool | None,
        lazy_close_timeout_seconds: float | None,
    ) -> None:
        """Mirror the just-applied mic-release knobs onto ``self._config`` so
        subsequent ``getattr`` reads from the control handler reflect live state.
        Only the explicitly-provided (non-``None``) knobs are written."""
        audio = self._config.audio
        self._set_attr_if_not_none(audio, "always_on_microphone", always_on_microphone, bool)
        self._set_attr_if_not_none(audio, "lazy_stream_close", lazy_stream_close, bool)
        self._set_attr_if_not_none(audio, "lazy_close_timeout_seconds", lazy_close_timeout_seconds, float)

    @staticmethod
    def _set_attr_if_not_none(
        target: object,
        attr: str,
        value: object | None,
        convert: Callable[[Any], object],
    ) -> None:
        """Set ``target.attr = convert(value)`` only when ``value`` is not ``None``."""
        if value is not None:
            setattr(target, attr, convert(value))

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
        picked the "immediately" mode (``timeout == 0``).

        Called from the end of :meth:`text` / :meth:`transcribe` so the
        ORT sessions are released the moment the result is dispatched —
        no need to wait for the idle poller's next 30 s tick. Skips when
        a swap is in flight (the swap pipeline owns the slots) and when
        both slots are already empty.
        """
        if self._unload_timeout_seconds != 0:
            return
        if self._unload_blocked():
            return
        logger.info("[unload] immediate-mode tear-down after transcription")
        self._unload_models()

    def _unload_blocked(self) -> bool:
        """True when a tear-down should be skipped right now.

        Blocks while a swap is in flight (the swap pipeline owns the slots)
        and when both transcriber slots are already empty (nothing to free).
        """
        return bool(self._swap_threads) or self._both_slots_empty()

    def _both_slots_empty(self) -> bool:
        """True iff neither the main nor realtime transcriber slot is loaded."""
        return self._transcriber is None and self._realtime_transcriber is None

    def _maybe_unload_for_idle(self) -> None:
        """Tear models down iff the idle window has elapsed.

        Reads ``_last_activity_at`` (atomically updated on every
        transcription event). Skips when models are already gone, when
        a swap is in flight (the swap pipeline owns the slots), or when
        the timeout is non-positive (disabled — ``0`` is the
        Immediately mode handled by :meth:`_maybe_unload_immediately`).
        """
        timeout = self._unload_timeout_seconds
        if not self._wants_unload_poller(timeout):
            return
        assert timeout is not None  # narrowed by _wants_unload_poller
        self._unload_if_idle_elapsed(timeout)

    def _unload_if_idle_elapsed(self, timeout: int) -> None:
        """Tear down once the idle window has elapsed and no swap is in flight."""
        idle = self._clock.get_current_time() - self._last_activity_at
        if idle < timeout:
            return
        # Active swap (swap worker is mid-rebuild) or already unloaded — skip.
        if self._unload_blocked():
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
        old_main, old_rt = self._detach_both_slots()
        self._unload_shutdown("main", old_main)
        # Realtime might have been the same instance as main when
        # use_main_model_for_realtime is on — skip the second shutdown
        # in that case so we don't double-close the same ORT session.
        if old_rt is not old_main:
            self._unload_shutdown("realtime", old_rt)
        gc.collect()

    def _detach_both_slots(self) -> tuple[ITranscriber | None, ITranscriber | None]:
        """Null both transcriber slots under their locks; return the old instances."""
        with self._main_transcriber_lock:
            old_main = self._transcriber
            self._transcriber = None
        with self._realtime_transcriber_lock:
            old_rt = self._realtime_transcriber
            self._realtime_transcriber = None
        return old_main, old_rt

    @staticmethod
    def _unload_shutdown(label: str, transcriber: ITranscriber | None) -> None:
        """``shutdown()`` a detached transcriber, swallowing failures."""
        if transcriber is None:
            return
        try:
            transcriber.shutdown()
        except Exception:
            logger.exception("[unload] %s transcriber shutdown raised", label)

    def _ensure_main_transcriber_loaded(self) -> None:
        """Synchronously rebuild ``self._transcriber`` if it was unloaded.

        Called from the top of ``text()`` / ``transcribe()`` so the
        first call after an idle tear-down transparently reloads. Holds
        a coarse lock (``_lazy_reload_lock``) so two concurrent paths
        don't both try to rebuild — the second waits and then sees the
        slot populated by the first.

        Defers to an in-flight main swap: the swap-worker has nulled
        the slot in its Phase 1 unload and will repopulate it on Phase 3
        commit; firing a lazy-reload here would race the worker, rebuild
        the previous model from a stale ``_saved_main_model_name``, and
        leak the resulting ORT session when the swap committed on top.
        """
        if self._transcriber is not None:
            return
        if self._is_swap_in_flight("main"):
            return
        with self._lazy_reload_lock:
            self._lazy_reload_main_locked()

    def _lazy_reload_main_locked(self) -> None:
        """Rebuild the main transcriber under ``_lazy_reload_lock``.

        Re-checks both guards because a swap could have started (or another
        path could have already reloaded) between the unlocked probe in
        :meth:`_ensure_main_transcriber_loaded` and acquiring the mutex.
        """
        if self._lazy_reload_unneeded():
            return
        logger.warning("[unload] lazy-reload of main transcriber: %s", self._saved_main_model_name)
        new = self._load_transcriber_or_none(self._saved_main_model_name)
        if new is None:
            return
        self._commit_lazy_reloaded_main(new)

    def _lazy_reload_unneeded(self) -> bool:
        """True when a main lazy-reload should be skipped (slot full or swap busy)."""
        return self._transcriber is not None or self._is_swap_in_flight("main")

    def _load_transcriber_or_none(self, name: str) -> ITranscriber | None:
        """Lazy-reload helper: build the model, swallowing load failures."""
        try:
            return self._load_transcriber(name, None)
        except Exception:
            logger.exception("[unload] lazy-reload failed; transcribe will return empty")
            return None

    def _commit_lazy_reloaded_main(self, new: ITranscriber) -> None:
        """Install a lazy-reloaded main transcriber, re-slaving realtime if needed."""
        with self._main_transcriber_lock:
            self._transcriber = new
        # If the realtime slot was supposed to mirror main, restore that
        # linkage. Otherwise the next realtime tick will lazy-reload its own
        # dedicated instance via the worker path.
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
        Cloud/remote transcribers opt out via ``requires_warmup`` — warming
        one would be a real billed API round-trip that can hang the recorder
        thread at startup (see ``RemoteTranscriber.requires_warmup``).
        """
        if transcriber is not None and transcriber.requires_warmup:
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
        if self._has_distinct_realtime_transcriber():
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
    def set_swap_progress_sink(self, sink: Callable[[DownloadProgress], None] | None) -> None:
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

    def _is_swap_in_flight(self, kind: str) -> bool:
        """True iff a swap-worker thread for ``kind`` is still alive.

        Used by :meth:`_ensure_main_transcriber_loaded` to defer to the
        swap pipeline instead of racing it. The swap-worker briefly nulls
        the transcriber slot in Phase 1 (unload-first ordering) and
        repopulates it at the end of Phase 3 (commit). If the recorder
        thread's text() loop calls ``_ensure_main_transcriber_loaded``
        while the slot is transiently null, it would otherwise see
        ``None``, take the lazy-reload path, and rebuild the OLD model
        from ``_saved_main_model_name`` (which the swap-worker only
        rewrites at commit time). That wasted ~5 seconds reloading the
        previous model AND leaked its ORT session when the swap-worker
        finally committed on top.
        """
        thread = self._swap_threads.get(kind)
        return thread is not None and thread.is_alive()

    def is_swap_in_flight(self, kind: str) -> bool:
        """Public probe for an in-flight swap of ``kind`` (``"main"`` /
        ``"realtime"``).

        The facade's config-knob setters (``onnx_quantization``,
        ``translate_to_english``, …) call this before triggering their
        in-place reload: when a model swap is ALREADY running, that swap
        re-reads the just-updated config at load time, so a SECOND reload
        is both redundant AND harmful — requested second, it would cancel
        the in-flight (user-initiated) swap and commit the OLD model
        instead. The "switch silently reverts to the previous model" bug.
        """
        return self._is_swap_in_flight(kind)

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
        if self._diar_models_unconfigured(diar_cfg):
            return
        self._build_and_install_diarizer(diar_cfg, cancel_event)

    def _build_and_install_diarizer(self, diar_cfg: DiarizationConfig, cancel_event: threading.Event) -> None:
        """Build the diarizer, then commit it (or fail/supersede) and emit terminal event."""
        new_diarizer = self._build_diarizer_or_fail(diar_cfg)
        if new_diarizer is None:
            return
        if cancel_event.is_set():
            self._fail_superseded_diarizer(new_diarizer)
            return
        with self._diarizer_lock:
            self._diarizer = new_diarizer
        self._event_bus.publish(DiarizationToggleCompleted(timestamp=self._clock.get_current_time(), enabled=True))

    def _diar_models_unconfigured(self, diar_cfg: DiarizationConfig) -> bool:
        """Publish MODEL_NOT_FOUND + return True when seg/embedding models are unset."""
        if diar_cfg.segmentation_model and diar_cfg.embedding_model:
            return False
        self._publish_diarization_toggle_failed(
            enabled=True,
            info=SwapErrorInfo(
                category=SwapErrorCategory.MODEL_NOT_FOUND,
                user_message=(
                    "Diarization models are not configured — set "
                    "segmentation_model and embedding_model in DiarizationConfig."
                ),
                technical_detail=(
                    f"segmentation_model={diar_cfg.segmentation_model!r}, embedding_model={diar_cfg.embedding_model!r}"
                ),
            ),
        )
        return True

    def _build_diarizer_or_fail(self, diar_cfg: DiarizationConfig) -> IDiarizer | None:
        """Build the diarizer; publish a classified failure + return None on error.

        ``build_diarizer`` is imported lazily so the application layer doesn't
        pin the infrastructure import at module load (matches the facade's
        pattern). The bootstrap module is the canonical site for adapter
        construction.
        """
        from src.recorder.bootstrap import build_diarizer

        try:
            return build_diarizer(diar_cfg)
        except Exception as exc:
            info = classify_swap_error(exc)
            logger.exception(
                "Diarization enable failed [%s]: %s",
                info.category.value,
                info.technical_detail,
            )
            self._publish_diarization_toggle_failed(enabled=True, info=info)
            return None

    def _fail_superseded_diarizer(self, new_diarizer: IDiarizer) -> None:
        """Drop a half-built diarizer + report SUPERSEDED when a newer toggle landed.

        The half-built diarizer was never installed, so no lock is needed here
        (this diverges from the swap worker's tear-down path, which does take
        the slot lock because the slot was already updated). Reporting SUPERSEDED
        collapses the renderer spinner without flipping state.
        """
        self._shutdown_diarizer_safely(new_diarizer)
        self._publish_diarization_toggle_failed(
            enabled=True,
            info=SwapErrorInfo(
                category=SwapErrorCategory.UNKNOWN,
                user_message="A newer diarization toggle superseded this one.",
                technical_detail="cancel_event set before commit",
            ),
        )

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
        # ``getattr(None, "shutdown", None)`` returns ``None`` (not callable),
        # so a ``None`` diarizer falls through the callable guard — no separate
        # ``is None`` check needed.
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

        Cleans up its registry slot on exit so :meth:`_is_swap_in_flight`
        keeps reading accurately across multiple swaps. The lazy-reload
        path in :meth:`_ensure_main_transcriber_loaded` reads that
        signal to know whether it's safe to rebuild from the saved
        model name.
        """
        try:
            self._run_swap_worker(kind, name, cancel_event)
        finally:
            self._swap_registry_pop(kind, cancel_event)

    def _swap_registry_pop(self, kind: str, cancel_event: threading.Event) -> None:
        """Remove our thread + cancel-event from the registry if still ours.

        Compare-and-clear: if the user kicked off a newer swap, that
        request_model_swap call has already overwritten our slots with
        the new worker's handles. We mustn't pop those — only the entry
        we registered ourselves.
        """
        if self._swap_threads.get(kind) is threading.current_thread():
            self._swap_threads.pop(kind, None)
        if self._swap_cancel_events.get(kind) is cancel_event:
            self._swap_cancel_events.pop(kind, None)

    def _run_swap_worker(self, kind: str, name: str, cancel_event: threading.Event) -> None:
        """Phase-by-phase swap pipeline. Extracted from :meth:`_swap_worker`
        so the registry-cleanup ``try/finally`` stays a tiny wrapper."""
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
            self._finish_aborted_swap(
                kind, name, new_transcriber, cancel_event, load_outcome, failure_info, previous_name, bench
            )
            return

        # ── Phase 3: commit ────────────────────────────────────────
        assert new_transcriber is not None  # narrowed by _swap_aborted guard above
        with bench.phase("commit"):
            self._install_transcriber(kind, name, new_transcriber)

        self._event_bus.publish(ModelSwapCompleted(timestamp=self._clock.get_current_time(), kind=kind, name=name))
        bench.log("completed")

    def _finish_aborted_swap(
        self,
        kind: str,
        name: str,
        new_transcriber: ITranscriber | None,
        cancel_event: threading.Event,
        load_outcome: str,
        failure_info: SwapErrorInfo | None,
        previous_name: str,
        bench: SwapBenchmark,
    ) -> None:
        """Tear down + optionally restore after an aborted/superseded swap.

        Restores the previous model ONLY for a genuine load failure. A
        SUPERSEDED swap (cancel set) must NOT restore — the superseding swap
        already owns (or is about to commit) the slot, and restoring
        ``previous_name`` here would clobber its model. That was the "switch
        reverts to the old model" bug: a redundant onnx_quantization-triggered
        reload of the OLD model raced the user's model switch, got superseded,
        then restored the OLD model on top of the just-committed NEW model.
        """
        load_outcome = self._handle_aborted_swap(kind, name, new_transcriber, cancel_event, load_outcome)
        restore_outcome = self._restore_after_abort_if_needed(kind, previous_name, cancel_event, bench)
        # Emit failure AFTER restore so the on_model_swap_failed callback can
        # push a fresh ``runtime_info`` reflecting the restored slot. The
        # renderer's reconciler reads ``runtimeInfo.model`` to decide whether
        # the rollback transition matches the server's actual state; emitting
        # before restore leaves it stale and triggers a redundant secondary
        # swap (status-bar stuck on "Switching..."). The superseded case in
        # ``_handle_aborted_swap`` already published — we only need to fire
        # here for genuine load failures.
        if failure_info is not None:
            self._publish_swap_failed(kind, name, failure_info)
        bench.log(f"{load_outcome}_{restore_outcome}")

    def _restore_after_abort_if_needed(
        self,
        kind: str,
        previous_name: str,
        cancel_event: threading.Event,
        bench: SwapBenchmark,
    ) -> str:
        """Rebuild the previous model after a genuine load failure, else no-op tag."""
        if self._should_restore_after_abort(cancel_event):
            return self._attempt_restore(kind, previous_name, bench)
        return "superseded_no_restore"

    @staticmethod
    def _swap_aborted(new_transcriber: ITranscriber | None, cancel_event: threading.Event) -> bool:
        """Whether the load produced nothing or was superseded mid-flight."""
        return new_transcriber is None or cancel_event.is_set()

    @staticmethod
    def _should_restore_after_abort(cancel_event: threading.Event) -> bool:
        """Whether an aborted swap should rebuild the previous model.

        ``True`` only for a GENUINE load failure (cancel not set) — there is
        no other swap taking over, so the slot must be repopulated with the
        prior model. ``False`` when SUPERSEDED (cancel set): a newer swap owns
        the slot and will install its own model; restoring here would clobber
        it. The cancel flag is set exclusively by ``_cancel_inflight_swap``
        from a newer ``request_model_swap``, so ``cancel set`` ⟺ ``a
        superseding swap exists``.
        """
        return not cancel_event.is_set()

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
                self._transcriber = None  # transient swap state — guarded by _safe_transcribe
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
        on_progress: Callable[[DownloadProgress], None] | None,
    ) -> ITranscriber:
        # Cloud STT (``openai:…`` / ``elevenlabs:…``) routes to the WS-RPC
        # proxy, NOT the local ONNX loader. Mirror :func:`bootstrap.build_transcriber`
        # — without this branch the swap path feeds the cloud id straight into
        # onnx-asr's resolver, which raises ``ModelNotSupportedError`` and the
        # swap reverts to a local model (the "switching to cloud silently falls
        # back to tiny" bug). Done first so no catalog/quant work runs for cloud.
        from src.recorder.bootstrap import _parse_cloud_model_id

        cloud = _parse_cloud_model_id(name)
        if cloud is not None:
            provider, cloud_model_id = cloud
            from src.recorder.infrastructure.remote_transcriber import RemoteTranscriber

            return RemoteTranscriber(provider=provider, model_id=cloud_model_id)

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
        param_count, available_quantizations, family = self._quant_inputs(info)
        quantization = _resolve_quantization(
            self._config.transcription.onnx_quantization,
            self._config.transcription.device,
            param_count,
            available_quantizations,
            family=family,
            accelerator=self._config.transcription.accelerator,
        )
        providers = providers_for_settings(
            self._config.transcription.device,
            self._config.transcription.accelerator,
        )
        providers = _override_dml_to_cpu_for_incompatible_family(
            providers,
            family=family,
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
    def _quant_inputs(info: ModelInfo | None) -> tuple[int, list[str] | None, str]:
        """Catalog-derived ``(param_count, available_quantizations, family)``.

        Defaults (``0`` / ``None`` / ``""``) are used for models not in the
        catalog (``info is None``) — exactly the values the swap path passed
        inline before this was hoisted to de-duplicate the ``family`` read.
        ``getattr`` with a default keeps this branch-free: ``getattr(None, …)``
        returns the default, a real ``ModelInfo`` returns its attribute.
        """
        param_count: int = getattr(info, "param_count", 0)
        available_quantizations: list[str] | None = getattr(info, "available_quantizations", None)
        family: str = getattr(info, "family", "")
        return param_count, available_quantizations, family

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
        """Keep the realtime slot consistent with a freshly-committed main model.

        Two independent concerns, both triggered only by a ``main`` swap:

        - **Slaved** (``use_main_model_for_realtime``): re-point the realtime
          slot at the new main instance so the shared-object invariant holds.
        - **Separate**: when the realtime slot runs its own model, keep its
          local/cloud nature in step with main — a cloud main must not leave a
          resident local realtime ONNX session behind, and returning to a local
          main rebuilds the realtime model that was torn down.
        """
        if not is_main:
            return
        if self._realtime_slaved_to_main():
            self._relink_realtime_to_main(new_main, name)
            return
        self._reconcile_separate_realtime_with_main(name)

    def _reconcile_separate_realtime_with_main(self, main_name: str) -> None:
        """Sync a SEPARATE realtime model with the main model's local/cloud kind.

        No-op unless realtime is enabled. When the new main is cloud, unload a
        resident local realtime model (the cloud main has no live-preview path
        and the UI hides the realtime section). When the new main is local,
        rebuild the local realtime model that an earlier cloud main tore down.
        """
        if not self._config.realtime.enable_realtime_transcription:
            return
        rt_name = self._config.realtime.realtime_model_type
        if _is_cloud_model_name(main_name):
            self._unload_separate_realtime_for_cloud_main(rt_name)
        else:
            self._reload_separate_realtime_after_cloud_main(rt_name)

    def _unload_separate_realtime_for_cloud_main(self, rt_name: str) -> None:
        """Tear down a resident local realtime model when main went cloud.

        Skips a cloud realtime model (a lightweight RPC proxy — no resident
        weights to free) and an already-empty slot. The realtime worker
        tolerates a ``None`` slot mid-run (``_safe_transcribe`` short-circuits),
        so nulling here is safe even while the worker is ticking.
        """
        if _is_cloud_model_name(rt_name) or self._realtime_transcriber is None:
            return
        old = self._detach_current_transcriber("realtime")
        self._shutdown_transcriber_safely("realtime", old)
        gc.collect()
        self._realtime_unloaded_for_cloud_main = True
        logger.info("[unload] released separate realtime model (main is cloud): %s", rt_name)

    def _reload_separate_realtime_after_cloud_main(self, rt_name: str) -> None:
        """Rebuild the local realtime model a prior cloud main tore down.

        Only fires when ``_unload_separate_realtime_for_cloud_main`` previously
        ran, so a normal local→local main swap never touches the
        independently-managed realtime slot. The load runs synchronously on the
        swap worker (mirrors ``_relink_realtime_to_main``); a load failure
        leaves the slot empty and the realtime worker simply keeps backing off.
        """
        if not self._realtime_unloaded_for_cloud_main:
            return
        self._realtime_unloaded_for_cloud_main = False
        if not _is_cloud_model_name(rt_name):
            self._rebuild_realtime_slot(rt_name)

    def _rebuild_realtime_slot(self, rt_name: str) -> None:
        """Load ``rt_name`` and point the realtime slot at it (no-op on load failure)."""
        new_rt = self._load_transcriber_or_none(rt_name)
        if new_rt is None:
            return
        with self._realtime_transcriber_lock:
            self._realtime_transcriber = new_rt
        logger.info("[reload] rebuilt separate realtime model (main is local): %s", rt_name)

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
        if not all([rt_enabled, rt_has_transcriber]):
            self._log_realtime_not_started(rt_enabled=rt_enabled, rt_has_transcriber=rt_has_transcriber)
            return
        self._realtime_thread = threading.Thread(target=self._realtime_worker, daemon=True)
        self._realtime_thread.start()
        logger.info("Realtime worker STARTED (model=%s)", self._config.realtime.realtime_model_type)

    @staticmethod
    def _log_realtime_not_started(*, rt_enabled: bool, rt_has_transcriber: bool) -> None:
        """Log why the realtime worker was skipped at the right severity.

        INFO when realtime is intentionally disabled by config; escalate to
        WARNING only on the surprising case where the user asked for it
        (``rt_enabled=True``) but the transcriber failed to build.
        """
        log_fn = logger.warning if all([rt_enabled, not rt_has_transcriber]) else logger.info
        log_fn(
            "Realtime worker NOT started (enabled=%s, has_transcriber=%s)",
            rt_enabled,
            rt_has_transcriber,
        )

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
            self._realtime_idle_reset(state)
            return
        self._realtime_mark_recording_start(state)
        if not self._realtime_ready(state):
            return
        self._realtime_run_if_fresh(state)

    def _realtime_run_if_fresh(self, state: _RealtimeLoopState) -> None:
        """Transcribe a fresh tick, or back off when the buffer hasn't grown.

        Stale-audio guard: if the audio buffer hasn't grown since our last
        transcribe, the recording has effectively stopped feeding frames even
        though the state machine still says is_recording=True. Re-transcribing
        the same content is pure waste — we'd publish the same preview text at
        every iteration, hammer the GPU, and (with the post-Option C CUDA-thread
        tuning making transcribe ~17 ms on Canary) spin a ~30 ms-per-iteration
        tight loop. Back off to a 50 ms sleep instead and try again next tick.
        The frame_count counter advances monotonically as the audio reader feeds
        new chunks, so we resume normal cadence as soon as fresh audio actually
        arrives. Loses zero responsiveness on the happy path.
        """
        current_frame_count = self._audio_buffer.frame_count
        if current_frame_count == state.last_processed_frame_count:
            time.sleep(0.05)
            return
        state.last_processed_frame_count = current_frame_count
        state.last_transcription = time.time()
        self._realtime_process_once()

    def _realtime_idle_reset(self, state: _RealtimeLoopState) -> None:
        """Reset accumulator + per-loop state while not recording, then idle-sleep."""
        self._reset_realtime_accumulator(clear_last=False)
        state.recording_seen_at = None
        state.last_processed_frame_count = -1
        time.sleep(0.01)

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
        if any([not cfg.filter_fillers, not text]):
            return text
        from src.recorder.text.filler_filter import filter_transcription_output

        lang = self._resolve_filler_language(language)
        custom = cfg.custom_filler_words if cfg.custom_filler_words else None
        return filter_transcription_output(text, lang, custom)

    def _resolve_filler_language(self, language: str) -> str:
        """Detected language, falling back to the configured Whisper language."""
        return language or self._config.transcription.language

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
