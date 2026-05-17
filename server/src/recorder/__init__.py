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
from src.recorder.application.recorder_service import RecorderService
from src.recorder.domain.config import RecorderConfig

# Belt-and-suspenders: ensure ``device.py``'s module-level
# ``_inject_cuda_dlls()`` runs before any onnxruntime import anywhere in
# the process. ``SileroVAD`` also imports it for the same reason, but the
# facade is the public entry point — pulling it in here makes the
# guarantee independent of which infrastructure adapter happens to be
# constructed first.
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
        spinner: bool = True,
        level: int = logging.WARNING,
        batch_size: int = 16,
        # Realtime transcription parameters
        enable_realtime_transcription: bool = False,
        use_main_model_for_realtime: bool = False,
        realtime_model_type: str = "tiny",
        realtime_processing_pause: float = 0.2,
        init_realtime_after_seconds: float = 0.2,
        on_realtime_transcription_update: TextCallback | None = None,
        on_realtime_transcription_stabilized: TextCallback | None = None,
        realtime_batch_size: int = 16,
        # Voice activation parameters
        silero_sensitivity: float = 0.4,
        silero_use_onnx: bool = False,
        silero_deactivity_detection: bool = False,
        webrtc_sensitivity: int = 3,
        post_speech_silence_duration: float = 0.6,
        min_length_of_recording: float = 0.5,
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
        on_vad_sensitivity_adapted: Callable[[float, float, float], None] | None = None,
        #: Diarization callback — fires after each utterance when speaker
        #: segmentation is enabled. Receives the tuple of segments from
        #: :class:`SpeakerSegmentsDetected`. ``None`` (the default) leaves
        #: the callback unwired; the recorder still runs without it.
        on_speaker_segments_detected: Callable[[Any], None] | None = None,
        debug_mode: bool = False,
        handle_buffer_overflow: bool = True,
        beam_size: int = 5,
        beam_size_realtime: int = 3,
        buffer_size: int = 512,
        sample_rate: int = 16000,
        initial_prompt: str | Iterable[int] | None = None,
        initial_prompt_realtime: str | Iterable[int] | None = None,
        suppress_tokens: list[int] | None = None,
        print_transcription_time: bool = False,
        early_transcription_on_silence: float = 0,
        allowed_latency_limit: int = 100,
        no_log_file: bool = False,
        use_extended_logging: bool = False,
        faster_whisper_vad_filter: bool = True,
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
        # Diarization — see :class:`DiarizationConfig`. Off by default; first
        # ``enable_diarization=True`` build downloads ~32 MB of ONNX models.
        enable_diarization: bool = False,
        diarization_max_speakers: int = 8,
    ) -> None:
        if suppress_tokens is None:
            suppress_tokens = [-1]

        # Build config from all kwargs
        self._config = RecorderConfig.from_kwargs(
            # Audio
            input_device_index=input_device_index,
            sample_rate=sample_rate,
            buffer_size=buffer_size,
            use_microphone=use_microphone,
            handle_buffer_overflow=handle_buffer_overflow,
            # VAD
            silero_sensitivity=silero_sensitivity,
            silero_use_onnx=silero_use_onnx,
            silero_deactivity_detection=silero_deactivity_detection,
            webrtc_sensitivity=webrtc_sensitivity,
            post_speech_silence_duration=post_speech_silence_duration,
            min_length_of_recording=min_length_of_recording,
            min_gap_between_recordings=min_gap_between_recordings,
            pre_recording_buffer_duration=pre_recording_buffer_duration,
            # Transcription
            model=model,
            download_root=download_root,
            language=language,
            compute_type=compute_type,
            gpu_device_index=gpu_device_index,
            device=device,
            beam_size=beam_size,
            initial_prompt=initial_prompt,
            suppress_tokens=suppress_tokens,
            batch_size=batch_size,
            faster_whisper_vad_filter=faster_whisper_vad_filter,
            normalize_audio=normalize_audio,
            print_transcription_time=print_transcription_time,
            early_transcription_on_silence=early_transcription_on_silence,
            allowed_latency_limit=allowed_latency_limit,
            backend=backend,
            onnx_quantization=onnx_quantization,
            # Realtime
            enable_realtime_transcription=enable_realtime_transcription,
            use_main_model_for_realtime=use_main_model_for_realtime,
            realtime_model_type=realtime_model_type,
            realtime_processing_pause=realtime_processing_pause,
            init_realtime_after_seconds=init_realtime_after_seconds,
            beam_size_realtime=beam_size_realtime,
            realtime_batch_size=realtime_batch_size,
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

            # Build transcribers via shared bootstrap builders
            dl_cbs = DownloadCallbacks(
                on_start=self._on_dl_start,
                on_progress=self._on_dl_progress,
                on_complete=self._on_dl_complete,
                on_cancelled=self._on_dl_cancelled,
                cancel_check=self._cancel_download_check,
            )
            transcriber = build_transcriber(self._config.transcription.model, self._config, download_callbacks=dl_cbs)

            realtime_transcriber = None
            if self._config.realtime.enable_realtime_transcription:
                if self._config.realtime.use_main_model_for_realtime:
                    realtime_transcriber = transcriber
                else:
                    realtime_transcriber = build_realtime_transcriber(self._config, download_callbacks=dl_cbs)

            # Optional diarizer — only constructed when the feature flag is on,
            # so disabled users don't pay the ~32 MB first-use download.
            diarizer: Any = None
            if self._config.diarization.enabled:
                from src.recorder.infrastructure.onnxasr_diarizer import OnnxAsrDiarizer

                diarizer = OnnxAsrDiarizer(
                    max_speakers=self._config.diarization.max_speakers,
                    delta_new=self._config.diarization.delta_new,
                    rho_update=self._config.diarization.rho_update,
                    segmentation_model=self._config.diarization.segmentation_model,
                    embedding_model=self._config.diarization.embedding_model,
                )

            self._service = RecorderService(
                audio_source=audio_source,
                vad=vad,
                transcriber=transcriber,
                realtime_transcriber=realtime_transcriber,
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
