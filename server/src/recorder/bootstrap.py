from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, cast

import numpy as np
from kink import di

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.building_blocks.types import CallbackMap, LevelCallback, SimpleCallback, TextCallback
from src.recorder.application.recorder_service import RecorderService
from src.recorder.domain.config import RecorderConfig
from src.recorder.domain.events import (
    AudioChunkRecorded,
    AudioLevelComputed,
    DeviceSwitchFailed,
    DownloadProgress,
    NoAudioDetected,
    RealtimeTranscriptionStabilized,
    RealtimeTranscriptionUpdate,
    RecordingStarted,
    RecordingStopped,
    TranscriptionStarted,
    TurnDetectionStarted,
    TurnDetectionStopped,
    VADDetectStarted,
    VADDetectStopped,
    VADStarted,
    VADStopped,
    WakeWordDetected,
    WakeWordDetectionEnded,
    WakeWordDetectionStarted,
    WakeWordTimeout,
)
from src.recorder.domain.ports.audio_source import IAudioSource
from src.recorder.domain.ports.transcriber import ITranscriber
from src.recorder.domain.ports.vad import IVoiceActivityDetector
from src.recorder.domain.ports.wake_word import IWakeWordDetector
from src.recorder.infrastructure.file_source import FileAudioSource

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DownloadCallbacks:
    """Encapsulates model download lifecycle callbacks."""

    on_start: Callable[[str], None] | None = None
    on_progress: Callable[[DownloadProgress], None] | None = None
    on_complete: Callable[[str], None] | None = None
    on_cancelled: Callable[[str], None] | None = None
    cancel_check: Callable[[], bool] | None = None

    def make_progress_handler(self) -> Callable[[DownloadProgress], None] | None:
        """Build a unified closure that coalesces start/progress/complete, or None if no callbacks."""
        if self.on_start is None and self.on_progress is None and self.on_complete is None:
            return None
        dl_start = self.on_start
        dl_progress = self.on_progress
        dl_complete = self.on_complete

        def _handler(info: DownloadProgress) -> None:
            if info.progress == 0.0 and dl_start is not None:
                dl_start(info.model)
            if dl_progress is not None:
                dl_progress(info)
            if info.progress >= 1.0 and dl_complete is not None:
                dl_complete(info.model)

        return _handler


# Callback name -> event type mapping for the bridge
CALLBACK_EVENT_MAP: dict[str, type] = {
    "on_recording_start": RecordingStarted,
    "on_recording_stop": RecordingStopped,
    "on_no_audio_detected": NoAudioDetected,
    "on_transcription_start": TranscriptionStarted,
    "on_vad_start": VADStarted,
    "on_vad_stop": VADStopped,
    "on_vad_detect_start": VADDetectStarted,
    "on_vad_detect_stop": VADDetectStopped,
    "on_turn_detection_start": TurnDetectionStarted,
    "on_turn_detection_stop": TurnDetectionStopped,
    "on_wakeword_detected": WakeWordDetected,
    "on_wakeword_timeout": WakeWordTimeout,
    "on_wakeword_detection_start": WakeWordDetectionStarted,
    "on_wakeword_detection_end": WakeWordDetectionEnded,
    "on_recorded_chunk": AudioChunkRecorded,
    "on_realtime_transcription_update": RealtimeTranscriptionUpdate,
    "on_realtime_transcription_stabilized": RealtimeTranscriptionStabilized,
    "on_audio_level": AudioLevelComputed,
    "on_device_switch_failed": DeviceSwitchFailed,
}


def wire_callback(event_bus: EventBus, event_type: type, callback: SimpleCallback) -> None:
    """Wire a legacy callback to the event bus."""
    event_bus.subscribe(event_type, lambda _event: callback())


def wire_callback_with_text(event_bus: EventBus, event_type: type, callback: TextCallback) -> None:
    """Wire a legacy callback that receives text argument."""

    def _handler(event: object) -> None:
        callback(cast(RealtimeTranscriptionUpdate, event).text)

    event_bus.subscribe(event_type, _handler)


def wire_callback_with_level(event_bus: EventBus, event_type: type, callback: LevelCallback) -> None:
    """Wire a legacy callback that receives a float level argument."""

    def _handler(event: object) -> None:
        callback(cast(AudioLevelComputed, event).level)

    event_bus.subscribe(event_type, _handler)


def wire_callback_with_audio(event_bus: EventBus, event_type: type, callback: SimpleCallback) -> None:
    """Wire the on_transcription_start callback that receives audio bytes."""

    def _handler(event: object) -> None:
        audio_bytes = cast(TranscriptionStarted, event).audio
        audio_ndarray: np.ndarray[Any, np.dtype[np.int16]] = np.frombuffer(audio_bytes, dtype=np.int16)
        cast(Any, callback)(audio_ndarray)

    event_bus.subscribe(event_type, _handler)


def wire_callback_with_device_switch(
    event_bus: EventBus,
    event_type: type,
    callback: Callable[[int, str, int | None], None],
) -> None:
    """Wire the on_device_switch_failed callback (3 args: requested, error, fallback)."""

    def _handler(event: object) -> None:
        e = cast(DeviceSwitchFailed, event)
        callback(e.requested_index, e.error_message, e.fallback_index)

    event_bus.subscribe(event_type, _handler)


def wire_all_callbacks(event_bus: EventBus, callbacks: CallbackMap) -> None:
    """Bridge every legacy callback in ``callbacks`` to its matching domain event."""
    for cb_name, cb_func in callbacks.items():
        if cb_func is None:
            continue
        event_type = CALLBACK_EVENT_MAP.get(cb_name)
        if event_type is None:
            continue
        if event_type in {RealtimeTranscriptionUpdate, RealtimeTranscriptionStabilized}:
            wire_callback_with_text(event_bus, event_type, cast(TextCallback, cb_func))
        elif event_type is TranscriptionStarted:
            wire_callback_with_audio(event_bus, event_type, cast(SimpleCallback, cb_func))
        elif event_type is AudioLevelComputed:
            wire_callback_with_level(event_bus, event_type, cast(LevelCallback, cb_func))
        elif event_type is DeviceSwitchFailed:
            wire_callback_with_device_switch(
                event_bus,
                event_type,
                cast(Callable[[int, str, int | None], None], cb_func),
            )
        else:
            wire_callback(event_bus, event_type, cast(SimpleCallback, cb_func))


def build_transcriber(
    model_name: str,
    config: RecorderConfig,
    *,
    download_callbacks: DownloadCallbacks | None = None,
) -> ITranscriber:
    """Build the transcriber. After the torch-drop refactor (Track B step 1),
    only the onnx-asr backend is supported — the catalog's backend marker is
    consulted for the resolved onnx model name but the construction path is
    uniform.
    """
    from src.recorder.domain.model_registry import ModelCatalog

    progress_handler = download_callbacks.make_progress_handler() if download_callbacks else None

    catalog = ModelCatalog()
    info = catalog.get(model_name)
    onnx_name = info.onnx_model_name if info and info.onnx_model_name else model_name
    quantization = config.transcription.onnx_quantization or None

    from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

    return OnnxAsrTranscriber(
        model_name=onnx_name,
        quantization=quantization,
        on_download_progress=progress_handler,
    )


def build_realtime_transcriber(
    config: RecorderConfig,
    *,
    download_callbacks: DownloadCallbacks | None = None,
) -> ITranscriber:
    """Build the realtime transcriber. Onnx-asr-only after Track B step 1."""
    from src.recorder.domain.model_registry import ModelCatalog

    progress_handler = download_callbacks.make_progress_handler() if download_callbacks else None

    model_name = config.realtime.realtime_model_type
    catalog = ModelCatalog()
    info = catalog.get(model_name)
    onnx_name = info.onnx_model_name if info and info.onnx_model_name else model_name
    quantization = config.transcription.onnx_quantization or None

    from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

    return OnnxAsrTranscriber(
        model_name=onnx_name,
        quantization=quantization,
        on_download_progress=progress_handler,
    )


def bootstrap_di(
    config: RecorderConfig,
    callbacks: CallbackMap | None = None,
    *,
    download_callbacks: DownloadCallbacks | None = None,
) -> RecorderService:
    """Wire all ports to adapters and create RecorderService."""
    event_bus = EventBus()
    clock = Clock.system_clock()

    if callbacks:
        wire_all_callbacks(event_bus, callbacks)

    # Build audio source
    audio_source: IAudioSource
    if config.audio.use_microphone:
        from src.building_blocks.types import BufferSize, SampleRate
        from src.recorder.infrastructure.pyaudio_source import PyAudioSource

        # Bridge the audio reader thread's switch-failed hook into the event
        # bus so the WS server (and through it, the renderer) can react —
        # surface the failure as a toast and revert the user's selection
        # instead of leaving them with a silently-fallen-back stream.
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

        audio_source = PyAudioSource(
            input_device_index=config.audio.input_device_index,
            target_sample_rate=SampleRate(config.audio.sample_rate),
            buffer_size=BufferSize(config.audio.buffer_size),
            on_device_switch_failed=_on_device_switch_failed,
        )
    else:
        from src.building_blocks.types import BufferSize, SampleRate

        audio_source = FileAudioSource(
            sample_rate=SampleRate(config.audio.sample_rate),
            buffer_size=BufferSize(config.audio.buffer_size),
        )

    # Build VAD
    vad: IVoiceActivityDetector
    from src.recorder.infrastructure.composite_vad import CompositeVAD
    from src.recorder.infrastructure.silero_vad import SileroVAD
    from src.recorder.infrastructure.webrtc_vad import WebRTCVAD

    webrtc = WebRTCVAD(
        sensitivity=config.vad.webrtc_sensitivity,
        sample_rate=config.audio.sample_rate,
    )
    silero = SileroVAD(
        sensitivity=config.vad.silero_sensitivity,
        use_onnx=config.vad.silero_use_onnx,
        sample_rate=config.audio.sample_rate,
    )
    vad = CompositeVAD(webrtc=webrtc, silero=silero)

    # Build transcriber
    transcriber: ITranscriber = build_transcriber(
        config.transcription.model, config, download_callbacks=download_callbacks
    )

    # Build realtime transcriber
    realtime_transcriber: ITranscriber | None = None
    if config.realtime.enable_realtime_transcription:
        if config.realtime.use_main_model_for_realtime:
            realtime_transcriber = transcriber
        else:
            realtime_transcriber = build_realtime_transcriber(config, download_callbacks=download_callbacks)

    # Build wake word detector
    wake_word_detector: IWakeWordDetector | None = None
    if config.wake_word.wakeword_backend in {"pvp", "pvporcupine"}:
        from src.recorder.infrastructure.porcupine_detector import PorcupineDetector

        words = [w.strip() for w in config.wake_word.wake_words.split(",") if w.strip()]
        wake_word_detector = PorcupineDetector(
            access_key="",  # Must be provided by user
            wake_words=words,
            sensitivities=[config.wake_word.wake_words_sensitivity] * len(words),
            buffer_size=config.audio.buffer_size,
        )
    elif config.wake_word.wakeword_backend in {"oww", "openwakeword", "openwakewords"}:
        from src.recorder.infrastructure.oww_detector import OWWDetector

        model_paths = (
            [p.strip() for p in config.wake_word.openwakeword_model_paths.split(",")]
            if config.wake_word.openwakeword_model_paths
            else None
        )
        wake_word_detector = OWWDetector(
            model_paths=model_paths,
            inference_framework=config.wake_word.openwakeword_inference_framework,
            sensitivity=config.wake_word.wake_words_sensitivity,
        )

    # Register in DI container
    di[EventBus] = event_bus
    di[Clock] = clock
    di[IAudioSource] = audio_source
    di[IVoiceActivityDetector] = vad
    di[ITranscriber] = transcriber

    # Build and register service
    service = RecorderService(
        audio_source=audio_source,
        vad=vad,
        transcriber=transcriber,
        wake_word_detector=wake_word_detector,
        realtime_transcriber=realtime_transcriber,
        config=config,
        event_bus=event_bus,
        clock=clock,
    )
    di[RecorderService] = service

    return service
