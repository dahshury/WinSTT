"""Recorder module - exports the backward-compatible AudioToTextRecorder facade."""

from __future__ import annotations

import collections
import logging
import threading
from collections.abc import Callable, Iterable
from types import TracebackType
from typing import TYPE_CHECKING, Any

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.building_blocks.types import (
    AudioChunk,
    BufferSize,
    CallbackMap,
    LevelCallback,
    SampleRate,
    SimpleCallback,
    TextCallback,
)
from src.recorder.domain.events import DownloadProgress

if TYPE_CHECKING:
    import numpy as np

    from src.building_blocks.types import ChunkCallback
    from src.recorder.domain.ports.wake_word import IWakeWordDetector
from src.recorder.application.recorder_service import RecorderService
from src.recorder.domain.config import RecorderConfig

# Import ``device`` early so :func:`resolve_accelerator` /
# :func:`_probe_cuda_session` are resolvable from anywhere in the facade
# init chain. NVIDIA wheel DLL injection used to run as a module-load
# side effect here; it's now lazy inside ``_probe_cuda_session`` so the
# DirectML / CPU paths don't pay for preloading hundreds of MB of CUDA
# DLLs they'll never use. Every call site that can produce a CUDA EP
# session routes through ``resolve_accelerator`` (recorder side) or calls
# ``_probe_cuda_session`` directly (synthesizer side), so the injection
# still happens before ORT's CUDA EP DLL is loaded.
from src.recorder.infrastructure import device as _device  # noqa: F401
from src.recorder.infrastructure.file_source import FileAudioSource

logger = logging.getLogger(__name__)

# Re-export for convenience
__all__ = ["AudioToTextRecorder"]


class _BoolFlag:
    """Tiny wrapper that mimics ``multiprocessing.Value(c_bool)`` for backward compat.

    The monolith exposes ``recorder.use_microphone`` as an ``mp.Value(c_bool)``
    so demo code reads ``recorder.use_microphone.value``.  This shim provides the
    same ``.value`` interface without pulling in multiprocessing.
    """

    __slots__ = ("_value",)

    def __init__(self, initial: bool) -> None:
        self._value = initial

    @property
    def value(self) -> bool:
        return self._value

    @value.setter
    def value(self, v: bool) -> None:
        self._value = v

    def __bool__(self) -> bool:
        return self._value

    def __repr__(self) -> str:
        return f"_BoolFlag({self._value})"


class AudioToTextRecorder:
    """Backward-compatible facade accepting ALL original constructor params.

    Delegates to RecorderService via the hexagonal architecture.
    """

    def __init__(
        self,
        model: str = "tiny",
        download_root: str | None = None,
        language: str = "",
        compute_type: str = "default",
        input_device_index: int | None = None,
        gpu_device_index: int | list[int] = 0,
        device: str = "cuda",
        on_recording_start: SimpleCallback | None = None,
        on_recording_stop: SimpleCallback | None = None,
        on_no_audio_detected: SimpleCallback | None = None,
        on_transcription_start: SimpleCallback | None = None,
        ensure_sentence_starting_uppercase: bool = True,
        ensure_sentence_ends_with_period: bool = True,
        use_microphone: bool = True,
        # See ``AudioConfig.always_on_microphone`` — default False means the
        # OS mic stream isn't allocated until the first PTT press, and is
        # released on PTT idle so the mic-in-use indicator clears.
        always_on_microphone: bool = False,
        # See ``AudioConfig.lazy_stream_close`` — only meaningful when
        # ``always_on_microphone`` is False. Delays the on-release close
        # by ``lazy_close_timeout_seconds`` so back-to-back PTT presses
        # don't re-pay the open cost.
        lazy_stream_close: bool = False,
        # Seconds before the lazy-close timer fires. Only consulted when
        # ``lazy_stream_close`` is True. Default 30 s matches Handy.
        lazy_close_timeout_seconds: float = 30.0,
        # See ``AudioConfig.extra_recording_buffer_ms`` — tail-of-recording
        # capture window in ms applied to set_microphone(False) stops (PTT
        # release, toggle off). 0 (default) preserves the current snap-stop
        # behaviour.
        extra_recording_buffer_ms: int = 0,
        spinner: bool = True,
        level: int = logging.WARNING,
        # Realtime transcription parameters
        enable_realtime_transcription: bool = False,
        use_main_model_for_realtime: bool = False,
        realtime_model_type: str = "tiny",
        realtime_processing_pause: float = 0.2,
        init_realtime_after_seconds: float = 0.2,
        on_realtime_transcription_update: TextCallback | None = None,
        on_realtime_transcription_stabilized: TextCallback | None = None,
        # Voice activation parameters. See :class:`VADConfig` for the
        # silero_sensitivity default rationale — 0.7 (Silero trip > 0.3)
        # matches Handy; the previous 0.4 (trip > 0.6) silently rejected
        # quiet / distant speech.
        silero_sensitivity: float = 0.7,
        silero_use_onnx: bool = False,
        silero_deactivity_detection: bool = False,
        webrtc_sensitivity: int = 3,
        post_speech_silence_duration: float = 0.6,
        min_gap_between_recordings: float = 0.0,
        pre_recording_buffer_duration: float = 1.0,
        on_vad_start: SimpleCallback | None = None,
        on_vad_stop: SimpleCallback | None = None,
        on_vad_detect_start: SimpleCallback | None = None,
        on_vad_detect_stop: SimpleCallback | None = None,
        on_turn_detection_start: SimpleCallback | None = None,
        on_turn_detection_stop: SimpleCallback | None = None,
        # Wake word parameters
        wakeword_backend: str = "",
        openwakeword_model_paths: str | None = None,
        openwakeword_inference_framework: str = "onnx",
        wake_words: str = "",
        wake_words_sensitivity: float = 0.6,
        wake_word_activation_delay: float = 0.0,
        wake_word_timeout: float = 5.0,
        wake_word_buffer_duration: float = 0.1,
        on_wakeword_detected: SimpleCallback | None = None,
        on_wakeword_timeout: SimpleCallback | None = None,
        on_wakeword_detection_start: SimpleCallback | None = None,
        on_wakeword_detection_end: SimpleCallback | None = None,
        on_recorded_chunk: ChunkCallback | None = None,
        on_audio_level: LevelCallback | None = None,
        on_device_switch_failed: Callable[[int, str, int | None], None] | None = None,
        on_device_became_available: Callable[[int], None] | None = None,
        # Model swap lifecycle (Phase 1) — fired when request_model_swap()
        # begins, succeeds, or fails. ``started`` / ``completed`` get (kind, name);
        # ``failed`` adds a third ``reason`` arg.
        on_model_swap_started: Callable[[str, str], None] | None = None,
        on_model_swap_completed: Callable[[str, str], None] | None = None,
        on_model_swap_failed: Callable[[str, str, str], None] | None = None,
        # Diarization toggle lifecycle — fired when request_diarization_toggle()
        # begins, succeeds, or fails. ``started`` / ``completed`` receive the
        # target ``enabled`` boolean; ``failed`` adds (reason, category, detail)
        # mirroring on_model_swap_failed so the renderer can share its toast
        # variant lookup. ``None`` (the default) leaves the callback unwired;
        # the toggle still functions, but the UI gets no lifecycle pushes.
        on_diarization_toggle_started: Callable[[bool], None] | None = None,
        on_diarization_toggle_completed: Callable[[bool], None] | None = None,
        on_diarization_toggle_failed: Callable[[bool, str, str, str], None] | None = None,
        on_vad_sensitivity_adapted: Callable[[float, float, float], None] | None = None,
        #: Diarization callback — fires after each utterance when speaker
        #: segmentation is enabled. Receives the tuple of segments from
        #: :class:`SpeakerSegmentsDetected`. ``None`` (the default) leaves
        #: the callback unwired; the recorder still runs without it.
        on_speaker_segments_detected: Callable[[Any], None] | None = None,
        debug_mode: bool = False,
        handle_buffer_overflow: bool = True,
        buffer_size: int = 512,
        sample_rate: int = 16000,
        initial_prompt: str | Iterable[int] | None = None,
        initial_prompt_realtime: str | Iterable[int] | None = None,
        print_transcription_time: bool = False,
        early_transcription_on_silence: float = 0,
        allowed_latency_limit: int = 100,
        no_log_file: bool = False,
        use_extended_logging: bool = False,
        normalize_audio: bool = True,
        start_callback_in_new_thread: bool = False,
        # Model download callbacks
        on_model_download_start: Callable[[str], None] | None = None,
        on_model_download_progress: Callable[[DownloadProgress], None] | None = None,
        on_model_download_complete: Callable[[str], None] | None = None,
        on_model_download_cancelled: Callable[[str], None] | None = None,
        # Download cancellation check
        cancel_download_check: Callable[[], bool] | None = None,
        # Backend selection
        backend: str = "",
        onnx_quantization: str = "",
        # See ``TranscriptionConfig.translate_to_english`` — Whisper task=translate.
        translate_to_english: bool = False,
        # See ``TranscriptionConfig.model_unload_timeout_seconds`` — idle
        # tear-down of ONNX sessions to reclaim memory.
        model_unload_timeout_seconds: int | None = 300,
        # Diarization — see :class:`DiarizationConfig`. Off by default; first
        # ``enable_diarization=True`` build downloads ~32 MB of ONNX models.
        enable_diarization: bool = False,
        diarization_max_speakers: int = 8,
        # Deterministic post-ASR fuzzy corrector — see
        # :class:`TextCorrectionConfig`. Empty list (the default) is a no-op
        # fast path; populated, each transcription is run through the n-gram
        # fuzzy matcher BEFORE the LLM modifier pipeline so the LLM sees
        # already-corrected text.
        custom_words: list[str] | None = None,
        word_correction_threshold: float = 0.18,
        # Locale-aware filler-word strip + 3+ stutter collapse. See
        # :class:`TextCorrectionConfig.filter_fillers` /
        # ``custom_filler_words``. Ported from Handy's
        # ``filter_transcription_output``.
        filter_fillers: bool = True,
        custom_filler_words: list[str] | None = None,
    ) -> None:
        # ``list`` defaults are mutable — accept ``None`` and normalise here
        # so the kwarg's identity isn't shared across instances.
        if custom_words is None:
            custom_words = []
        if custom_filler_words is None:
            custom_filler_words = []

        # Build config from all kwargs
        self._config = RecorderConfig.from_kwargs(
            # Audio
            input_device_index=input_device_index,
            sample_rate=sample_rate,
            buffer_size=buffer_size,
            use_microphone=use_microphone,
            always_on_microphone=always_on_microphone,
            lazy_stream_close=lazy_stream_close,
            lazy_close_timeout_seconds=lazy_close_timeout_seconds,
            extra_recording_buffer_ms=extra_recording_buffer_ms,
            handle_buffer_overflow=handle_buffer_overflow,
            # VAD
            silero_sensitivity=silero_sensitivity,
            silero_use_onnx=silero_use_onnx,
            silero_deactivity_detection=silero_deactivity_detection,
            webrtc_sensitivity=webrtc_sensitivity,
            post_speech_silence_duration=post_speech_silence_duration,
            min_gap_between_recordings=min_gap_between_recordings,
            pre_recording_buffer_duration=pre_recording_buffer_duration,
            # Transcription
            model=model,
            download_root=download_root,
            language=language,
            compute_type=compute_type,
            gpu_device_index=gpu_device_index,
            device=device,
            initial_prompt=initial_prompt,
            normalize_audio=normalize_audio,
            print_transcription_time=print_transcription_time,
            early_transcription_on_silence=early_transcription_on_silence,
            allowed_latency_limit=allowed_latency_limit,
            backend=backend,
            onnx_quantization=onnx_quantization,
            translate_to_english=translate_to_english,
            model_unload_timeout_seconds=model_unload_timeout_seconds,
            # Realtime
            enable_realtime_transcription=enable_realtime_transcription,
            use_main_model_for_realtime=use_main_model_for_realtime,
            realtime_model_type=realtime_model_type,
            realtime_processing_pause=realtime_processing_pause,
            init_realtime_after_seconds=init_realtime_after_seconds,
            initial_prompt_realtime=initial_prompt_realtime,
            # Wake word
            wakeword_backend=wakeword_backend,
            openwakeword_model_paths=openwakeword_model_paths,
            openwakeword_inference_framework=openwakeword_inference_framework,
            wake_words=wake_words,
            wake_words_sensitivity=wake_words_sensitivity,
            wake_word_activation_delay=wake_word_activation_delay,
            wake_word_timeout=wake_word_timeout,
            wake_word_buffer_duration=wake_word_buffer_duration,
            # UI
            spinner=spinner,
            ensure_sentence_starting_uppercase=ensure_sentence_starting_uppercase,
            ensure_sentence_ends_with_period=ensure_sentence_ends_with_period,
            debug_mode=debug_mode,
            level=level,
            no_log_file=no_log_file,
            use_extended_logging=use_extended_logging,
            start_callback_in_new_thread=start_callback_in_new_thread,
            # Diarization — route to :class:`DiarizationConfig`. Field names
            # ``enabled`` / ``max_speakers`` are unique to that sub-config, so
            # ``_field_owner_index`` lands them in the right bucket.
            enabled=enable_diarization,
            max_speakers=diarization_max_speakers,
            # Text correction — list + threshold are unique field names on
            # :class:`TextCorrectionConfig`. Both are renamed for the public
            # API (``custom_words`` and ``word_correction_threshold``) so the
            # facade signature matches the OpenAPI spec; ``threshold`` in
            # config-space is the bare numeric value.
            custom_words=custom_words,
            threshold=word_correction_threshold,
            filter_fillers=filter_fillers,
            custom_filler_words=custom_filler_words,
        )

        # Collect callbacks
        self._callbacks: CallbackMap = {
            "on_recording_start": on_recording_start,
            "on_recording_stop": on_recording_stop,
            "on_no_audio_detected": on_no_audio_detected,
            "on_transcription_start": on_transcription_start,
            "on_vad_start": on_vad_start,
            "on_vad_stop": on_vad_stop,
            "on_vad_detect_start": on_vad_detect_start,
            "on_vad_detect_stop": on_vad_detect_stop,
            "on_turn_detection_start": on_turn_detection_start,
            "on_turn_detection_stop": on_turn_detection_stop,
            "on_wakeword_detected": on_wakeword_detected,
            "on_wakeword_timeout": on_wakeword_timeout,
            "on_wakeword_detection_start": on_wakeword_detection_start,
            "on_wakeword_detection_end": on_wakeword_detection_end,
            "on_recorded_chunk": on_recorded_chunk,
            "on_audio_level": on_audio_level,
            "on_realtime_transcription_update": on_realtime_transcription_update,
            "on_realtime_transcription_stabilized": on_realtime_transcription_stabilized,
            "on_device_switch_failed": on_device_switch_failed,
            "on_device_became_available": on_device_became_available,
            "on_model_swap_started": on_model_swap_started,
            "on_model_swap_completed": on_model_swap_completed,
            "on_model_swap_failed": on_model_swap_failed,
            "on_diarization_toggle_started": on_diarization_toggle_started,
            "on_diarization_toggle_completed": on_diarization_toggle_completed,
            "on_diarization_toggle_failed": on_diarization_toggle_failed,
            "on_vad_sensitivity_adapted": on_vad_sensitivity_adapted,
            "on_speaker_segments_detected": on_speaker_segments_detected,
        }

        # Download progress callbacks (typed separately — they accept model name / progress args)
        self._on_dl_start = on_model_download_start
        self._on_dl_progress = on_model_download_progress
        self._on_dl_complete = on_model_download_complete
        self._on_dl_cancelled = on_model_download_cancelled
        self._cancel_download_check = cancel_download_check

        # Build service with fakes for testing or real adapters via bootstrap
        self._event_bus = EventBus()
        self._clock = Clock.system_clock()
        self._service: RecorderService | None = None
        self._silero_vad: Any = None  # Live SileroVAD reference for runtime sensitivity updates
        self._webrtc_vad: Any = None  # Live WebRTCVAD reference for runtime sensitivity updates
        self._vad_calibrator: Any = None  # Cross-utterance Silero sensitivity adapter
        self._init_lock = threading.Lock()
        self.use_microphone = _BoolFlag(use_microphone)
        self._sigint_reinstall: SimpleCallback | None = None

    def _ensure_service(self) -> RecorderService:  # pragma: no cover
        if self._service is not None:
            return self._service
        with self._init_lock:
            # Double-check after acquiring lock
            if self._service is not None:
                return self._service
            from src.recorder.bootstrap import (
                DownloadCallbacks,
                build_realtime_transcriber,
                build_transcriber,
                wire_all_callbacks,
            )

            wire_all_callbacks(self._event_bus, self._callbacks)

            # Build audio source
            from src.recorder.domain.ports.audio_source import IAudioSource

            audio_source: IAudioSource
            if self._config.audio.use_microphone:
                from src.recorder.domain.events import DeviceBecameAvailable, DeviceSwitchFailed
                from src.recorder.infrastructure.pyaudio_source import PyAudioSource

                event_bus = self._event_bus
                clock = self._clock

                def _on_device_switch_failed(
                    requested_index: int,
                    error_message: str,
                    fallback_index: int | None,
                ) -> None:
                    event_bus.publish(
                        DeviceSwitchFailed(
                            timestamp=clock.get_current_time(),
                            requested_index=requested_index,
                            error_message=error_message,
                            fallback_index=fallback_index,
                        )
                    )

                def _on_device_became_available(device_index: int) -> None:
                    event_bus.publish(
                        DeviceBecameAvailable(
                            timestamp=clock.get_current_time(),
                            device_index=device_index,
                        )
                    )

                audio_source = PyAudioSource(
                    input_device_index=self._config.audio.input_device_index,
                    target_sample_rate=SampleRate(self._config.audio.sample_rate),
                    buffer_size=BufferSize(self._config.audio.buffer_size),
                    on_device_switch_failed=_on_device_switch_failed,
                    on_device_became_available=_on_device_became_available,
                    always_on_microphone=self._config.audio.always_on_microphone,
                    lazy_stream_close=self._config.audio.lazy_stream_close,
                    lazy_close_timeout_seconds=self._config.audio.lazy_close_timeout_seconds,
                )
            else:
                audio_source = FileAudioSource(
                    sample_rate=SampleRate(self._config.audio.sample_rate),
                    buffer_size=BufferSize(self._config.audio.buffer_size),
                )

            # Build VAD
            from src.recorder.infrastructure.composite_vad import CompositeVAD
            from src.recorder.infrastructure.silero_vad import SileroVAD
            from src.recorder.infrastructure.webrtc_vad import WebRTCVAD

            webrtc = WebRTCVAD(
                sensitivity=self._config.vad.webrtc_sensitivity,
                sample_rate=self._config.audio.sample_rate,
            )
            # Pin Silero VAD to CPU regardless of the transcriber's device.
            # The Silero v5 ONNX graph has at least one node with no CUDA
            # kernel (the stateful LSTM tail), which makes ORT insert a
            # host↔device Memcpy and log:
            #   "1 Memcpy nodes are added to the graph spox_graph for
            #    CUDAExecutionProvider. It might have negative impact on
            #    performance (including unable to run CUDA graph)."
            # For a ~2 MB model running once per 32 ms hop, the PCIe round
            # trip costs more than the entire forward pass would on CPU,
            # so honoring ``device=cuda`` for VAD is a perf regression as
            # well as the source of the warning. The reference RealtimeSTT
            # monolith likewise runs Silero on CPU.
            silero = SileroVAD(
                sensitivity=self._config.vad.silero_sensitivity,
                use_onnx=self._config.vad.silero_use_onnx,
                sample_rate=self._config.audio.sample_rate,
                providers=["CPUExecutionProvider"],
            )
            vad = CompositeVAD(webrtc=webrtc, silero=silero)
            self._silero_vad = silero
            self._webrtc_vad = webrtc

            # Build transcribers via shared bootstrap builders
            dl_cbs = DownloadCallbacks(
                on_start=self._on_dl_start,
                on_progress=self._on_dl_progress,
                on_complete=self._on_dl_complete,
                on_cancelled=self._on_dl_cancelled,
                cancel_check=self._cancel_download_check,
            )
            # Build main transcriber first, then realtime. We tried
            # parallelizing these via ThreadPoolExecutor (saving ~1 s of cold
            # start when they're distinct models), but it caused the recorder
            # warmup to silently hang on real CUDA hardware — the renderer
            # then sees "Connecting" forever because ``Recorder initialized``
            # never prints. The root cause looks like ORT CUDA session-create
            # interleaving with the Silero VAD load on the same default
            # stream; the Python-side locks are clean but the C++ side races.
            # Reverted to serial until we have a reliable repro + fix.
            transcriber = build_transcriber(self._config.transcription.model, self._config, download_callbacks=dl_cbs)
            realtime_transcriber = None
            if self._config.realtime.enable_realtime_transcription:
                if self._config.realtime.use_main_model_for_realtime:
                    realtime_transcriber = transcriber
                else:
                    realtime_transcriber = build_realtime_transcriber(self._config, download_callbacks=dl_cbs)

            # Optional diarizer — only constructed when the feature flag is on,
            # so disabled users don't pay the ~32 MB first-use download. The
            # runtime toggle (RecorderService.request_diarization_toggle)
            # reuses ``build_diarizer`` to enable diarization later without a
            # restart, so any change to the construction args has exactly one
            # canonical site to update.
            diarizer: Any = None
            if self._config.diarization.enabled:
                from src.recorder.bootstrap import build_diarizer

                diarizer = build_diarizer(self._config.diarization)

            # Optional wake-word detector. The bootstrap registry maps every
            # accepted backend alias (pvp/pvporcupine/oww/openwakeword/...)
            # to a builder; pick one from the configured backend name and
            # construct under a try/except so a missing dependency or a
            # malformed config degrades to "no wake word" instead of
            # crashing the whole recorder. Pipeline gracefully handles
            # ``wake_word_detector=None`` by short-circuiting `_process_wake_word`.
            wake_word_detector: IWakeWordDetector | None = None
            backend_name = self._config.wake_word.wakeword_backend
            if backend_name:
                from src.recorder.bootstrap import WAKE_WORD_BACKENDS

                builder = WAKE_WORD_BACKENDS.get(backend_name)
                if builder is None:
                    logger.warning(
                        "wake_word: unknown backend %r — supported aliases: %s",
                        backend_name,
                        sorted(WAKE_WORD_BACKENDS),
                    )
                else:
                    try:
                        wake_word_detector = builder(self._config)
                    except Exception:
                        logger.exception(
                            "wake_word: failed to build %s detector — recorder will run"
                            " without wake-word detection (degrades to VAD-onset listening)",
                            backend_name,
                        )

            self._service = RecorderService(
                audio_source=audio_source,
                vad=vad,
                transcriber=transcriber,
                realtime_transcriber=realtime_transcriber,
                wake_word_detector=wake_word_detector,
                diarizer=diarizer,
                config=self._config,
                event_bus=self._event_bus,
                clock=self._clock,
            )

            # Wire model-swap download progress through the same callback
            # chain used for boot-time downloads. The renderer only needs
            # one subscription on the ``model_download_progress`` channel
            # — swaps and initial loads use the exact same event shape.
            self._service.set_swap_progress_sink(dl_cbs.make_progress_handler())

            # Cross-utterance adaptive Silero sensitivity. The calibrator
            # subscribes to recording lifecycle events on the same bus the
            # service uses, so wiring is just "construct and forget".
            from src.recorder.application.vad_calibrator import VADCalibrator

            silero_ref = silero
            self._vad_calibrator = VADCalibrator(
                event_bus=self._event_bus,
                clock=self._clock,
                get_sensitivity=lambda: silero_ref.sensitivity,
                set_sensitivity=lambda v: setattr(silero_ref, "sensitivity", v),
            )

            # Sync any microphone state changes made before initialization
            if self.use_microphone.value != self._config.audio.use_microphone:
                self._service.set_microphone(self.use_microphone.value)

            return self._service

    @classmethod
    def _create_with_service(
        cls,
        service: RecorderService,
        config: RecorderConfig,
    ) -> AudioToTextRecorder:
        """Internal factory for testing - creates facade with pre-built service."""
        instance = cls.__new__(cls)
        instance._config = config
        instance._callbacks = {}
        instance._on_dl_start = None
        instance._on_dl_progress = None
        instance._on_dl_complete = None
        instance._on_dl_cancelled = None
        instance._cancel_download_check = None
        instance._event_bus = EventBus()
        instance._clock = Clock.system_clock()
        instance._service = service
        instance._silero_vad = None
        instance._init_lock = threading.Lock()
        instance.use_microphone = _BoolFlag(config.audio.use_microphone)
        instance._sigint_reinstall = None
        return instance

    def construct(self) -> None:  # pragma: no cover
        """Eagerly build the recorder service without warming any kernels.

        Splitting construction from :meth:`warmup` lets the WS server
        install ``state.recorder`` *before* the (slow, CUDA-kernel-JIT)
        warmup runs — so even if warmup hangs or raises later, the
        renderer can dispatch ``set_microphone`` / ``text()`` to a real
        live recorder and merely pay the JIT cost on the first call,
        instead of silently soft-bricking with "Recorder does not have
        method set_microphone" (the failure mode that triggered the
        Option C architecture).

        Idempotent: subsequent calls hit ``_ensure_service``'s
        double-checked lock and return immediately.
        """
        self._ensure_service()

    def warmup(self) -> None:  # pragma: no cover
        """Eagerly load all models and warm up CUDA kernels."""
        self._ensure_service().warmup()

    def text(self, on_transcription_finished: TextCallback | None = None) -> str:
        return self._ensure_service().text(on_transcription_finished)

    def start(self) -> AudioToTextRecorder:
        self._ensure_service().start()
        return self

    def stop(
        self,
        backdate_stop_seconds: float = 0.0,
        backdate_resume_seconds: float = 0.0,
    ) -> AudioToTextRecorder:
        self._ensure_service().stop(
            backdate_stop_seconds=backdate_stop_seconds,
            backdate_resume_seconds=backdate_resume_seconds,
        )
        return self

    def listen(self) -> None:
        self._ensure_service().listen()

    def feed_audio(self, chunk: bytes | np.ndarray[Any, Any], original_sample_rate: int = 16000) -> None:
        self._ensure_service().feed_audio(chunk, original_sample_rate)

    def set_microphone(self, microphone_on: bool = True) -> None:
        """Toggle microphone on/off.

        Safe to call before the service is initialized - the state will
        be synced when the service is eventually built.  This avoids
        triggering heavy model loading from a keyboard-hook thread
        (which would cause Windows to remove the low-level hook).
        """
        self.use_microphone.value = microphone_on
        if self._service is not None:
            self._service.set_microphone(microphone_on)

    def clear_feed_buffer(self) -> None:  # pragma: no cover
        """Discard partial audio data buffered by ``feed_audio``.

        Call when stopping an external audio source (e.g. loopback) to
        prevent stale bytes from being fed on the next start.
        """
        if self._service is not None:
            self._service.clear_feed_buffer()

    def set_external_audio_mode(self, active: bool) -> None:  # pragma: no cover
        """Enable/disable external audio mode (e.g. loopback capture).

        When active, the mic reader thread drains but discards frames
        instead of injecting silence, preventing interference with
        externally fed audio.
        """
        if self._service is not None:
            self._service.set_external_audio_mode(active)

    @property
    def post_speech_silence_duration(self) -> float:
        return self._ensure_service().post_speech_silence_duration

    @post_speech_silence_duration.setter
    def post_speech_silence_duration(self, value: float) -> None:
        self._ensure_service().post_speech_silence_duration = value

    @property
    def silence_endpoint_enabled(self) -> bool:
        return self._ensure_service().silence_endpoint_enabled

    @silence_endpoint_enabled.setter
    def silence_endpoint_enabled(self, value: bool) -> None:
        self._ensure_service().silence_endpoint_enabled = value

    @property
    def frames(self) -> list[AudioChunk]:
        return self._ensure_service().frames

    @property
    def last_words_buffer(self) -> collections.deque[AudioChunk]:
        return self._ensure_service().last_words_buffer

    @property
    def language(self) -> str:
        return self._config.transcription.language

    @language.setter
    def language(self, value: str) -> None:
        self._config.transcription.language = value

    @property
    def model(self) -> str:
        return self._config.transcription.model

    @model.setter
    def model(self, value: str) -> None:
        if value == self._config.transcription.model:
            return
        old_model = self._config.transcription.model
        self._config.transcription.model = value
        if self._service is None:
            return

        service = self._service
        config = self._config
        swap_dl_cancelled = self._on_dl_cancelled
        swap_sigint_reinstall = self._sigint_reinstall

        def _swap() -> None:  # pragma: no cover
            try:
                from src.recorder.bootstrap import DownloadCallbacks, build_transcriber

                dl_cbs = DownloadCallbacks(
                    on_start=self._on_dl_start,
                    on_progress=self._on_dl_progress,
                    on_complete=self._on_dl_complete,
                    on_cancelled=self._on_dl_cancelled,
                    cancel_check=self._cancel_download_check,
                )
                new_transcriber = build_transcriber(value, config, download_callbacks=dl_cbs)
                service.swap_transcriber(new_transcriber)
                logger.info("Model swapped to %s", value)
                # CTranslate2 replaces the CRT SIGINT handler during model load.
                # Re-install our Python handler so Ctrl+C keeps working.
                if swap_sigint_reinstall is not None:
                    swap_sigint_reinstall()
            except Exception as exc:
                from src.recorder.domain.errors import DownloadCancelledError

                if isinstance(exc, DownloadCancelledError):
                    config.transcription.model = old_model
                    logger.info("Download cancelled for %s, reverted to %s", value, old_model)
                    if swap_dl_cancelled is not None:
                        swap_dl_cancelled(value)
                else:
                    logger.exception("Failed to swap model to %s", value)

        threading.Thread(target=_swap, daemon=True).start()

    @property
    def enable_realtime_transcription(self) -> bool:  # pragma: no cover
        return self._config.realtime.enable_realtime_transcription

    @property
    def initial_prompt(self) -> str | list[int] | None:
        """Whisper-style decode-bias prompt for the main transcriber.

        Read live from ``self._config.transcription.initial_prompt`` by
        :meth:`RecorderService._safe_transcribe` on every transcribe call,
        so a setter assignment takes effect on the NEXT utterance — no
        model rebuild needed. The renderer's
        ``installInitialPromptSync`` (electron/lib/initial-prompt-sync.ts)
        pushes a freshly-composed prompt on every dictionary or static-
        prefix edit via ``set_parameter("initial_prompt", ...)`` and the
        live transcriber picks it up immediately.
        """
        return self._config.transcription.initial_prompt

    @initial_prompt.setter
    def initial_prompt(self, value: str | list[int] | None) -> None:
        # Coerce empty string to None — server CLI passes "" for the
        # "no prompt" case (the renderer's IPC envelope always sends a
        # string), and we want config-equality to treat them as the same.
        normalized: str | list[int] | None
        if isinstance(value, str) and value == "":
            normalized = None
        elif isinstance(value, list):
            normalized = list(value)
        else:
            normalized = value
        self._config.transcription.initial_prompt = normalized

    @property
    def initial_prompt_realtime(self) -> str | list[int] | None:
        """Realtime-engine variant of :attr:`initial_prompt`.

        Persisted on :class:`RealtimeConfig`. Unlike the main prompt,
        the realtime worker bypasses ``use_prompt`` per
        :meth:`RecorderService._safe_transcribe`, so the value is only
        consumed at realtime-transcriber BUILD time. The setter
        therefore triggers an in-place realtime model reload when the
        realtime worker is wired and not slaved to main — the swap
        worker reads :attr:`RealtimeConfig.initial_prompt_realtime`
        from config when it rebuilds.
        """
        return self._config.realtime.initial_prompt_realtime

    @initial_prompt_realtime.setter
    def initial_prompt_realtime(self, value: str | list[int] | None) -> None:
        normalized: str | list[int] | None
        if isinstance(value, str) and value == "":
            normalized = None
        elif isinstance(value, list):
            normalized = list(value)
        else:
            normalized = value
        if normalized == self._config.realtime.initial_prompt_realtime:
            return
        self._config.realtime.initial_prompt_realtime = normalized
        self._maybe_reload_realtime_model("initial_prompt_realtime change")

    # ── Runtime-reconfigurable knobs (avoid full-process restart) ────────
    #
    # Each setter below mirrors a former STARTUP_ONLY_KEYS entry on the
    # Electron side. The pattern: update config first (so the value is
    # picked up by the swap worker / the next read), then trigger the
    # minimal in-place change (model reload, VAD set_mode, audio source
    # reconfigure, idle-unload-daemon retune). No process kill, no
    # WebSocket reconnect, no audio-stream re-open. See
    # ``frontend/electron/ipc/settings.ts`` for the renderer-side
    # counterpart that stopped including these keys in
    # ``STARTUP_ONLY_KEYS_LIST``.

    def _maybe_reload_main_model(self, reason: str) -> None:
        """Trigger an in-place main-model swap when the service is up.

        The swap worker re-reads ``self._config.transcription.*`` when
        it rebuilds the transcriber, so the new value (quantization,
        translate-to-english, etc.) takes effect without any extra
        plumbing through the swap RPC.
        """
        if self._service is None:
            return
        current = self._config.transcription.model
        if not current:
            return
        logger.info("Triggering main-model reload (%s)", reason)
        try:
            self._service.request_model_swap("main", current)
        except Exception:  # pragma: no cover — defensive
            logger.exception("request_model_swap('main', %r) failed", current)

    def _maybe_reload_realtime_model(self, reason: str) -> None:
        """Trigger an in-place realtime-model swap when eligible.

        Skipped silently when realtime is disabled or slaved to main
        (the slaved case picks up the new config on the next main
        swap). Without this guard, request_model_swap publishes a
        ``ModelSwapFailed`` toast even though the user only meant to
        change a config knob.
        """
        if self._service is None:
            return
        rt = self._config.realtime
        if not rt.enable_realtime_transcription:
            return
        if rt.use_main_model_for_realtime:
            return
        current = rt.realtime_model_type
        if not current:
            return
        logger.info("Triggering realtime-model reload (%s)", reason)
        try:
            self._service.request_model_swap("realtime", current)
        except Exception:  # pragma: no cover — defensive
            logger.exception("request_model_swap('realtime', %r) failed", current)

    @property
    def onnx_quantization(self) -> str:
        return self._config.transcription.onnx_quantization

    @onnx_quantization.setter
    def onnx_quantization(self, value: str) -> None:
        normalized = value or ""
        if normalized == self._config.transcription.onnx_quantization:
            return
        self._config.transcription.onnx_quantization = normalized
        # Quantization is resolved per-swap by
        # :meth:`RecorderService._load_transcriber` from the live config,
        # so both slots pick up the new value when reloaded. Realtime
        # is best-effort: when the user has it slaved to main the
        # ``_maybe_reload_realtime_model`` call is a no-op.
        self._maybe_reload_main_model(f"onnx_quantization → {normalized!r}")
        self._maybe_reload_realtime_model(f"onnx_quantization → {normalized!r}")

    @property
    def translate_to_english(self) -> bool:
        return self._config.transcription.translate_to_english

    @translate_to_english.setter
    def translate_to_english(self, value: bool) -> None:
        new_value = bool(value)
        if new_value == self._config.transcription.translate_to_english:
            return
        self._config.transcription.translate_to_english = new_value
        # ``_patch_translate_prompt`` is applied inside the
        # OnnxAsrTranscriber ctor, so a fresh transcriber must be built
        # for the toggle to take effect. The realtime worker does not
        # call translate, so we only swap the main slot.
        self._maybe_reload_main_model(f"translate_to_english → {new_value}")

    @property
    def model_unload_timeout_seconds(self) -> int | None:
        return self._config.transcription.model_unload_timeout_seconds

    @model_unload_timeout_seconds.setter
    def model_unload_timeout_seconds(self, value: int | None) -> None:
        # CLI uses -1 as the "Never" sentinel; normalize to None so the
        # daemon-state machine in RecorderService can use a single
        # truthiness check (``timeout is None or timeout <= 0``).
        normalized: int | None
        if value is None:
            normalized = None
        else:
            ivalue = int(value)
            normalized = None if ivalue < 0 else ivalue
        if normalized == self._config.transcription.model_unload_timeout_seconds:
            return
        self._config.transcription.model_unload_timeout_seconds = normalized
        if self._service is not None:
            self._service.set_unload_timeout_seconds(normalized)

    @property
    def webrtc_sensitivity(self) -> int:
        return self._config.vad.webrtc_sensitivity

    @webrtc_sensitivity.setter
    def webrtc_sensitivity(self, value: int) -> None:
        ivalue = max(0, min(3, int(value)))
        if ivalue == self._config.vad.webrtc_sensitivity:
            return
        self._config.vad.webrtc_sensitivity = ivalue
        if self._webrtc_vad is not None:
            self._webrtc_vad.set_sensitivity(ivalue)

    @property
    def silero_deactivity_detection(self) -> bool:
        return self._config.vad.silero_deactivity_detection

    @silero_deactivity_detection.setter
    def silero_deactivity_detection(self, value: bool) -> None:
        # Stored in config and threaded through the CLI for parity with
        # the Handy port, but no current consumer reads it at runtime —
        # the pipeline's ``_stop_recording_on_voice_deactivity`` is
        # session-state, not config. Kept as a settable property so a
        # future runtime consumer can read the live value without a
        # restart; today the assignment is intentionally a no-op
        # beyond persisting the new config value.
        self._config.vad.silero_deactivity_detection = bool(value)

    @property
    def always_on_microphone(self) -> bool:
        return self._config.audio.always_on_microphone

    @always_on_microphone.setter
    def always_on_microphone(self, value: bool) -> None:
        new_value = bool(value)
        if new_value == self._config.audio.always_on_microphone:
            return
        self._config.audio.always_on_microphone = new_value
        if self._service is not None:
            self._service.reconfigure_audio_source(always_on_microphone=new_value)

    @property
    def lazy_stream_close(self) -> bool:
        return self._config.audio.lazy_stream_close

    @lazy_stream_close.setter
    def lazy_stream_close(self, value: bool) -> None:
        new_value = bool(value)
        if new_value == self._config.audio.lazy_stream_close:
            return
        self._config.audio.lazy_stream_close = new_value
        if self._service is not None:
            self._service.reconfigure_audio_source(lazy_stream_close=new_value)

    @property
    def lazy_close_timeout_seconds(self) -> float:
        return self._config.audio.lazy_close_timeout_seconds

    @lazy_close_timeout_seconds.setter
    def lazy_close_timeout_seconds(self, value: float) -> None:
        new_value = float(value)
        if new_value == self._config.audio.lazy_close_timeout_seconds:
            return
        self._config.audio.lazy_close_timeout_seconds = new_value
        if self._service is not None:
            self._service.reconfigure_audio_source(lazy_close_timeout_seconds=new_value)

    @property
    def event_bus(self) -> EventBus:
        """Public handle on the facade's domain event bus.

        Exposed so the WS server (and unit-test harnesses) can subscribe to
        domain events emitted by the recorder — notably
        :class:`src.recorder.domain.events.TranscriptionCompleted` whose
        ``wav_path`` carries the just-written WAV file path. Direct
        infrastructure access is forbidden by the hexagonal rulebook, but
        the event bus itself is a building-blocks primitive (no domain
        knowledge), so reading it on the facade is the canonical hook for
        consumers that already live outside the recorder package.
        """
        return self._event_bus

    @property
    def input_device_index(self) -> int | None:
        return self._config.audio.input_device_index

    @input_device_index.setter
    def input_device_index(self, value: int | None) -> None:
        if value == self._config.audio.input_device_index:
            return
        # Update config first so an early-call from before the service is
        # built still takes effect on the next setup().
        self._config.audio.input_device_index = value
        if self._service is None:
            return
        # ``set_input_device`` just queues the swap on PyAudioSource (single
        # attribute write, applied by the audio reader thread on its next
        # iteration).  No blocking, no thread spawn needed — safe to call
        # directly from the asyncio control handler.
        self._service.set_input_device(value)

    @property
    def silero_sensitivity(self) -> float:
        return self._config.vad.silero_sensitivity

    @silero_sensitivity.setter
    def silero_sensitivity(self, value: float) -> None:
        self._config.vad.silero_sensitivity = value
        if self._silero_vad is not None:
            self._silero_vad.sensitivity = value

    @property
    def custom_words(self) -> list[str]:
        """The active deterministic-corrector word list.

        Mirrors :attr:`TextCorrectionConfig.custom_words` so the
        WebSocket control handler's ``set_parameter`` path can read and
        write the live list via the standard ``setattr(state.recorder, ...)``
        bridge. Returns a copy so callers can't mutate the live list
        through the property's reference (matches Pydantic's own list
        identity semantics).
        """
        return list(self._config.text_correction.custom_words)

    @custom_words.setter
    def custom_words(self, value: list[str]) -> None:
        # Defensive copy: the renderer hands us a JSON-decoded list whose
        # identity it may continue to mutate after the WebSocket frame
        # returns. Owning our own list avoids "the value changed without
        # going through the setter" races with the pipeline thread.
        self._config.text_correction.custom_words = list(value or [])

    @property
    def word_correction_threshold(self) -> float:
        """Maximum acceptable combined fuzzy score (0.0..1.0).

        Same wiring as :attr:`custom_words` — exposed for the
        ``set_parameter`` path so the threshold is tunable live without
        a recorder rebuild.
        """
        return self._config.text_correction.threshold

    @word_correction_threshold.setter
    def word_correction_threshold(self, value: float) -> None:
        self._config.text_correction.threshold = float(value)

    @property
    def filter_fillers(self) -> bool:
        """Locale-aware filler-word strip + stutter-collapse master switch.

        Mirrors :attr:`TextCorrectionConfig.filter_fillers`. Wired
        through the ``set_parameter`` WS path so the renderer can
        toggle the cleanup live without restarting the server.
        """
        return self._config.text_correction.filter_fillers

    @filter_fillers.setter
    def filter_fillers(self, value: bool) -> None:
        self._config.text_correction.filter_fillers = bool(value)

    @property
    def custom_filler_words(self) -> list[str]:
        """Optional per-user filler-word override list.

        Empty means "use the language-specific defaults from
        :data:`filler_filter.FILLERS_BY_LANG`". Same defensive-copy
        semantics as :attr:`custom_words`.
        """
        return list(self._config.text_correction.custom_filler_words)

    @custom_filler_words.setter
    def custom_filler_words(self, value: list[str]) -> None:
        self._config.text_correction.custom_filler_words = list(value or [])

    @property
    def wake_word_activation_delay(self) -> float:
        return self._ensure_service().wake_word_activation_delay

    @wake_word_activation_delay.setter
    def wake_word_activation_delay(self, value: float) -> None:
        self._ensure_service().wake_word_activation_delay = value

    def shutdown(self) -> None:
        if self._service is not None:
            self._service.shutdown()

    def abort(self) -> None:
        self._ensure_service().abort()

    def wait_audio(self) -> bool:
        return self._ensure_service().wait_audio()

    def wakeup(self) -> None:
        self._ensure_service().wakeup()

    def runtime_info(self) -> dict[str, Any]:
        """Snapshot of the live ORT runtime — see ``RecorderService.runtime_info``."""
        return self._ensure_service().runtime_info()

    def request_model_swap(self, kind: str, name: str) -> None:
        """Kick off a background model swap. See ``RecorderService.request_model_swap``.

        ``kind`` is ``"main"`` or ``"realtime"``. The current model keeps
        serving transcribe() calls until the new one is loaded, then the
        pointer is swapped atomically. Result is published as one of
        ``ModelSwapStarted`` / ``ModelSwapCompleted`` / ``ModelSwapFailed``.
        """
        self._ensure_service().request_model_swap(kind, name)

    def request_diarization_toggle(self, enabled: bool) -> None:
        """Kick off a background diarization on/off toggle.

        See ``RecorderService.request_diarization_toggle``. Returns
        immediately; the toggle runs on a daemon thread and publishes
        ``DiarizationToggleStarted`` then either ``DiarizationToggleCompleted``
        or ``DiarizationToggleFailed``. A no-op (target state already
        active) still emits Started → Completed so the renderer's
        spinner clears.
        """
        self._ensure_service().request_diarization_toggle(enabled)

    def clear_audio_queue(self) -> None:
        self._ensure_service().clear_audio_queue()

    def transcribe(self) -> str:
        return self._ensure_service().transcribe()

    def __enter__(self) -> AudioToTextRecorder:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.shutdown()
