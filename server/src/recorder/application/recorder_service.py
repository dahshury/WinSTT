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
from typing import TYPE_CHECKING, Any

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

    def _pick_realtime_lock(
        self,
        transcriber: ITranscriber,
        realtime_transcriber: ITranscriber | None,
    ) -> threading.Lock:
        """Share the main lock when both slots hold the same transcriber.

        A shared ORT session isn't reentrant-safe, so the same instance in
        both slots must serialise against itself; distinct instances get
        independent locks so main + realtime don't block each other.
        """
        if realtime_transcriber is not None and realtime_transcriber is transcriber:
            return self._main_transcriber_lock
        return threading.Lock()

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
        self._maybe_emit_speaker_segments(audio, text)
        self._finalize_transcription_state()
        self._dispatch_transcription_callback(on_transcription_finished, text)
        return text

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

    def _safe_transcribe(
        self,
        transcriber: ITranscriber | None,
        audio: np.ndarray[Any, Any],
        language: str,
        *,
        lock: threading.Lock | None = None,
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
        """
        if lock is None:
            lock = self._main_transcriber_lock
        with lock:
            if not self._transcriber_ready(transcriber):
                return None
            assert transcriber is not None  # narrowed by _transcriber_ready
            return transcriber.transcribe(audio, language)

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

        Call once after construction so the first real transcription
        doesn't pay the JIT-compilation cost.
        """
        dummy = np.zeros(16000, dtype=np.float32)  # 1 s silence @ 16 kHz
        lang = self._config.transcription.language
        # Warmup runs immediately after construction (before any swap is
        # possible) but the slots are typed as Optional via the swap
        # bookkeeping — guard for type safety / defensive code.
        self._warm_transcriber(self._transcriber, dummy, lang)
        self._warm_transcriber(self._realtime_transcriber, dummy, lang)
        # Eagerly load the diarizer's ORT sessions (pyannote-segmentation +
        # wespeaker, ~32 MB first-run download) the same way we warm the
        # transcribers. Without this the first diarized utterance pays the
        # download+JIT tax mid-recording; with it, `server_ready` (and the
        # renderer's diarization "warming" spinner) only clears once the
        # diarizer is actually hot. Fail-soft via _safe_diarize.
        if self._diarizer is not None:
            self._safe_diarize(dummy)

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
        result = self._safe_transcribe(self._transcriber, audio, self._config.transcription.language)
        if result is None:
            logger.warning("transcribe() skipped — model swap in progress")
            return ""
        return self._preprocess_output(result.text)

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
        new_transcriber, load_outcome = self._load_new_for_swap(kind, name, cancel_event, bench)
        bench.sample_memory("after_load")

        if self._swap_aborted(new_transcriber, cancel_event):
            load_outcome = self._handle_aborted_swap(kind, name, new_transcriber, cancel_event, load_outcome)
            restore_outcome = self._attempt_restore(kind, previous_name, bench)
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
    ) -> tuple[ITranscriber | None, str]:
        """Load the new transcriber inside the bench's ``load`` phase.

        Returns ``(transcriber_or_None, outcome_tag)``. On failure also
        emits ``ModelSwapFailed`` on the event bus so the UI's revert
        path fires before the (optional) restore attempt runs.
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
                self._publish_swap_failed(kind, name, info)
                return None, info.category.value
        return new, "completed"

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
        from src.recorder.domain.model_registry import ModelCatalog
        from src.recorder.infrastructure.device import providers_for_settings
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        info = ModelCatalog().get(name)
        return OnnxAsrTranscriber(
            model_name=self._resolve_onnx_name(info, name),
            quantization=self._config.transcription.onnx_quantization or None,
            providers=providers_for_settings(
                self._config.transcription.device,
                self._config.transcription.accelerator,
            ),
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
        """Point the chosen slot at ``new_transcriber`` and persist its name."""
        if is_main:
            self._transcriber = new_transcriber
            self._config.transcription.model = name
            return
        self._realtime_transcriber = new_transcriber
        self._config.realtime.realtime_model_type = name

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
            # New recording: the stabilizer's prior safetext is irrelevant
            # to the next utterance and would mis-anchor on stale content.
            self._realtime_stabilizer.reset()

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
        )
        if result is None:
            return None
        return self._preprocess_output(result.text)

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
