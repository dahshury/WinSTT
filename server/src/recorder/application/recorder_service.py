from __future__ import annotations

import collections
import logging
import queue
import re
import threading
import time
from dataclasses import dataclass
from types import TracebackType
from typing import TYPE_CHECKING, Any

import numpy as np

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.building_blocks.types import AudioChunk, BufferSize, SampleRate

if TYPE_CHECKING:
    from collections.abc import Callable

    from src.building_blocks.types import TextCallback
    from src.recorder.domain.model_registry import ModelInfo
from src.recorder.application.pipeline import RecordingPipeline
from src.recorder.domain.audio_buffer import AudioBuffer
from src.recorder.domain.config import RecorderConfig
from src.recorder.domain.errors import DownloadCancelledError
from src.recorder.domain.events import (
    DownloadProgress,
    ModelSwapCompleted,
    ModelSwapFailed,
    ModelSwapStarted,
    NoAudioDetected,
    RealtimeTranscriptionUpdate,
    TranscriptionCompleted,
    TranscriptionStarted,
)
from src.recorder.domain.ports.audio_source import IAudioSource
from src.recorder.domain.ports.transcriber import ITranscriber
from src.recorder.domain.ports.vad import IVoiceActivityDetector
from src.recorder.domain.ports.wake_word import IWakeWordDetector
from src.recorder.domain.state_machine import RecorderState, RecorderStateMachine

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
        config: RecorderConfig,
        event_bus: EventBus,
        clock: Clock | None = None,
    ) -> None:
        self._audio_source = audio_source
        self._vad = vad
        self._transcriber = transcriber
        self._wake_word_detector = wake_word_detector
        self._realtime_transcriber = realtime_transcriber
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
        self._transcriber_lock = threading.Lock()
        # Realtime stable-text accumulator state — owned and reset by the
        # realtime worker thread.
        self._realtime_committed_text: str = ""
        self._realtime_committed_frames: int = 0
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

    def text(self, on_transcription_finished: TextCallback | None = None) -> str:
        self.listen()
        if not self.wait_audio():
            self._audio_buffer.clear()
            return ""
        frame_count = self._audio_buffer.frame_count
        audio_seconds = self._audio_buffer.duration_seconds
        raw_audio = b"".join(self._audio_buffer.frames)
        audio = self._audio_buffer.get_audio_array()
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

        self._event_bus.publish(TranscriptionCompleted(timestamp=self._clock.get_current_time(), text=text))

        self._finalize_transcription_state()
        self._dispatch_transcription_callback(on_transcription_finished, text)
        return text

    @staticmethod
    def _audio_stats(audio: np.ndarray[Any, Any]) -> tuple[float, float, float]:
        """Peak / RMS / nonzero-fraction of an audio buffer (0.0 when empty)."""
        if audio.size == 0:
            return 0.0, 0.0, 0.0
        peak = float(np.max(np.abs(audio)))
        rms = float(np.sqrt(np.mean(audio * audio)))
        nonzero_frac = float(np.count_nonzero(audio)) / audio.size
        return peak, rms, nonzero_frac

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
        with self._transcriber_lock:
            result = self._transcriber.transcribe(audio, self._config.transcription.language)
        text = self._preprocess_output(result.text)
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
        self._pipeline.request_start()
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
            from scipy.signal import resample

            num_samples = int(len(arr) * self._config.audio.sample_rate / original_sample_rate)
            arr = resample(arr, num_samples)
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
        """
        self._microphone_enabled = microphone_on
        # Wake-word backends require always-on capture so the detector
        # can listen for the trigger word; for everything else we toggle
        # the hardware stream so the OS mic indicator follows user intent.
        if self._wake_word_detector is None:
            self._toggle_hardware_capture(microphone_on)
        if not microphone_on:
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
        # Stop pipeline first to halt audio processing.
        self._safe_step("stopping pipeline", lambda: self._pipeline.stop(timeout=2.0))
        self._safe_step("cleaning up audio source", self._audio_source.cleanup)
        self._join_worker_threads()
        self._shutdown_transcribers()
        self._shutdown_wake_word_detector()
        self._safe_step("aborting state machine", self._state_machine.abort)

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
        self._safe_step("shutting down transcriber", self._transcriber.shutdown)
        rt = self._realtime_transcriber
        if rt is not None and rt is not self._transcriber:
            self._safe_step("shutting down realtime transcriber", rt.shutdown)

    def _shutdown_wake_word_detector(self) -> None:
        if self._wake_word_detector is not None:
            self._safe_step("cleaning up wake word detector", self._wake_word_detector.cleanup)

    def warmup(self) -> None:
        """Run a dummy inference to eagerly compile CUDA kernels.

        Call once after construction so the first real transcription
        doesn't pay the JIT-compilation cost.
        """
        dummy = np.zeros(16000, dtype=np.float32)  # 1 s silence @ 16 kHz
        lang = self._config.transcription.language
        self._transcriber.transcribe(dummy, lang)
        if self._realtime_transcriber is not None:
            self._realtime_transcriber.transcribe(dummy, lang)

    def abort(self) -> None:
        self._pipeline.request_abort()
        # Put a sentinel on the queue to unblock wait_audio() immediately
        self._pipeline.transcription_queue.put_nowait(None)

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
        audio = self._audio_buffer.get_audio_array()
        with self._transcriber_lock:
            result = self._transcriber.transcribe(audio, self._config.transcription.language)
        return self._preprocess_output(result.text)

    def swap_transcriber(self, new: ITranscriber) -> None:
        with self._transcriber_lock:
            old = self._transcriber
            self._transcriber = new
        old.shutdown()

    # ── Live model swap ─────────────────────────────────────────────────
    #
    # The pattern: build the new transcriber on a background thread (so
    # ``request_model_swap`` returns immediately to the WS handler), keep
    # the old transcriber active during the build so PTT presses still
    # work, then atomically swap pointers under ``_transcriber_lock`` once
    # the new model is loaded. Old model is shut down after the swap to
    # release ORT sessions (verified bounded RSS — see lifecycle tests in
    # ``examples/onnx-asr/tests/onnx_asr/test_lifecycle_close.py``).
    #
    # Cancellation: a per-kind ``threading.Event`` is checked from the
    # download progress callback; setting it raises ``DownloadCancelledError``
    # mid-download, the thread emits ``ModelSwapFailed`` and exits without
    # touching the current transcriber.
    #
    # Concurrency: only one swap per kind ("main" / "realtime") at a time.
    # A second request for the same kind cancels the in-flight one (its
    # half-built transcriber gets dropped) before kicking off the new one.
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
        if self._realtime_swap_disabled(kind):
            self._event_bus.publish(
                ModelSwapFailed(
                    timestamp=self._clock.get_current_time(),
                    kind=kind,
                    name=name,
                    reason="realtime transcription is disabled",
                )
            )
            return False
        return True

    def _realtime_swap_disabled(self, kind: str) -> bool:
        return kind == "realtime" and not self._config.realtime.enable_realtime_transcription

    def _cancel_inflight_swap(self, kind: str) -> None:
        prior_cancel = self._swap_cancel_events.get(kind)
        if prior_cancel is not None:
            prior_cancel.set()

    def _publish_swap_failed(self, kind: str, name: str, reason: str) -> None:
        self._event_bus.publish(
            ModelSwapFailed(
                timestamp=self._clock.get_current_time(),
                kind=kind,
                name=name,
                reason=reason,
            )
        )

    def _swap_worker(self, kind: str, name: str, cancel_event: threading.Event) -> None:
        """Background worker that builds + swaps a transcriber. Emits lifecycle events."""
        self._event_bus.publish(ModelSwapStarted(timestamp=self._clock.get_current_time(), kind=kind, name=name))
        new_transcriber = self._build_new_transcriber(kind, name, cancel_event)
        if new_transcriber is None:
            return
        # New transcriber is loaded — do the atomic pointer swap. The
        # transcribe path acquires ``_transcriber_lock`` for every call,
        # so this is safe even during an active recording cycle.
        if cancel_event.is_set():
            # A newer swap was requested mid-load; drop this one rather
            # than racing the newer swap's worker.
            new_transcriber.shutdown()
            self._publish_swap_failed(kind, name, "superseded")
            return
        old = self._commit_swap(kind, name, new_transcriber)
        self._shutdown_old_transcriber(kind, old, new_transcriber)
        self._event_bus.publish(ModelSwapCompleted(timestamp=self._clock.get_current_time(), kind=kind, name=name))

    def _build_new_transcriber(
        self,
        kind: str,
        name: str,
        cancel_event: threading.Event,
    ) -> ITranscriber | None:
        """Load the new transcriber. Emits ``ModelSwapFailed`` + returns None on error."""
        try:
            return self._load_transcriber(name, _SwapProgress(self, name, cancel_event))
        except DownloadCancelledError:
            logger.info("Model swap %s → %s cancelled mid-download", kind, name)
            self._publish_swap_failed(kind, name, "cancelled")
            return None
        except Exception as e:
            logger.exception("Model swap %s → %s failed during load", kind, name)
            self._publish_swap_failed(kind, name, f"{type(e).__name__}: {e}")
            return None

    def _load_transcriber(
        self,
        name: str,
        on_progress: Callable[[DownloadProgress], None],
    ) -> ITranscriber:
        # Late import to keep the application layer free of infrastructure imports
        # at module load time. The hexagonal rulebook keeps bootstrap as the only
        # composition root; swaps are a tactical exception scoped to this method.
        from src.recorder.domain.model_registry import ModelCatalog
        from src.recorder.infrastructure.device import providers_for_device
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        info = ModelCatalog().get(name)
        return OnnxAsrTranscriber(
            model_name=self._resolve_onnx_name(info, name),
            quantization=self._config.transcription.onnx_quantization or None,
            providers=providers_for_device(self._config.transcription.device),
            on_download_progress=on_progress,
        )

    @staticmethod
    def _resolve_onnx_name(info: ModelInfo | None, name: str) -> str:
        if info is not None and info.onnx_model_name:
            return info.onnx_model_name
        return name

    def _commit_swap(self, kind: str, name: str, new_transcriber: ITranscriber) -> ITranscriber | None:
        """Atomically install ``new_transcriber`` under the lock; return the old one."""
        old: ITranscriber | None
        with self._transcriber_lock:
            if kind == "main":
                old = self._transcriber
                self._transcriber = new_transcriber
                self._config.transcription.model = name
                return old
            old = self._realtime_transcriber
            self._realtime_transcriber = new_transcriber
            self._config.realtime.realtime_model_type = name
            return old

    @classmethod
    def _shutdown_old_transcriber(
        cls,
        kind: str,
        old: ITranscriber | None,
        new_transcriber: ITranscriber,
    ) -> None:
        # Shutdown the old model AFTER releasing the lock so transcribe()
        # callers aren't blocked on the ORT cleanup walk.
        if cls._old_transcriber_replaced(old, new_transcriber):
            try:
                old.shutdown()  # type: ignore[union-attr]  # guarded above
            except Exception:
                logger.exception("Old %s transcriber shutdown raised", kind)

    @staticmethod
    def _old_transcriber_replaced(old: ITranscriber | None, new_transcriber: ITranscriber) -> bool:
        return old is not None and old is not new_transcriber

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
            logger.warning(
                "Realtime worker NOT started (enabled=%s, has_transcriber=%s)",
                rt_enabled,
                rt_has_transcriber,
            )
            return
        self._realtime_thread = threading.Thread(target=self._realtime_worker, daemon=True)
        self._realtime_thread.start()
        logger.warning("Realtime worker STARTED (model=%s)", self._config.realtime.realtime_model_type)

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

    def _realtime_step(self, state: _RealtimeLoopState) -> None:
        """One realtime-worker loop iteration (mirrors the old loop body)."""
        if not self._state_machine.is_recording:
            self._reset_realtime_accumulator(clear_last=False)
            state.recording_seen_at = None
            time.sleep(0.01)
            return
        self._realtime_mark_recording_start(state)
        if not self._realtime_ready(state):
            return
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
        assert self._realtime_transcriber is not None
        commit_audio = self._audio_buffer.get_audio_array_slice(
            committed_frames, committed_frames + commit_chunk_frames
        )
        if len(commit_audio) == 0:
            return
        with self._transcriber_lock:
            commit_result = self._realtime_transcriber.transcribe(
                commit_audio,
                self._config.transcription.language,
            )
        commit_text = self._preprocess_output(commit_result.text)
        if commit_text:
            self._append_committed_text(commit_text)

    def _append_committed_text(self, commit_text: str) -> None:
        if self._realtime_committed_text:
            self._realtime_committed_text = self._realtime_committed_text + " " + commit_text
        else:
            self._realtime_committed_text = commit_text

    def _realtime_publish_fresh(self, committed_frames: int) -> None:
        assert self._realtime_transcriber is not None
        # Transcribe the fresh window past the watermark for the live preview.
        audio_array = self._audio_buffer.get_audio_array_slice(committed_frames, None)
        if len(audio_array) == 0:  # pragma: no cover
            return
        with self._transcriber_lock:
            result = self._realtime_transcriber.transcribe(
                audio_array,
                self._config.transcription.language,
            )
        fresh_text = self._preprocess_output(result.text)
        text = self._assemble_realtime_text(fresh_text)
        if self._state_machine.is_recording:  # pragma: no branch
            # Preserve the latest realtime text so text() can adopt it as the
            # final result when use_main_model_for_realtime is on.
            self._last_realtime_text = text
            self._event_bus.publish(RealtimeTranscriptionUpdate(timestamp=self._clock.get_current_time(), text=text))

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

    def _preprocess_output(self, text: str) -> str:
        text = re.sub(r"\s+", " ", text.strip())
        text = self._apply_starting_uppercase(text)
        return self._apply_trailing_period(text)

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
