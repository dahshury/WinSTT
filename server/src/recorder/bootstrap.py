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
    DeviceBecameAvailable,
    DeviceSwitchFailed,
    DownloadProgress,
    ModelSwapCompleted,
    ModelSwapFailed,
    ModelSwapStarted,
    NoAudioDetected,
    RealtimeTranscriptionStabilized,
    RealtimeTranscriptionUpdate,
    RecorderEvent,
    RecordingStarted,
    RecordingStopped,
    SpeakerSegmentsDetected,
    TranscriptionStarted,
    TurnDetectionStarted,
    TurnDetectionStopped,
    VADDetectStarted,
    VADDetectStopped,
    VADSensitivityAdapted,
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
CALLBACK_EVENT_MAP: dict[str, type[RecorderEvent]] = {
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
    "on_device_became_available": DeviceBecameAvailable,
    "on_model_swap_started": ModelSwapStarted,
    "on_model_swap_completed": ModelSwapCompleted,
    "on_model_swap_failed": ModelSwapFailed,
    "on_vad_sensitivity_adapted": VADSensitivityAdapted,
    "on_speaker_segments_detected": SpeakerSegmentsDetected,
}


def wire_callback(event_bus: EventBus, event_type: type[RecorderEvent], callback: SimpleCallback) -> None:
    """Wire a legacy callback to the event bus."""
    event_bus.subscribe(event_type, lambda _event: callback())


def wire_callback_with_text(event_bus: EventBus, event_type: type[RecorderEvent], callback: TextCallback) -> None:
    """Wire a legacy callback that receives text argument."""

    def _handler(event: object) -> None:
        callback(cast(RealtimeTranscriptionUpdate, event).text)

    event_bus.subscribe(event_type, _handler)


def wire_callback_with_level(event_bus: EventBus, event_type: type[RecorderEvent], callback: LevelCallback) -> None:
    """Wire a legacy callback that receives a float level argument."""

    def _handler(event: object) -> None:
        callback(cast(AudioLevelComputed, event).level)

    event_bus.subscribe(event_type, _handler)


def wire_callback_with_audio(event_bus: EventBus, event_type: type[RecorderEvent], callback: SimpleCallback) -> None:
    """Wire the on_transcription_start callback that receives audio bytes."""

    def _handler(event: object) -> None:
        audio_bytes = cast(TranscriptionStarted, event).audio
        audio_ndarray: np.ndarray[Any, np.dtype[np.int16]] = np.frombuffer(audio_bytes, dtype=np.int16)
        cast(Any, callback)(audio_ndarray)

    event_bus.subscribe(event_type, _handler)


def wire_callback_with_device_switch(
    event_bus: EventBus,
    event_type: type[RecorderEvent],
    callback: Callable[[int, str, int | None], None],
) -> None:
    """Wire the on_device_switch_failed callback (3 args: requested, error, fallback)."""

    def _handler(event: object) -> None:
        e = cast(DeviceSwitchFailed, event)
        callback(e.requested_index, e.error_message, e.fallback_index)

    event_bus.subscribe(event_type, _handler)


def wire_callback_with_device_index(
    event_bus: EventBus,
    event_type: type[RecorderEvent],
    callback: Callable[[int], None],
) -> None:
    """Wire the on_device_became_available callback (1 arg: device_index)."""

    def _handler(event: object) -> None:
        callback(cast(DeviceBecameAvailable, event).device_index)

    event_bus.subscribe(event_type, _handler)


def wire_callback_with_model_swap(
    event_bus: EventBus,
    event_type: type[RecorderEvent],
    callback: Callable[[str, str], None],
) -> None:
    """Wire ModelSwapStarted / ModelSwapCompleted callbacks (kind, name)."""

    def _handler(event: object) -> None:
        e = cast(ModelSwapStarted, event)  # same shape as ModelSwapCompleted
        callback(e.kind, e.name)

    event_bus.subscribe(event_type, _handler)


def wire_callback_with_model_swap_failed(
    event_bus: EventBus,
    event_type: type[RecorderEvent],
    callback: Callable[[str, str, str, str, str], None],
) -> None:
    """Wire ModelSwapFailed callback (kind, name, reason, category, detail).

    ``reason`` is the human-readable headline, ``category`` is the
    stable enum code the renderer keys off, and ``detail`` is the
    technical exception text for support diagnostics.
    """

    def _handler(event: object) -> None:
        e = cast(ModelSwapFailed, event)
        callback(e.kind, e.name, e.reason, e.category, e.detail)

    event_bus.subscribe(event_type, _handler)


def wire_callback_with_vad_sensitivity(
    event_bus: EventBus,
    event_type: type[RecorderEvent],
    callback: Callable[[float, float, float], None],
) -> None:
    """Wire VADSensitivityAdapted callback (new_sensitivity, noise_floor, peak)."""

    def _handler(event: object) -> None:
        e = cast(VADSensitivityAdapted, event)
        callback(e.new_sensitivity, e.noise_floor_rms, e.speech_peak_rms)

    event_bus.subscribe(event_type, _handler)


def wire_callback_with_speaker_segments(
    event_bus: EventBus,
    event_type: type[RecorderEvent],
    callback: Callable[[tuple[Any, ...]], None],
) -> None:
    """Wire ``on_speaker_segments_detected`` (receives the segments tuple)."""

    def _handler(event: object) -> None:
        e = cast(SpeakerSegmentsDetected, event)
        callback(e.segments)

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
        elif event_type is DeviceBecameAvailable:
            wire_callback_with_device_index(
                event_bus,
                event_type,
                cast(Callable[[int], None], cb_func),
            )
        elif event_type in {ModelSwapStarted, ModelSwapCompleted}:
            wire_callback_with_model_swap(event_bus, event_type, cast(Callable[[str, str], None], cb_func))
        elif event_type is ModelSwapFailed:
            wire_callback_with_model_swap_failed(
                event_bus,
                event_type,
                cast(Callable[[str, str, str, str, str], None], cb_func),
            )
        elif event_type is VADSensitivityAdapted:
            wire_callback_with_vad_sensitivity(
                event_bus,
                event_type,
                cast(Callable[[float, float, float], None], cb_func),
            )
        elif event_type is SpeakerSegmentsDetected:
            wire_callback_with_speaker_segments(
                event_bus,
                event_type,
                cast(Callable[[tuple[Any, ...]], None], cb_func),
            )
        else:
            wire_callback(event_bus, event_type, cast(SimpleCallback, cb_func))


_CLOUD_PROVIDER_PREFIXES: tuple[str, ...] = ("openai:", "elevenlabs:")


def _parse_cloud_model_id(model_name: str) -> tuple[str, str] | None:
    """Split a ``provider:model_id`` envelope into ``(provider, model_id)``.

    Returns ``None`` for plain local model ids (catalog entries, HF refs)
    so the local construction path runs unchanged. The prefix list is
    kept narrow — only providers electron-main actually knows how to
    forward to count as cloud here; an unknown prefix falls through to
    the ONNX loader, where it will surface a clear download error rather
    than be silently rerouted.
    """
    for prefix in _CLOUD_PROVIDER_PREFIXES:
        if model_name.startswith(prefix):
            provider, _, model_id = model_name.partition(":")
            if provider and model_id:
                return provider, model_id
    return None


def build_transcriber(
    model_name: str,
    config: RecorderConfig,
    *,
    download_callbacks: DownloadCallbacks | None = None,
) -> ITranscriber:
    """Build the transcriber.

    Two construction paths:

    * **Cloud STT** — ``model_name`` looks like ``openai:<id>`` or
      ``elevenlabs:<id>``: returns a :class:`RemoteTranscriber` that
      forwards every ``transcribe()`` call to electron-main over WS RPC.
      Holds no model weights locally; combined with the swap pipeline's
      unload-first phase this is what frees the previous local Whisper's
      RAM/VRAM when the user switches to a cloud source.

    * **Local ONNX** — anything else: catalog lookup → quantization
      resolution → :class:`OnnxAsrTranscriber`. This is the only locally-
      loaded transcriber after the torch-drop refactor; the catalog's
      ``backend`` marker is consulted for the resolved onnx model name
      but the construction path is uniform.
    """
    cloud = _parse_cloud_model_id(model_name)
    if cloud is not None:
        provider, cloud_model_id = cloud
        from src.recorder.infrastructure.remote_transcriber import RemoteTranscriber

        return RemoteTranscriber(provider=provider, model_id=cloud_model_id)

    from src.recorder.domain.model_registry import ModelCatalog

    progress_handler = download_callbacks.make_progress_handler() if download_callbacks else None

    catalog = ModelCatalog()
    info = catalog.get(model_name)
    onnx_name = info.onnx_model_name if info and info.onnx_model_name else model_name
    quantization = _resolve_quantization(
        config.transcription.onnx_quantization,
        config.transcription.device,
        info.param_count if info else 0,
        info.available_quantizations if info else None,
    )
    from src.recorder.infrastructure.device import providers_for_device

    providers = providers_for_device(config.transcription.device)

    from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

    return OnnxAsrTranscriber(
        model_name=onnx_name,
        quantization=quantization,
        providers=providers,
        on_download_progress=progress_handler,
        normalize_audio=config.transcription.normalize_audio,
    )


#: Auto-fp16-on-CUDA only kicks in for models at or above this param count.
#: Smaller models lose to fp32 because cast overhead at encoder/decoder I/O
#: dominates the small attention compute. Threshold benchmarked on RTX 3080 Ti
#: against ``physicsworks.wav`` (see ``server/scratch/bench_fp16_crossover.log``):
#:
#: - tiny (39M):  fp32 718x rtf, fp16 434x rtf  -> fp32 wins 1.7x
#: - base (74M):  fp32 384x rtf, fp16 329x rtf  -> fp32 wins 1.2x
#: - small (244M): tied (~159x rtf both)
#: - large-v3-turbo (809M): fp32 73x rtf, fp16 245x rtf  -> fp16 wins 3.4x
#:
#: 500M is the breakeven floor: below it fp16 is at best tied and at worst
#: noticeably slower; above it fp16 starts winning materially.
_FP16_AUTO_PARAM_THRESHOLD: int = 500_000_000


def _resolve_quantization(
    requested: str,
    device: str,
    param_count: int = 0,
    available: list[str] | None = None,
) -> str | None:
    """Resolve ``onnx_quantization`` to what onnx-asr should load.

    ``available`` is the model's published quantization set (the catalog's
    ``available_quantizations``; ``None`` for off-catalog HF repos whose
    variants we can't enumerate). Every branch is gated on it: we never
    resolve to a precision the repo doesn't actually ship, because
    onnx-asr would then fail with ``ModelFileNotFoundError`` and the
    server would fall back all the way to ``tiny``. The auto-fp16
    heuristic below was benchmarked on Whisper, where onnx-community
    publishes fp16 for every size; other families (NeMo Canary, GigaAM)
    ship only ``["", "int8"]`` — applying the Whisper rule blindly there
    asks for a ``*?fp16.onnx`` that does not exist.

    Behaviour:

    * **``"auto"`` / ``""``** — picks fp16 on CUDA only for models at or
      above :data:`_FP16_AUTO_PARAM_THRESHOLD` (500M params) **and only if
      the model publishes an fp16 export**. Smaller models stay on fp32
      because cast overhead at the encoder/decoder I/O boundaries
      dominates their compute (benchmark: tiny 718x rtf fp32 vs 434x rtf
      fp16; small ties; large-v3-turbo 73x rtf fp32 vs 245x rtf fp16).
      On CPU, auto is *always* fp32: ORT's CPUExecutionProvider has no
      fp16 kernels, so fp16 there casts to fp32 internally then back,
      paying double overhead (tiny.en CPU 158x vs 56x rtf). Empty string
      is treated as auto for backward compat with configs persisted before
      the default flipped from ``""`` (fp32-explicit) to ``"auto"``.
    * **Concrete quant the model doesn't publish** — fall back to fp32
      with a warning instead of asking onnx-asr for a non-existent file.
    * **Concrete fp16** — pass through. Users who explicitly select fp16
      hit the patch-on-load path in
      :class:`~src.recorder.infrastructure.onnxasr_transcriber.OnnxAsrTranscriber`
      that repairs the malformed onnx-community decoder (subgraph output
      names + dtype annotations) and lowers the session optimization
      level past LAYOUT to dodge the ORT ``SimplifiedLayerNormFusion``
      bug on the fp16 encoder.
    * **Concrete sub-fp16** (``int8`` / ``q4`` / ``q4f16`` / ``bnb4`` / ``uint8``)
      on CUDA — silently fall back to fp32 with a warning. ORT's
      CUDAExecutionProvider can't fuse Q/DQ nodes (every one runs via
      scatter-gather at fp32 anyway) and per-channel int8 has a known
      Whisper-encoder hallucination bug (microsoft/onnxruntime#25489) we
      benchmark-confirmed locally. Honoring the request would be actively
      harmful.
    """
    from src.recorder.domain.model_registry import _GPU_COMPATIBLE_QUANTIZATIONS
    from src.recorder.infrastructure.device import resolve_device

    resolved_dev = resolve_device(device)
    quant = (requested or "").strip()
    # Permissive when ``available`` is unknown (off-catalog repo): we can't
    # enumerate its variants, so preserve the historical assume-it-exists
    # behaviour rather than refusing a quant the repo might well ship.

    def _publishes(q: str) -> bool:
        return available is None or q in available

    if quant in {"auto", ""}:
        if resolved_dev == "cuda" and param_count >= _FP16_AUTO_PARAM_THRESHOLD and _publishes("fp16"):
            return "fp16"
        return None

    if not _publishes(quant):
        logger.warning(
            "onnx_quantization=%r requested but this model does not publish "
            "that variant (available=%s). Loading fp32 instead.",
            quant,
            available,
        )
        return None

    if resolved_dev == "cuda" and quant not in _GPU_COMPATIBLE_QUANTIZATIONS:
        logger.warning(
            "onnx_quantization=%r requested but not GPU-compatible on "
            "CUDAExecutionProvider (it would fall back to fp32 compute and "
            "is prone to hallucination). Loading fp32 instead. To use this "
            "quantization, switch the transcription device to 'cpu'.",
            quant,
        )
        return None
    return quant


def build_realtime_transcriber(
    config: RecorderConfig,
    *,
    download_callbacks: DownloadCallbacks | None = None,
) -> ITranscriber:
    """Build the realtime transcriber.

    Mirrors :func:`build_transcriber`: cloud-prefixed ids route to
    :class:`RemoteTranscriber` (no local model weights), everything else
    goes through the onnx-asr path.
    """
    model_name = config.realtime.realtime_model_type
    cloud = _parse_cloud_model_id(model_name)
    if cloud is not None:
        provider, cloud_model_id = cloud
        from src.recorder.infrastructure.remote_transcriber import RemoteTranscriber

        return RemoteTranscriber(provider=provider, model_id=cloud_model_id)

    from src.recorder.domain.model_registry import ModelCatalog

    progress_handler = download_callbacks.make_progress_handler() if download_callbacks else None

    catalog = ModelCatalog()
    info = catalog.get(model_name)
    onnx_name = info.onnx_model_name if info and info.onnx_model_name else model_name
    quantization = _resolve_quantization(
        config.transcription.onnx_quantization,
        config.transcription.device,
        info.param_count if info else 0,
        info.available_quantizations if info else None,
    )
    from src.recorder.infrastructure.device import providers_for_device

    providers = providers_for_device(config.transcription.device)

    from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

    # Realtime feeds bounded-short windows (<= REALTIME_COMMIT_AFTER_SECONDS,
    # ~20 s — always under Whisper's 30 s mel limit). VAD segmentation there
    # is pure per-tick overhead and would trim trailing in-progress speech
    # out of the growing live preview, so skip it (also avoids loading a
    # second Silero model for the realtime instance).
    return OnnxAsrTranscriber(
        model_name=onnx_name,
        quantization=quantization,
        providers=providers,
        on_download_progress=progress_handler,
        segment_with_vad=False,
        normalize_audio=config.transcription.normalize_audio,
    )


def _build_porcupine_detector(config: RecorderConfig) -> IWakeWordDetector:
    """Construct a Porcupine-backed wake-word detector from ``config``.

    The 1.9.x line is pinned (see server/pyproject.toml) precisely so this
    builder works without a Picovoice access key — the 14 built-in keywords
    (alexa, computer, jarvis, etc.) are usable directly.
    """
    from src.recorder.infrastructure.porcupine_detector import PorcupineDetector

    words = [w.strip() for w in config.wake_word.wake_words.split(",") if w.strip()]
    return PorcupineDetector(
        wake_words=words,
        sensitivities=[config.wake_word.wake_words_sensitivity] * len(words),
        buffer_size=config.audio.buffer_size,
    )


def _build_oww_detector(config: RecorderConfig) -> IWakeWordDetector:
    """Construct an openWakeWord-backed detector from ``config``."""
    from src.recorder.infrastructure.oww_detector import OWWDetector

    model_paths = (
        [p.strip() for p in config.wake_word.openwakeword_model_paths.split(",")]
        if config.wake_word.openwakeword_model_paths
        else None
    )
    return OWWDetector(
        model_paths=model_paths,
        inference_framework=config.wake_word.openwakeword_inference_framework,
        sensitivity=config.wake_word.wake_words_sensitivity,
    )


def _build_composite_detector(config: RecorderConfig) -> IWakeWordDetector:
    """Construct a Porcupine+openWakeWord composite detector from ``config``.

    Only valid for keywords supported by both engines (currently only
    ``alexa``). The composite reads the keyword from ``wake_words`` — the
    first comma-separated entry — and constructs both engines internally so
    detection requires cross-engine agreement.
    """
    from src.recorder.infrastructure.composite_wake_word import CompositeWakeWordDetector

    words = [w.strip() for w in config.wake_word.wake_words.split(",") if w.strip()]
    if not words:
        msg = "composite wake-word backend requires --wake_words to be set"
        raise ValueError(msg)
    return CompositeWakeWordDetector(
        wake_word=words[0],
        sensitivity=config.wake_word.wake_words_sensitivity,
        buffer_size=config.audio.buffer_size,
    )


# Registry of supported wake-word backends keyed by canonical name AND every
# historical alias clients have ever sent. Adding a new backend means defining
# a builder above and adding one or more entries here — there is no second
# place to update.
WAKE_WORD_BACKENDS: dict[str, Callable[[RecorderConfig], IWakeWordDetector]] = {
    "pvp": _build_porcupine_detector,
    "pvporcupine": _build_porcupine_detector,
    "oww": _build_oww_detector,
    "openwakeword": _build_oww_detector,
    "openwakewords": _build_oww_detector,
    "composite": _build_composite_detector,
}


def _validate_language_against_model(config: RecorderConfig) -> None:
    """Fail fast if the requested language is incompatible with the chosen model.

    Without this check a user picks ``language="es"`` on an English-only
    Whisper variant (``tiny.en`` etc.) and onnx-asr silently degrades — no
    output, no error. Catalog-aware models report their compatibility via
    ``ModelCatalog.is_language_compatible`` so this single check covers
    every family in the registry; unknown models pass through (the catalog
    isn't exhaustive of every onnx-asr-resolvable name).
    """
    from src.building_blocks.errors import ConfigurationError
    from src.recorder.domain.model_registry import ModelCatalog

    catalog = ModelCatalog()
    main_model = config.transcription.model
    main_lang = config.transcription.language
    if not catalog.is_language_compatible(main_model, main_lang):
        info = catalog.get(main_model)
        supported = ", ".join(info.languages) if info and info.languages else "(unknown)"
        raise ConfigurationError(
            f"Model {main_model!r} does not support language {main_lang!r}. "
            f"Supported languages for this model: {supported}. "
            f"Pick a multilingual model (e.g. 'large-v3') or leave language empty for auto-detect."
        )
    if config.realtime.enable_realtime_transcription and not config.realtime.use_main_model_for_realtime:
        rt_model = config.realtime.realtime_model_type
        if not catalog.is_language_compatible(rt_model, main_lang):
            info = catalog.get(rt_model)
            supported = ", ".join(info.languages) if info and info.languages else "(unknown)"
            raise ConfigurationError(
                f"Realtime model {rt_model!r} does not support language {main_lang!r}. "
                f"Supported languages: {supported}."
            )


def bootstrap_di(
    config: RecorderConfig,
    callbacks: CallbackMap | None = None,
    *,
    download_callbacks: DownloadCallbacks | None = None,
) -> RecorderService:
    """Wire all ports to adapters and create RecorderService."""
    _validate_language_against_model(config)

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

    # Build wake word detector — selected via ``WAKE_WORD_BACKENDS`` registry.
    wake_word_detector: IWakeWordDetector | None = None
    backend_factory = WAKE_WORD_BACKENDS.get(config.wake_word.wakeword_backend)
    if backend_factory is not None:
        wake_word_detector = backend_factory(config)

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
