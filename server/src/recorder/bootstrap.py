from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import numpy as np
from kink import di

from src.building_blocks.clock import Clock

if TYPE_CHECKING:
    from src.recorder.domain.model_registry import ModelInfo
from src.building_blocks.event_bus import EventBus
from src.building_blocks.types import CallbackMap, LevelCallback, SimpleCallback, TextCallback
from src.recorder.application.recorder_service import RecorderService
from src.recorder.domain.config import DiarizationConfig, RecorderConfig
from src.recorder.domain.events import (
    AudioChunkRecorded,
    AudioLevelComputed,
    DeviceBecameAvailable,
    DeviceSwitchFailed,
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
from src.recorder.domain.ports.diarizer import IDiarizer
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
    "on_diarization_toggle_started": DiarizationToggleStarted,
    "on_diarization_toggle_completed": DiarizationToggleCompleted,
    "on_diarization_toggle_failed": DiarizationToggleFailed,
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


def wire_callback_with_diarization_toggle(
    event_bus: EventBus,
    event_type: type[RecorderEvent],
    callback: Callable[[bool], None],
) -> None:
    """Wire DiarizationToggleStarted / DiarizationToggleCompleted callbacks.

    Both events carry a single ``enabled`` boolean (the target state).
    The wrapper unpacks it and invokes the user callback.
    """

    def _handler(event: object) -> None:
        # Same shape on both started + completed → casting to Started is safe.
        e = cast(DiarizationToggleStarted, event)
        callback(e.enabled)

    event_bus.subscribe(event_type, _handler)


def wire_callback_with_diarization_toggle_failed(
    event_bus: EventBus,
    event_type: type[RecorderEvent],
    callback: Callable[[bool, str, str, str], None],
) -> None:
    """Wire DiarizationToggleFailed callback (enabled, reason, category, detail).

    Mirrors :func:`wire_callback_with_model_swap_failed` — the renderer's
    failure-toast pipeline shares the same shape so the variant lookup
    works for both swap and toggle failures.
    """

    def _handler(event: object) -> None:
        e = cast(DiarizationToggleFailed, event)
        callback(e.enabled, e.reason, e.category, e.detail)

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
        elif event_type in {DiarizationToggleStarted, DiarizationToggleCompleted}:
            wire_callback_with_diarization_toggle(
                event_bus,
                event_type,
                cast(Callable[[bool], None], cb_func),
            )
        elif event_type is DiarizationToggleFailed:
            wire_callback_with_diarization_toggle_failed(
                event_bus,
                event_type,
                cast(Callable[[bool, str, str, str], None], cb_func),
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


def _resolve_load_target(model_name: str, info: ModelInfo | None) -> tuple[str, str | None]:
    """Pick the ``(onnx_model_name, local_path)`` pair onnx-asr should load.

    Three cases:

    1. **Custom model** — ``info.local_path`` is set: pass the slug as the
       model_name (onnx-asr only inspects the model type from the catalog
       entry; the actual file IO uses ``path=local_path``) and the on-disk
       folder as the local path. No HF round-trip happens.
    2. **Catalog entry with onnx_model_name** — the standard remote case:
       use the HF repo id from the catalog so we go through the resolver.
    3. **Unknown id** — fall through to the raw model_name; onnx-asr's
       resolver will either accept it as an HF repo path or raise
       ``ModelNotSupportedError`` (the resolver is permissive enough that
       not every typo blows up here).
    """
    if info is not None and info.local_path:
        return model_name, info.local_path
    if info is not None and info.onnx_model_name:
        return info.onnx_model_name, None
    return model_name, None


def _resolve_sense_voice_model_path(
    onnx_name: str,
    local_path: str | None,
    progress_handler: Callable[[DownloadProgress], None] | None,
) -> Path:
    """Materialize the SenseVoice model directory on disk.

    Three cases handled in order:

    1. **Custom model** — ``local_path`` set: the directory ships with
       the user's own ``model.onnx`` + ``tokens.txt``. No network IO.
    2. **HF repo path** — ``onnx_name`` looks like ``org/repo``: pull a
       snapshot via ``huggingface_hub.snapshot_download``. The repo is
       expected to expose ``model.onnx`` (or ``model.int8.onnx``) and
       ``tokens.txt`` at its root — the canonical
       ``csukuangfj/sherpa-onnx-sense-voice-*`` layout.
    3. **Plain alias** — fall through and treat ``onnx_name`` as a
       directory path. Useful for ad-hoc local installs.

    Returns the directory the SenseVoiceTranscriber should load from.

    When ``progress_handler`` is supplied the HF fetch streams aggregated
    per-byte progress through it — same event shape onnx-asr's native
    ``progress_callback`` emits, so the renderer's progress UI lights up
    for SenseVoice just like every other family.
    """
    if local_path:
        return Path(local_path)
    if "/" in onnx_name:
        from huggingface_hub import snapshot_download

        # SenseVoice exports keep both model.onnx and tokens.txt at the
        # repo root; the allow_patterns match what every published
        # variant ships, no surprise extras.
        snapshot_kwargs: dict[str, Any] = {"allow_patterns": ["model.onnx", "model.int8.onnx", "tokens.txt"]}
        if progress_handler is not None:
            snapshot_kwargs["tqdm_class"] = _build_hf_progress_tqdm_class(onnx_name, progress_handler)
        downloaded = snapshot_download(onnx_name, **snapshot_kwargs)
        return Path(downloaded)
    return Path(onnx_name)


def _build_hf_progress_tqdm_class(
    model_name: str,
    sink: Callable[[DownloadProgress], None],
) -> type:
    """Return a tqdm subclass that emits :class:`DownloadProgress` events.

    ``huggingface_hub.snapshot_download`` invokes ``tqdm_class`` once per
    downloaded file. We override ``update`` and ``close`` and aggregate
    across all live instances in a closure-shared dict so the UI sees
    one rolled-up progress bar for the model as a whole — matching how
    :func:`_make_progress_adapter` rolls up onnx-asr's per-file events
    for the other families.

    The base class is ``tqdm.auto.tqdm`` so HF's other tqdm-style hooks
    (``hf_hub_download``'s desc/unit kwargs, …) still work; we only
    layer a side-channel sink on top.
    """
    import time

    from tqdm.auto import tqdm as _BaseTqdm

    aggregate: dict[int, tuple[int, int]] = {}
    start_time = time.monotonic()

    def _emit() -> None:
        downloaded_bytes = sum(d for d, _ in aggregate.values())
        total_bytes = sum(t for _, t in aggregate.values())
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

    class _ProgressTqdm(_BaseTqdm):  # type: ignore[misc]  # tqdm.auto.tqdm has no public type stub
        def __init__(self, *args: Any, **kwargs: Any) -> None:  # noqa: ANN401  # tqdm signature is *args/**kwargs
            super().__init__(*args, **kwargs)
            self._winstt_key = id(self)
            aggregate[self._winstt_key] = (0, int(self.total or 0))
            _emit()

        def update(self, n: int = 1) -> bool | None:
            result: bool | None = super().update(n)
            downloaded = int(getattr(self, "n", 0))
            total = int(getattr(self, "total", 0) or 0)
            aggregate[self._winstt_key] = (downloaded, total)
            _emit()
            return result

        def close(self) -> None:
            # Pin to the final declared total so partial last-chunk
            # updates don't leave the bar at 99 %.
            total = int(getattr(self, "total", 0) or 0)
            if total:
                aggregate[self._winstt_key] = (total, total)
                _emit()
            super().close()

    return _ProgressTqdm


def _build_sense_voice_transcriber(
    info: ModelInfo,
    model_name: str,
    config: RecorderConfig,
    providers: list[Any] | None,
    progress_handler: Callable[[DownloadProgress], None] | None,
) -> ITranscriber:
    """Construct a :class:`SenseVoiceTranscriber` from a catalog entry.

    Resolves the model directory (custom path / HF snapshot / local
    directory), then instantiates the transcriber with provider-tuned
    session options. The SenseVoice family ignores ``quantization``
    because its catalog only publishes ``int8`` and the file name is
    auto-resolved by the transcriber.
    """
    onnx_name, local_path = _resolve_load_target(model_name, info)
    model_dir = _resolve_sense_voice_model_path(onnx_name, local_path, progress_handler)

    from src.recorder.infrastructure.sense_voice_transcriber import SenseVoiceTranscriber

    return SenseVoiceTranscriber(
        model_path=model_dir,
        providers=providers,
        on_download_progress=progress_handler,
        normalize_audio=config.transcription.normalize_audio,
    )


def build_transcriber(
    model_name: str,
    config: RecorderConfig,
    *,
    download_callbacks: DownloadCallbacks | None = None,
) -> ITranscriber:
    """Build the transcriber.

    Three construction paths:

    * **Cloud STT** — ``model_name`` looks like ``openai:<id>`` or
      ``elevenlabs:<id>``: returns a :class:`RemoteTranscriber` that
      forwards every ``transcribe()`` call to electron-main over WS RPC.
      Holds no model weights locally; combined with the swap pipeline's
      unload-first phase this is what frees the previous local Whisper's
      RAM/VRAM when the user switches to a cloud source.

    * **SenseVoice family** — catalog ``family == "sense_voice"``:
      returns a :class:`SenseVoiceTranscriber`. SenseVoice doesn't fit
      onnx-asr's preprocessor abstractions (it has its own FBANK +
      LFR + CMVN + 4-control-token pipeline) so it ships its own adapter.

    * **Local ONNX** — anything else: catalog lookup → quantization
      resolution → :class:`OnnxAsrTranscriber`. This is the dominant
      locally-loaded path; the catalog's ``backend`` marker is consulted
      for the resolved onnx model name but the construction path is
      uniform.
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
    onnx_name, local_path = _resolve_load_target(model_name, info)
    quantization = _resolve_quantization(
        config.transcription.onnx_quantization,
        config.transcription.device,
        info.param_count if info else 0,
        info.available_quantizations if info else None,
        family=info.family if info else "",
        accelerator=config.transcription.accelerator,
    )
    from src.recorder.infrastructure.device import providers_for_settings

    providers = providers_for_settings(
        config.transcription.device,
        config.transcription.accelerator,
    )
    providers = _override_dml_to_cpu_for_incompatible_family(
        providers,
        family=info.family if info else "",
        accelerator=config.transcription.accelerator,
        device=config.transcription.device,
    )

    if info is not None and info.family == "sense_voice":
        return _build_sense_voice_transcriber(info, model_name, config, providers, progress_handler)

    from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

    return OnnxAsrTranscriber(
        model_name=onnx_name,
        quantization=quantization,
        providers=providers,
        on_download_progress=progress_handler,
        normalize_audio=config.transcription.normalize_audio,
        local_path=local_path,
        translate_to_english=config.transcription.translate_to_english,
        whisper_beam_size=config.transcription.whisper_beam_size,
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


#: Model families that prefer int8 over fp32 on non-CUDA accelerators
#: (and CPU). NeMo / Cohere / GigaAM / Kaldi / T-One ONNX graphs are
#: shipped by their authors primarily as int8 — Handy's transcribe-rs
#: loads them with ``Quantization::Int8`` for every backend (CPU,
#: DirectML, Vulkan) and we mirror that. fp32 still works but trades
#: ~3-4x memory + 2x latency for no accuracy gain on these well-trained
#: encoders. Whisper / Moonshine ship working fp32 graphs across every EP
#: and are excluded so the existing fp32/fp16 auto-promotion still wins.
_INT8_PREFERRED_FAMILIES: frozenset[str] = frozenset({"nemo", "cohere", "gigaam", "kaldi", "t-one", "sense_voice"})


def _override_dml_to_cpu_for_incompatible_family(
    providers: list[Any] | None,
    *,
    family: str,
    accelerator: str,
    device: str,
) -> list[Any] | None:
    """Force CPU EP for NeMo-family models on DirectML / ROCm / CoreML.

    Background — verified locally on 2026-05-27:

    * istupakov's ``encoder-model.int8.onnx`` for Canary 180M (byte-identical
      to the one Handy ships at ``blob.handy.computer/canary-180m-flash.tar.gz``)
      crashes with ``Non-zero status code returned while running Reshape
      node 'node_view'`` (``MLOperatorAuthorImpl.cpp(2597)``,
      ``ERROR_FATAL_APP_EXIT``) on any DirectML provider list, with or
      without graph optimizations.
    * The SAME file runs cleanly on ``CPUExecutionProvider``.
    * Handy "supports" Canary on Windows DML because their ``transcribe-rs``
      stack ends up using CPU EP for these families regardless of the
      ``ort-directml`` Cargo feature — same end result we get here.

    So: when the user's selected accelerator is DML / ROCm / CoreML and
    the model family is in :data:`model_registry._DML_INCOMPATIBLE_FAMILIES`,
    swap any non-CPU EP for ``CPUExecutionProvider``. Whisper / Moonshine
    keep the GPU EP they got. Callers that already resolved to plain CPU
    (or a real CUDA EP) pass through unchanged.
    """
    if not family:
        return providers
    from src.recorder.domain.model_registry import _DML_INCOMPATIBLE_FAMILIES
    from src.recorder.infrastructure.device import resolve_accelerator

    if family not in _DML_INCOMPATIBLE_FAMILIES:
        return providers
    resolved_acc = resolve_accelerator(accelerator or device)
    if resolved_acc in {"cuda", "cpu"}:
        return providers
    logger.info(
        "Routing %r-family model through CPUExecutionProvider — its ONNX "
        "encoder is known-broken on %s's MLOperatorAuthorImpl reshape "
        "kernel. Same fallback Handy's transcribe-rs uses for these families.",
        family,
        resolved_acc,
    )
    return ["CPUExecutionProvider"]


def _resolve_quantization(
    requested: str,
    device: str,
    param_count: int = 0,
    available: list[str] | None = None,
    family: str = "",
    accelerator: str = "auto",
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
    from src.recorder.infrastructure.device import resolve_accelerator, resolve_device

    resolved_dev = resolve_device(device)
    # `resolve_device` collapses every non-CPU accelerator into the legacy
    # "cuda" bucket; we need the real EP name to tell DirectML / ROCm apart
    # from actual CUDA for the int8-on-DML heuristic below. Fall back to the
    # legacy `device` field when `accelerator` was left at its default — the
    # priority walk in `resolve_accelerator` produces the same picks.
    resolved_acc = resolve_accelerator(accelerator or device)
    quant = (requested or "").strip()
    # Permissive when ``available`` is unknown (off-catalog repo): we can't
    # enumerate its variants, so preserve the historical assume-it-exists
    # behaviour rather than refusing a quant the repo might well ship.

    def _publishes(q: str) -> bool:
        return available is None or q in available

    if quant in {"auto", ""}:
        if resolved_dev == "cuda" and param_count >= _FP16_AUTO_PARAM_THRESHOLD and _publishes("fp16"):
            return "fp16"
        if resolved_acc != "cuda" and family in _INT8_PREFERRED_FAMILIES and _publishes("int8"):
            return "int8"
        return None

    if not _publishes(quant):
        logger.warning(
            "onnx_quantization=%r requested but this model does not publish "
            "that variant (available=%s). Loading fp32 instead.",
            quant,
            available,
        )
        return None

    if resolved_acc == "cuda" and quant not in _GPU_COMPATIBLE_QUANTIZATIONS:
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
    onnx_name, local_path = _resolve_load_target(model_name, info)
    quantization = _resolve_quantization(
        config.transcription.onnx_quantization,
        config.transcription.device,
        info.param_count if info else 0,
        info.available_quantizations if info else None,
        family=info.family if info else "",
        accelerator=config.transcription.accelerator,
    )
    from src.recorder.infrastructure.device import providers_for_settings

    providers = providers_for_settings(
        config.transcription.device,
        config.transcription.accelerator,
    )
    providers = _override_dml_to_cpu_for_incompatible_family(
        providers,
        family=info.family if info else "",
        accelerator=config.transcription.accelerator,
        device=config.transcription.device,
    )

    if info is not None and info.family == "sense_voice":
        # SenseVoice has a single forward-pass path that already returns
        # whole-utterance text; there's no separate "bounded-short"
        # adapter to reach for. Reuse the same construction as the main
        # transcriber and let the realtime worker drive it.
        return _build_sense_voice_transcriber(info, model_name, config, providers, progress_handler)

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
        local_path=local_path,
        segment_with_vad=False,
        normalize_audio=config.transcription.normalize_audio,
        # Realtime worker translates too if the user opted in — keeps
        # the live-preview language consistent with the main result.
        translate_to_english=config.transcription.translate_to_english,
    )


def build_diarizer(diarization_config: DiarizationConfig) -> IDiarizer:
    """Construct the live diarizer from a ``DiarizationConfig``.

    Mirrors :func:`build_transcriber`: pulled out of the facade so both
    cold-boot composition (`AudioToTextRecorder._ensure_service`) and the
    runtime toggle worker (`RecorderService.request_diarization_toggle`)
    construct the same way without duplicating the import + arg list. The
    onnx-asr segmentation+embedding sessions are loaded lazily inside
    ``OnnxAsrDiarizer.__init__``; the first call to ``diarize()`` warms
    the kernels (the facade's ``warmup()`` does this proactively on cold
    boot — the toggle worker can rely on the regular hot path for runtime
    enables since the spinner is on the UI anyway).
    """
    from src.recorder.infrastructure.onnxasr_diarizer import OnnxAsrDiarizer

    return OnnxAsrDiarizer(
        max_speakers=diarization_config.max_speakers,
        delta_new=diarization_config.delta_new,
        rho_update=diarization_config.rho_update,
        segmentation_model=diarization_config.segmentation_model,
        embedding_model=diarization_config.embedding_model,
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
            always_on_microphone=config.audio.always_on_microphone,
            lazy_stream_close=config.audio.lazy_stream_close,
            lazy_close_timeout_seconds=config.audio.lazy_close_timeout_seconds,
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
