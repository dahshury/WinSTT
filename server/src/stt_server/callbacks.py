"""Callback factories for the STT server — event→queue bridge."""

from __future__ import annotations

import asyncio
import base64
import json
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
        "on_model_swap_started",
        "on_model_swap_completed",
        "on_model_swap_failed",
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


def on_model_swap_failed(
    kind: str,
    name: str,
    reason: str,
    state: ServerState,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Forward a model-swap-failed event so the renderer can revert + toast.

    The previous model is still active server-side — the frontend's
    settings store should roll its picker back to whatever the server
    currently reports via ``runtime_info``.
    """
    print(f"{bcolors.WARNING}[model-swap] failed: kind={kind} name={name} reason={reason}{bcolors.ENDC}")
    message = json.dumps(
        {"type": "model_swap_failed", "kind": kind, "name": name, "reason": reason}
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
    callbacks["on_model_swap_started"] = _make_state_callback(loop, on_model_swap_started, state)
    callbacks["on_model_swap_completed"] = _make_state_callback(loop, on_model_swap_completed, state)
    callbacks["on_model_swap_failed"] = _make_state_callback(loop, on_model_swap_failed, state)
    callbacks["cancel_download_check"] = lambda: state.cancel_download_requested

    return callbacks
