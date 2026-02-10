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

_SIMPLE_EVENTS: list[str] = [
    "recording_start",
    "recording_stop",
    "vad_detect_start",
    "vad_detect_stop",
    "wakeword_detected",
    "wakeword_detection_start",
    "wakeword_detection_end",
]


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
    callbacks["cancel_download_check"] = lambda: state.cancel_download_requested

    return callbacks
