"""Callback factories for the STT server — event→queue bridge."""

from __future__ import annotations

import asyncio
import base64
import json
import time
from collections.abc import Callable
from typing import Any

import numpy as np

from src.building_blocks.terminal import TerminalColors as bcolors
from src.building_blocks.terminal import debug_print
from src.recorder.bootstrap import CALLBACK_EVENT_MAP
from src.recorder.domain.events import DownloadProgress
from src.stt_server.cli import persist_setting
from src.stt_server.state import ServerState


def make_callback(
    loop: asyncio.AbstractEventLoop,
    callback: Callable[..., None],
) -> Callable[..., None]:
    """Create an event-loop-bound closure that appends ``loop`` as the last arg."""

    def inner_callback(*args: object, **kwargs: object) -> None:
        callback(*args, **kwargs, loop=loop)

    return inner_callback


# ─── Simple event callbacks ──────────────────────────────────────────────

# Callbacks that need custom JSON shapes or are intentionally NOT relayed to
# the client as a generic ``{"type": <name>}`` message. Adding a new callback
# to ``CALLBACK_EVENT_MAP`` in bootstrap auto-promotes it to a simple event
# unless it appears here. Listed once → keeps the protocol surface in one
# place rather than scattered through specialised handlers.
_NON_SIMPLE_CALLBACKS: frozenset[str] = frozenset(
    {
        # Specialised callbacks below have bespoke JSON shapes.
        "on_transcription_start",
        "on_audio_level",
        "on_turn_detection_start",
        "on_turn_detection_stop",
        "on_device_switch_failed",
        "on_device_became_available",
        "on_model_swap_started",
        "on_model_swap_completed",
        "on_model_swap_failed",
        "on_vad_sensitivity_adapted",
        "on_speaker_segments_detected",
        # Domain events the server intentionally does not relay over the wire.
        "on_vad_start",
        "on_vad_stop",
        "on_recorded_chunk",
        "on_realtime_transcription_update",
        "on_realtime_transcription_stabilized",
        "on_wakeword_timeout",
    }
)

# Derived from CALLBACK_EVENT_MAP — adding a new callback to the recorder
# domain registers it as a simple event automatically, no edits here needed.
_SIMPLE_EVENTS: list[str] = sorted(
    name.removeprefix("on_") for name in CALLBACK_EVENT_MAP if name not in _NON_SIMPLE_CALLBACKS
)


def _make_simple_event_callback(
    event_type: str,
    state: ServerState,
) -> Callable[[asyncio.AbstractEventLoop], None]:
    """Return a callback that enqueues a simple ``{"type": event_type}`` JSON message."""

    def _cb(loop: asyncio.AbstractEventLoop) -> None:
        message = json.dumps({"type": event_type})
        asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)

    return _cb


# ─── Specialised callbacks ───────────────────────────────────────────────


def on_model_download_start(model: str, state: ServerState, loop: asyncio.AbstractEventLoop) -> None:
    state.cancel_download_requested = False
    print(f"{bcolors.OKGREEN}[download] start: {model}{bcolors.ENDC}")
    message = json.dumps({"type": "model_download_start", "model": model})
    state.download_state = message
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def on_model_download_progress(info: DownloadProgress, state: ServerState, loop: asyncio.AbstractEventLoop) -> None:
    message = json.dumps(
        {
            "type": "model_download_progress",
            "model": info.model,
            "progress": info.progress,
            "downloaded_bytes": info.downloaded_bytes,
            "total_bytes": info.total_bytes,
            "speed_bps": info.speed_bps,
            "eta_seconds": info.eta_seconds,
        }
    )
    state.download_state = message
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def on_model_download_complete(model: str, state: ServerState, loop: asyncio.AbstractEventLoop) -> None:
    print(f"{bcolors.OKGREEN}[download] complete: {model}{bcolors.ENDC}")
    message = json.dumps({"type": "model_download_complete", "model": model, "cancelled": False})
    state.download_state = None
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def on_model_download_cancelled(model: str, state: ServerState, loop: asyncio.AbstractEventLoop) -> None:
    state.cancel_download_requested = False
    if state.recorder is not None:
        persist_setting("model", state.recorder.model)
    print(f"{bcolors.WARNING}[download] cancelled: {model}{bcolors.ENDC}")
    message = json.dumps({"type": "model_download_complete", "model": model, "cancelled": True})
    state.download_state = None
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def on_transcription_start(
    _audio_bytes: np.ndarray[Any, np.dtype[np.int16]],
    state: ServerState,
    loop: asyncio.AbstractEventLoop,
) -> None:
    bytes_b64 = base64.b64encode(_audio_bytes.tobytes()).decode("utf-8")
    message = json.dumps({"type": "transcription_start", "audio_bytes_base64": bytes_b64})
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def on_audio_level(level: float, state: ServerState, loop: asyncio.AbstractEventLoop) -> None:
    # Append + trim so the noise-break audio-variance gate in text_processing
    # has a bounded window of recent samples to analyse. Trim cadence is per
    # event (cheap) rather than time-based so a quiet stretch can't leave a
    # stale entry sitting in the deque past the window.
    now = time.time()
    state.recent_audio_levels.append((now, level))
    cutoff = now - state.hard_break_even_on_background_noise
    while state.recent_audio_levels and state.recent_audio_levels[0][0] < cutoff:
        state.recent_audio_levels.popleft()
    message = json.dumps({"type": "audio_level", "level": round(level, 4)})
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def on_turn_detection_start(state: ServerState, loop: asyncio.AbstractEventLoop) -> None:
    debug_print("on_turn_detection_start", enabled=state.debug_logging)
    message = json.dumps({"type": "start_turn_detection"})
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def on_turn_detection_stop(state: ServerState, loop: asyncio.AbstractEventLoop) -> None:
    debug_print("on_turn_detection_stop", enabled=state.debug_logging)
    message = json.dumps({"type": "stop_turn_detection"})
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def on_model_swap_started(
    kind: str,
    name: str,
    state: ServerState,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Forward a model-swap-started event to the renderer.

    UI shows the new model with a 'loading' badge in the picker. PTT keeps
    working on the old model until ``on_model_swap_completed`` fires.
    """
    print(f"{bcolors.OKBLUE}[model-swap] start: kind={kind} name={name}{bcolors.ENDC}")
    message = json.dumps({"type": "model_swap_started", "kind": kind, "name": name})
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def on_model_swap_completed(
    kind: str,
    name: str,
    state: ServerState,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Forward a model-swap-completed event — the new model is now live."""
    print(f"{bcolors.OKGREEN}[model-swap] done: kind={kind} name={name}{bcolors.ENDC}")
    persist_setting("model" if kind == "main" else "realtime_model_type", name)
    message = json.dumps({"type": "model_swap_completed", "kind": kind, "name": name})
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)
    # The HF cache state for this model just flipped to "cached" — push an
    # invalidation event so the renderer can refresh its model selector
    # badges without polling list_models_with_state.
    cache_message = json.dumps({"type": "model_cache_changed", "model_id": name})
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(cache_message), loop)
    # Broadcast the fresh runtime_info to every control connection. Without
    # this, the renderer's cached ``runtimeInfo.model`` lags behind the
    # actually-loaded model — and the active-model reconciler races against
    # the stale snapshot to revert the user's pick. Piggybacks on the
    # existing ``handleGetRuntimeInfoEvent`` shape in the WS client so no
    # new client-side wiring is needed.
    if state.recorder is None:
        return
    try:
        info = state.recorder.runtime_info()
    except Exception:
        # runtime_info() failed (post-swap inconsistency); the cache will
        # heal on the next get_runtime_info request or server_ready.
        return
    rt_payload = json.dumps({"command": "get_runtime_info", "status": "success", "value": info})
    for ws in list(state.control_connections):
        asyncio.run_coroutine_threadsafe(ws.send(rt_payload), loop)


def on_model_swap_failed(
    kind: str,
    name: str,
    reason: str,
    category: str,
    detail: str,
    state: ServerState,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Forward a model-swap-failed event so the renderer can revert + toast.

    The previous model is still active server-side (rebuilt by the swap
    worker's restore path when possible). The renderer keys off
    ``category`` to pick a localised toast variant and uses ``reason``
    as a fallback headline; ``detail`` is the technical detail for
    diagnostic logs / bug reports.
    """
    print(
        f"{bcolors.WARNING}[model-swap] failed: kind={kind} name={name} "
        f"category={category} reason={reason} detail={detail}{bcolors.ENDC}"
    )
    message = json.dumps(
        {
            "type": "model_swap_failed",
            "kind": kind,
            "name": name,
            "reason": reason,
            "category": category,
            "detail": detail,
        }
    )
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def on_vad_sensitivity_adapted(
    new_sensitivity: float,
    noise_floor_rms: float,
    speech_peak_rms: float,
    state: ServerState,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Forward an adaptive-VAD update so the renderer can persist it per device.

    The server is device-agnostic; the renderer correlates the event with
    whichever input device is currently selected and stores
    ``new_sensitivity`` under that device's name in its settings map.
    """
    message = json.dumps(
        {
            "type": "vad_sensitivity_adapted",
            "new_sensitivity": round(new_sensitivity, 4),
            "noise_floor_rms": round(noise_floor_rms, 4),
            "speech_peak_rms": round(speech_peak_rms, 4),
        }
    )
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def on_device_switch_failed(
    requested_index: int,
    error_message: str,
    fallback_index: int | None,
    state: ServerState,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Forward a runtime device-switch failure to the renderer.

    Fires when the audio reader thread's pa.open() blew up on the queued
    device — by then the synchronous probe in _handle_set_parameter has
    already passed, so this is the race-condition / device-disappeared
    safety net.
    """
    print(
        f"{bcolors.WARNING}[device-switch] failed: requested={requested_index} "
        f"fallback={fallback_index} reason={error_message}{bcolors.ENDC}",
    )
    message = json.dumps(
        {
            "type": "device_switch_failed",
            "requested_index": requested_index,
            "error_message": error_message,
            "fallback_index": fallback_index,
        }
    )
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def on_speaker_segments_detected(
    segments: tuple[Any, ...],
    state: ServerState,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Forward diarization results so the renderer can color words per speaker.

    Fires once per utterance, immediately after the matching ``fullSentence``
    event. ``segments`` is a tuple of :class:`SpeakerSegment` whose ``start``
    / ``end`` are seconds relative to the utterance start (NOT wall-clock).
    The renderer applies them to the most-recent committed sentence.
    """
    payload = [{"start": round(seg.start, 3), "end": round(seg.end, 3), "speaker": seg.speaker} for seg in segments]
    message = json.dumps({"type": "speaker_segments", "segments": payload})
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def on_device_became_available(
    device_index: int,
    state: ServerState,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Forward a hotplug-attach event to the renderer.

    Fires when the audio source's waiting-for-device state ends — either
    because the server booted with no microphone and one was plugged in,
    or a working mic was unplugged mid-run and replaced. Renderer uses
    this to refresh the input-device list and surface a toast so the user
    knows recording is possible again. Mirrors ``device_switch_failed``
    but in the success direction.
    """
    print(f"{bcolors.OKGREEN}[device-attach] index={device_index}{bcolors.ENDC}")
    message = json.dumps(
        {
            "type": "device_became_available",
            "device_index": device_index,
        }
    )
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


# ─── Builder ─────────────────────────────────────────────────────────────


def _make_state_callback(
    loop: asyncio.AbstractEventLoop,
    callback: Callable[..., None],
    state: ServerState,
) -> Callable[..., None]:
    """Create a closure that injects both ``state`` and ``loop`` into the callback."""

    def inner(*args: object, **kwargs: object) -> None:
        callback(*args, state=state, loop=loop, **kwargs)

    return inner


def build_recorder_callbacks(state: ServerState, loop: asyncio.AbstractEventLoop) -> dict[str, Any]:
    """Build the full callback dict for AudioToTextRecorder."""
    callbacks: dict[str, Any] = {}

    # Simple event callbacks (all have the same shape)
    for event_name in _SIMPLE_EVENTS:
        cb = _make_simple_event_callback(event_name, state)
        callbacks[f"on_{event_name}"] = make_callback(loop, cb)

    # Specialised callbacks that need state
    callbacks["on_transcription_start"] = _make_state_callback(loop, on_transcription_start, state)
    callbacks["on_audio_level"] = _make_state_callback(loop, on_audio_level, state)
    callbacks["on_turn_detection_start"] = _make_state_callback(loop, on_turn_detection_start, state)
    callbacks["on_turn_detection_stop"] = _make_state_callback(loop, on_turn_detection_stop, state)
    callbacks["on_model_download_start"] = _make_state_callback(loop, on_model_download_start, state)
    callbacks["on_model_download_progress"] = _make_state_callback(loop, on_model_download_progress, state)
    callbacks["on_model_download_complete"] = _make_state_callback(loop, on_model_download_complete, state)
    callbacks["on_model_download_cancelled"] = _make_state_callback(loop, on_model_download_cancelled, state)
    callbacks["on_device_switch_failed"] = _make_state_callback(loop, on_device_switch_failed, state)
    callbacks["on_device_became_available"] = _make_state_callback(loop, on_device_became_available, state)
    callbacks["on_model_swap_started"] = _make_state_callback(loop, on_model_swap_started, state)
    callbacks["on_model_swap_completed"] = _make_state_callback(loop, on_model_swap_completed, state)
    callbacks["on_model_swap_failed"] = _make_state_callback(loop, on_model_swap_failed, state)
    callbacks["on_vad_sensitivity_adapted"] = _make_state_callback(loop, on_vad_sensitivity_adapted, state)
    callbacks["on_speaker_segments_detected"] = _make_state_callback(loop, on_speaker_segments_detected, state)
    callbacks["cancel_download_check"] = lambda: state.cancel_download_requested

    return callbacks
