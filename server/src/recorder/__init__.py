"""Recorder module - exports the backward-compatible AudioToTextRecorder facade."""

from __future__ import annotations

import collections
import logging
import threading
from collections.abc import Callable, Iterable
from types import TracebackType
from typing import TYPE_CHECKING, Any, cast

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
from src.recorder.infrastructure.file_source import FileAudioSource

logger = logging.getLogger(__name__)

# Re-export for convenience
__all__ = ["AudioToTextRecorder", "AudioToTextRecorderClient"]


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
        normalize_audio: bool = False,
        start_callback_in_new_thread: bool = False,
        # Model download callbacks
        on_model_download_start: Callable[[str], None] | None = None,
        on_model_download_progress: Callable[[DownloadProgress], None] | None = None,
        on_model_download_complete: Callable[[str], None] | None = None,
        # Download cancellation check
        cancel_download_check: Callable[[], bool] | None = None,
        # Backend selection
        backend: str = "",
        onnx_quantization: str = "",
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
        )

        # Collect callbacks
        self._callbacks: CallbackMap = {
            "on_recording_start": on_recording_start,
            "on_recording_stop": on_recording_stop,
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
        }

        # Download progress callbacks (typed separately — they accept model name / progress args)
        self._on_dl_start = on_model_download_start
        self._on_dl_progress = on_model_download_progress
        self._on_dl_complete = on_model_download_complete
        self._cancel_download_check = cancel_download_check

        # Build service with fakes for testing or real adapters via bootstrap
        self._event_bus = EventBus()
        self._clock = Clock.system_clock()
        self._service: RecorderService | None = None
        self._silero_vad: Any = None  # Live SileroVAD reference for runtime sensitivity updates
        self._init_lock = threading.Lock()
        self.use_microphone = _BoolFlag(use_microphone)

    def _ensure_service(self) -> RecorderService:  # pragma: no cover
        if self._service is not None:
            return self._service
        with self._init_lock:
            # Double-check after acquiring lock
            if self._service is not None:
                return self._service
            from src.recorder.bootstrap import (
                CALLBACK_EVENT_MAP,
                wire_callback,
                wire_callback_with_audio,
                wire_callback_with_level,
                wire_callback_with_text,
            )
            from src.recorder.domain.events import (
                AudioLevelComputed,
                RealtimeTranscriptionStabilized,
                RealtimeTranscriptionUpdate,
                TranscriptionStarted,
            )

            # Wire callbacks
            for cb_name, cb_func in self._callbacks.items():
                if cb_func is None:
                    continue
                event_type = CALLBACK_EVENT_MAP.get(cb_name)
                if event_type is None:
                    continue
                if event_type in {RealtimeTranscriptionUpdate, RealtimeTranscriptionStabilized}:
                    wire_callback_with_text(self._event_bus, event_type, cast(TextCallback, cb_func))
                elif event_type is TranscriptionStarted:
                    wire_callback_with_audio(self._event_bus, event_type, cast(SimpleCallback, cb_func))
                elif event_type is AudioLevelComputed:
                    wire_callback_with_level(self._event_bus, event_type, cast(LevelCallback, cb_func))
                else:
                    wire_callback(self._event_bus, event_type, cast(SimpleCallback, cb_func))

            # Build lightweight components for facade (no hardware init until needed)
            from src.recorder.domain.ports.audio_source import IAudioSource
            from src.recorder.domain.ports.transcriber import ITranscriber
            from src.recorder.domain.ports.vad import IVoiceActivityDetector

            audio_source: IAudioSource
            if self._config.audio.use_microphone:
                from src.recorder.infrastructure.pyaudio_source import PyAudioSource

                audio_source = PyAudioSource(
                    input_device_index=self._config.audio.input_device_index,
                    target_sample_rate=SampleRate(self._config.audio.sample_rate),
                    buffer_size=BufferSize(self._config.audio.buffer_size),
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

            webrtc: IVoiceActivityDetector = WebRTCVAD(
                sensitivity=self._config.vad.webrtc_sensitivity,
                sample_rate=self._config.audio.sample_rate,
            )
            silero: IVoiceActivityDetector = SileroVAD(
                sensitivity=self._config.vad.silero_sensitivity,
                use_onnx=self._config.vad.silero_use_onnx,
                sample_rate=self._config.audio.sample_rate,
            )
            vad: IVoiceActivityDetector = CompositeVAD(webrtc=webrtc, silero=silero)
            self._silero_vad = silero

            # Build download progress callback
            dl_start = self._on_dl_start
            dl_progress = self._on_dl_progress
            dl_complete = self._on_dl_complete

            def _on_download_progress(info: DownloadProgress) -> None:
                if info.progress == 0.0 and dl_start is not None:
                    dl_start(info.model)
                if dl_progress is not None:
                    dl_progress(info)
                if info.progress >= 1.0 and dl_complete is not None:
                    dl_complete(info.model)

            has_dl_cb = dl_start is not None or dl_progress is not None or dl_complete is not None

            # Build transcriber — route by backend
            from src.recorder.domain.model_registry import ModelCatalog, TranscriberBackend

            catalog = ModelCatalog()
            _backend_cfg = self._config.transcription.backend
            if _backend_cfg == TranscriberBackend.ONNX_ASR.value:
                _resolved = TranscriberBackend.ONNX_ASR
            elif _backend_cfg:
                _resolved = TranscriberBackend.FASTER_WHISPER
            else:
                _resolved = catalog.get_backend(self._config.transcription.model)

            transcriber: ITranscriber
            if _resolved == TranscriberBackend.ONNX_ASR:
                from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

                _info = catalog.get(self._config.transcription.model)
                _onnx_name = (
                    _info.onnx_model_name
                    if _info and _info.onnx_model_name
                    else self._config.transcription.model
                )
                _quant = self._config.transcription.onnx_quantization or None
                transcriber = OnnxAsrTranscriber(
                    model_name=_onnx_name,
                    quantization=_quant,
                    on_download_progress=_on_download_progress if has_dl_cb else None,
                )
            else:
                from src.recorder.infrastructure.whisper_transcriber import WhisperTranscriber

                transcriber = WhisperTranscriber(
                    model_path=self._config.transcription.model,
                    device=self._config.transcription.device,
                    compute_type=self._config.transcription.compute_type,
                    gpu_device_index=self._config.transcription.gpu_device_index,
                    download_root=self._config.transcription.download_root,
                    beam_size=self._config.transcription.beam_size,
                    initial_prompt=self._config.transcription.initial_prompt,
                    suppress_tokens=self._config.transcription.suppress_tokens,
                    batch_size=self._config.transcription.batch_size,
                    vad_filter=self._config.transcription.faster_whisper_vad_filter,
                    normalize_audio=self._config.transcription.normalize_audio,
                    on_download_progress=_on_download_progress if has_dl_cb else None,
                    cancel_check=self._cancel_download_check,
                )

            # Build realtime transcriber
            realtime_transcriber: ITranscriber | None = None
            if self._config.realtime.enable_realtime_transcription:
                if self._config.realtime.use_main_model_for_realtime:
                    realtime_transcriber = transcriber
                else:
                    _rt_backend = catalog.get_backend(self._config.realtime.realtime_model_type)
                    if _rt_backend == TranscriberBackend.ONNX_ASR:
                        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber as _OAT

                        _rt_info = catalog.get(self._config.realtime.realtime_model_type)
                        _rt_name = (
                            _rt_info.onnx_model_name
                            if _rt_info and _rt_info.onnx_model_name
                            else self._config.realtime.realtime_model_type
                        )
                        _rt_quant = self._config.transcription.onnx_quantization or None
                        realtime_transcriber = _OAT(
                            model_name=_rt_name,
                            quantization=_rt_quant,
                            on_download_progress=_on_download_progress if has_dl_cb else None,
                        )
                    else:
                        from src.recorder.infrastructure.realtime_transcriber import RealtimeTranscriber

                        realtime_transcriber = RealtimeTranscriber(
                            model_path=self._config.realtime.realtime_model_type,
                            device=self._config.transcription.device,
                            compute_type=self._config.transcription.compute_type,
                            gpu_device_index=self._config.transcription.gpu_device_index,
                            download_root=self._config.transcription.download_root,
                            beam_size=self._config.realtime.beam_size_realtime,
                            initial_prompt=self._config.realtime.initial_prompt_realtime,
                            batch_size=self._config.realtime.realtime_batch_size,
                            on_download_progress=_on_download_progress if has_dl_cb else None,
                        )

            self._service = RecorderService(
                audio_source=audio_source,
                vad=vad,
                transcriber=transcriber,
                realtime_transcriber=realtime_transcriber,
                config=self._config,
                event_bus=self._event_bus,
                clock=self._clock,
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
        instance._cancel_download_check = None
        instance._event_bus = EventBus()
        instance._clock = Clock.system_clock()
        instance._service = service
        instance._silero_vad = None
        instance._init_lock = threading.Lock()
        instance.use_microphone = _BoolFlag(config.audio.use_microphone)
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

    def clear_feed_buffer(self) -> None:
        """Discard partial audio data buffered by ``feed_audio``.

        Call when stopping an external audio source (e.g. loopback) to
        prevent stale bytes from being fed on the next start.
        """
        if self._service is not None:
            self._service.clear_feed_buffer()

    def set_external_audio_mode(self, active: bool) -> None:
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
        self._config.transcription.model = value
        if self._service is None:
            return

        service = self._service
        config = self._config

        swap_dl_start = self._on_dl_start
        swap_dl_progress = self._on_dl_progress
        swap_dl_complete = self._on_dl_complete
        swap_cancel_check = self._cancel_download_check

        def _swap() -> None:  # pragma: no cover
            try:
                from src.recorder.domain.model_registry import ModelCatalog, TranscriberBackend
                from src.recorder.domain.ports.transcriber import ITranscriber as _ITranscriber

                swap_catalog = ModelCatalog()
                _swap_backend_cfg = config.transcription.backend
                if _swap_backend_cfg == TranscriberBackend.ONNX_ASR.value:
                    _swap_resolved = TranscriberBackend.ONNX_ASR
                elif _swap_backend_cfg:
                    _swap_resolved = TranscriberBackend.FASTER_WHISPER
                else:
                    _swap_resolved = swap_catalog.get_backend(value)

                new_transcriber: _ITranscriber
                if _swap_resolved == TranscriberBackend.ONNX_ASR:
                    from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

                    _swap_info = swap_catalog.get(value)
                    _swap_name = _swap_info.onnx_model_name if _swap_info and _swap_info.onnx_model_name else value
                    _swap_quant = config.transcription.onnx_quantization or None
                    new_transcriber = OnnxAsrTranscriber(model_name=_swap_name, quantization=_swap_quant)
                else:
                    from src.recorder.infrastructure.whisper_transcriber import WhisperTranscriber

                    def _swap_on_progress(info: DownloadProgress) -> None:  # pragma: no cover
                        if info.progress == 0.0 and swap_dl_start is not None:
                            swap_dl_start(info.model)
                        if swap_dl_progress is not None:
                            swap_dl_progress(info)
                        if info.progress >= 1.0 and swap_dl_complete is not None:
                            swap_dl_complete(info.model)

                    has_swap_cb = (
                        swap_dl_start is not None or swap_dl_progress is not None or swap_dl_complete is not None
                    )

                    new_transcriber = WhisperTranscriber(
                        model_path=value,
                        device=config.transcription.device,
                        compute_type=config.transcription.compute_type,
                        gpu_device_index=config.transcription.gpu_device_index,
                        download_root=config.transcription.download_root,
                        beam_size=config.transcription.beam_size,
                        initial_prompt=config.transcription.initial_prompt,
                        suppress_tokens=config.transcription.suppress_tokens,
                        batch_size=config.transcription.batch_size,
                        vad_filter=config.transcription.faster_whisper_vad_filter,
                        normalize_audio=config.transcription.normalize_audio,
                        on_download_progress=_swap_on_progress if has_swap_cb else None,
                        cancel_check=swap_cancel_check,
                    )
                service.swap_transcriber(new_transcriber)
                logger.info("Model swapped to %s", value)
            except Exception:
                logger.exception("Failed to swap model to %s", value)

        threading.Thread(target=_swap, daemon=True).start()

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


def __getattr__(name: str) -> Any:  # pragma: no cover  # noqa: ANN401
    if name == "AudioToTextRecorderClient":
        from src.recorder.client import AudioToTextRecorderClient

        return AudioToTextRecorderClient
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
