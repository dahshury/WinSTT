"""WebSocket control handler — processes JSON commands from clients."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import websockets
from websockets.asyncio.server import ServerConnection

from src.building_blocks.terminal import TerminalColors as bcolors
from src.building_blocks.terminal import debug_print, format_now_hms_ms
from src.stt_server.cli import persist_setting
from src.stt_server.file_transcribe import handle_transcribe_file
from src.stt_server.state import ServerState

if TYPE_CHECKING:
    import pyaudio

    from src.recorder.infrastructure.streaming_downloader import StreamingDownloadRegistry

logger = logging.getLogger(__name__)


# ─── Command registry ────────────────────────────────────────────────────

CommandHandler = Callable[[ServerConnection, ServerState, dict[str, Any]], Awaitable[None]]


@dataclass(frozen=True)
class _CommandSpec:
    """Registry entry for one command name (a single handler can serve many aliases)."""

    handler: CommandHandler
    pre_ready: bool


# Populated at import time by ``@register_command`` decorators on each handler.
# Single source of truth for command dispatch AND pre-ready filtering — adding
# a new command means defining the async handler and decorating it; no second
# place to update.
_COMMAND_REGISTRY: dict[str, _CommandSpec] = {}


def register_command(
    name: str | tuple[str, ...],
    *,
    pre_ready: bool = False,
) -> Callable[[CommandHandler], CommandHandler]:
    """Decorator: register an async handler under one or more command names.

    ``pre_ready=True`` opts the command into being callable before the
    recorder has finished initialising (used for model/device listings the
    Settings UI needs to populate before the server is fully booted).
    """
    names: tuple[str, ...] = (name,) if isinstance(name, str) else name

    def _wrap(fn: CommandHandler) -> CommandHandler:
        for canonical in names:
            _COMMAND_REGISTRY[canonical] = _CommandSpec(handler=fn, pre_ready=pre_ready)
        return fn

    return _wrap


def is_pre_ready_command(name: str | None) -> bool:
    """Return whether ``name`` is one of the pre-ready commands."""
    if name is None:
        return False
    spec = _COMMAND_REGISTRY.get(name)
    return spec is not None and spec.pre_ready


# Define allowed methods and parameters for security
ALLOWED_METHODS: list[str] = [
    "set_microphone",
    "abort",
    "stop",
    "clear_audio_queue",
    "wakeup",
    "shutdown",
    "text",
    # Runtime diarization toggle — flip diarization on/off without rebooting
    # the whole server. Renderer-side ``sttRequestDiarizationToggle(bool)``
    # routes through here. The recorder facade builds/tears down the
    # diarizer on a background thread and emits ``diarization_toggle_*``
    # lifecycle events back on the data channel.
    "request_diarization_toggle",
]


def augment_runtime_info(info: dict[str, Any] | None) -> dict[str, Any] | None:
    """Augment a ``runtime_info`` dict with the live capability set.

    The renderer's stale-server canary inspects ``info.allowed_methods`` to
    decide whether the connected server build supports the protocol methods
    this frontend was built against. Without this field every fresh boot
    would trip the "STT server is outdated" toast because the canary would
    see an empty allowed-methods list and assume the server is missing
    everything.

    Returns ``None`` when ``info`` itself was ``None`` so the existing
    "couldn't read runtime_info" fallbacks stay untouched.
    """
    if info is None:
        return None
    enriched = dict(info)
    enriched["allowed_methods"] = list(ALLOWED_METHODS)
    return enriched


ALLOWED_PARAMETERS: list[str] = [
    "model",
    "language",
    "silero_sensitivity",
    "wake_word_activation_delay",
    "post_speech_silence_duration",
    "silence_endpoint_enabled",
    "listen_start",
    "recording_stop_time",
    "last_transcription_bytes",
    "last_transcription_bytes_b64",
    "speech_end_silence_start",
    "is_recording",
    "use_wake_words",
    "silence_timing",
    "enable_realtime_transcription",
    "smart_endpoint_enabled",
    "detection_speed",
    "input_device_index",
    # Server-state-owned (not on recorder) — frontend Quality panel sliders.
    "end_of_sentence_detection_pause",
    "mid_sentence_detection_pause",
    "unknown_sentence_detection_pause",
    # Deterministic post-ASR fuzzy corrector. Both are bridged through the
    # standard ``setattr(state.recorder, parameter, value)`` path because
    # the facade exposes matching properties (see ``recorder/__init__.py``).
    # ``custom_words`` accepts a list[str]; ``word_correction_threshold``
    # accepts a float clamped to ``[0.0, 1.0]`` by Pydantic.
    "custom_words",
    "word_correction_threshold",
    # Locale-aware filler / stutter cleanup (Handy port). The recorder
    # facade exposes matching ``filter_fillers`` (bool) and
    # ``custom_filler_words`` (list[str]) properties; empty list means
    # "use language-default disfluency table" — see
    # ``src/recorder/text/filler_filter.py``.
    "filter_fillers",
    "custom_filler_words",
    # Whisper-style decoder-bias prompt + its realtime variant. Both are
    # stored on the recorder config via matching properties; the renderer's
    # ``installInitialPromptSync`` (electron/lib/initial-prompt-sync.ts)
    # pushes a freshly-composed prompt on every dictionary or static-prefix
    # edit. Without these in the allowlist the renderer push gets rejected
    # with an "error" response that pollutes the debug log on every server
    # ready.
    "initial_prompt",
    "initial_prompt_realtime",
    # Hot-swappable model knobs — see facade setters in recorder/__init__.py.
    # Each one updates the recorder config and triggers an in-place
    # ``request_model_swap`` (or, for audio knobs, a ``reconfigure``) rather
    # than forcing a full server restart. Without these here the renderer
    # would have to keep them in ``STARTUP_ONLY_KEYS_LIST`` and pay the
    # ~2-5s WS-reconnect + cold-load cost on every flip.
    "onnx_quantization",
    "translate_to_english",
    "model_unload_timeout_seconds",
    "webrtc_sensitivity",
    "silero_deactivity_detection",
    "always_on_microphone",
    "lazy_stream_close",
    "lazy_close_timeout_seconds",
]

# Sentence-pause parameters that live on ``ServerState`` rather than the
# recorder facade. Routed through the server-local branch in
# ``_handle_set_parameter`` so set/get bypass the ``setattr(state.recorder, ...)``
# path that requires a recorder attribute. Tuple of (parameter name → state attr).
_STATE_FLOAT_PARAMETERS: tuple[str, ...] = (
    "end_of_sentence_detection_pause",
    "mid_sentence_detection_pause",
    "unknown_sentence_detection_pause",
)


def _active_device(state: ServerState) -> str | None:
    """Best-effort current transcription device for catalog filtering.

    Used to hide GPU-incompatible quantizations from the model picker when
    the user is actually on CUDA (sub-fp16 quants on CUDAExecutionProvider
    are slower than fp32 and can hallucinate). Reads from the live recorder
    when initialized, else from the raw recorder_config dict, else returns
    None (catalog returns full quant list — frontend shows everything).
    """
    rec = state.recorder
    if rec is not None:
        svc = getattr(rec, "_service", None)
        if svc is not None:
            cfg = getattr(svc, "_config", None)
            if cfg is not None:
                dev = getattr(cfg.transcription, "device", None)
                if isinstance(dev, str):
                    return dev
    cfg = state.recorder_config
    if isinstance(cfg, dict):
        tx = cfg.get("transcription")
        if isinstance(tx, dict):
            dev = tx.get("device")
            if isinstance(dev, str):
                return dev
    return None


def _active_accelerator(state: ServerState) -> str | None:
    """Best-effort resolved accelerator name (``"directml"`` / ``"cuda"`` /
    ``"cpu"`` / ...) for catalog filtering on DML-class EPs.

    Reads the user's ``transcription.accelerator`` (falling back to
    ``transcription.device`` for older configs), then passes it through
    :func:`resolve_accelerator` so a setting of ``"auto"`` collapses to
    the EP the runtime would actually pick — DirectML on a DML-only venv,
    CUDA on a [gpu] venv, etc.
    """
    from src.recorder.infrastructure.device import resolve_accelerator

    requested: str | None = None
    rec = state.recorder
    if rec is not None:
        svc = getattr(rec, "_service", None)
        if svc is not None:
            cfg = getattr(svc, "_config", None)
            if cfg is not None:
                acc = getattr(cfg.transcription, "accelerator", None)
                if isinstance(acc, str) and acc:
                    requested = acc
    if requested is None:
        cfg = state.recorder_config
        if isinstance(cfg, dict):
            tx = cfg.get("transcription")
            if isinstance(tx, dict):
                acc = tx.get("accelerator")
                if isinstance(acc, str) and acc:
                    requested = acc
    if requested is None:
        requested = _active_device(state) or "auto"
    return resolve_accelerator(requested)


def _log_set(name: str, value: object) -> None:
    """Print a timestamped parameter-set log line."""
    ts = format_now_hms_ms()
    v = f"{value:.2f}" if isinstance(value, float) else value
    print(f"  [{ts}] {bcolors.OKGREEN}Set {name} to: {bcolors.OKBLUE}{v}{bcolors.ENDC}")


def _log_call(name: str, args: object = None) -> None:
    """Print a timestamped method-call log line."""
    ts = format_now_hms_ms()
    suffix = f"({args})" if args else "()"
    print(f"  [{ts}] {bcolors.OKCYAN}Call recorder.{name}{suffix}{bcolors.ENDC}")


def _log_get(name: str, value: str) -> None:
    """Print a timestamped parameter-get log line."""
    ts = format_now_hms_ms()
    print(f"  [{ts}] {bcolors.OKGREEN}Get {name}: {bcolors.OKBLUE}{value}{bcolors.ENDC}")


# Sentinel for "current value could not be read" — distinct from any real value so
# the no-op-write guard in _handle_set_parameter never silently swallows a write
# whose getter raised.
_UNSET: object = object()


async def control_handler(websocket: ServerConnection, state: ServerState) -> None:
    """Handle incoming control WebSocket messages."""
    debug_print(f"New control connection from {websocket.remote_address}", enabled=state.debug_logging)
    print(f"{bcolors.OKGREEN}Control client connected{bcolors.ENDC}")
    state.control_connections.add(websocket)
    if state.recorder_ready.is_set():
        ready_payload: dict[str, Any] = {"type": "server_ready"}
        # Late-joining clients get the runtime snapshot on first hello so the
        # GPU/CPU chip doesn't have to issue an extra request to find out
        # whether the server is on CUDA / CPU / DML providers.
        try:
            if state.recorder is not None:
                ready_payload["runtime_info"] = augment_runtime_info(state.recorder.runtime_info())
        except Exception:
            logger.warning("runtime_info() failed while building server_ready payload", exc_info=True)
        await websocket.send(json.dumps(ready_payload))
    try:
        async for message in websocket:
            msg_preview = message[:200] if isinstance(message, str) else message[:200].decode("utf-8", errors="replace")
            debug_print(f"Received control message: {msg_preview}...", enabled=state.debug_logging)
            if not state.recorder_ready.is_set():
                if isinstance(message, str):
                    try:
                        pre_data = json.loads(message)
                        if not is_pre_ready_command(pre_data.get("command")):
                            continue
                    except json.JSONDecodeError:
                        continue
                else:
                    continue
            if isinstance(message, str):
                try:
                    command_data: dict[str, Any] = json.loads(message)
                    command = command_data.get("command")
                    await _dispatch_command(websocket, state, command_data, command)
                except json.JSONDecodeError as e:
                    error_msg = f"Invalid JSON command (error at position {e.pos}: {e.msg})"
                    print(f"{bcolors.WARNING}{error_msg}{bcolors.ENDC}")
                    await websocket.send(
                        json.dumps({"status": "error", "message": error_msg, "received": message[:100]})
                    )
                except Exception as e:
                    error_msg = f"Command execution failed: {type(e).__name__}: {e}"
                    print(f"{bcolors.FAIL}{error_msg}{bcolors.ENDC}")
                    await websocket.send(json.dumps({"status": "error", "message": error_msg}))
            else:
                print(f"{bcolors.WARNING}Received unknown message type on control connection{bcolors.ENDC}")
    except websockets.exceptions.ConnectionClosed as e:
        print(f"{bcolors.WARNING}Control client disconnected: {e}{bcolors.ENDC}")
    finally:
        state.control_connections.remove(websocket)


# ─── Command dispatch ────────────────────────────────────────────────────


async def _dispatch_command(
    ws: ServerConnection,
    state: ServerState,
    data: dict[str, Any],
    command: str | None,
) -> None:
    """Route a parsed command to the handler registered in ``_COMMAND_REGISTRY``."""
    spec = _COMMAND_REGISTRY.get(str(command))
    if spec is not None:
        await spec.handler(ws, state, data)
        return
    print(f"{bcolors.WARNING}Unknown command: {command}{bcolors.ENDC}")
    await ws.send(json.dumps({"status": "error", "message": f"Unknown command {command}"}))


# ─── Individual command handlers ─────────────────────────────────────────


@register_command("set_parameter")
async def _handle_set_parameter(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    parameter = data.get("parameter")
    value = data.get("value")

    # Server-local parameters (not on recorder)
    if parameter == "silence_timing":
        new_value = bool(value)
        if state.silence_timing == new_value:
            await ws.send(json.dumps({"status": "success", "message": "Parameter silence_timing unchanged"}))
            return
        state.silence_timing = new_value
        _log_set("silence_timing", state.silence_timing)
        msg = f"Parameter silence_timing set to {state.silence_timing}"
        await ws.send(json.dumps({"status": "success", "message": msg}))
        return

    if parameter == "smart_endpoint_enabled":
        new_value = bool(value)
        if state.smart_endpoint_enabled == new_value and (not new_value or state.sentence_classifier is not None):
            await ws.send(json.dumps({"status": "success", "message": "Parameter smart_endpoint_enabled unchanged"}))
            return
        state.smart_endpoint_enabled = new_value
        if state.smart_endpoint_enabled and state.sentence_classifier is None:
            try:
                from src.recorder.infrastructure.distilbert_classifier import DistilBertClassifier

                state.sentence_classifier = DistilBertClassifier()
                print(f"{bcolors.OKGREEN}Smart endpoint classifier loaded{bcolors.ENDC}")
            except Exception as e:
                error_msg = f"Failed to load classifier: {type(e).__name__}: {e}"
                print(f"{bcolors.WARNING}{error_msg}{bcolors.ENDC}")
                state.smart_endpoint_enabled = False
                await ws.send(json.dumps({"status": "error", "message": error_msg}))
                return
        _log_set("smart_endpoint_enabled", state.smart_endpoint_enabled)
        msg = f"Parameter smart_endpoint_enabled set to {state.smart_endpoint_enabled}"
        await ws.send(json.dumps({"status": "success", "message": msg}))
        return

    if parameter == "detection_speed":
        new_speed = float(value) if value is not None else 0.0
        if state.detection_speed == new_speed:
            await ws.send(json.dumps({"status": "success", "message": "Parameter detection_speed unchanged"}))
            return
        state.detection_speed = new_speed
        _log_set("detection_speed", state.detection_speed)
        msg = f"Parameter detection_speed set to {state.detection_speed}"
        await ws.send(json.dumps({"status": "success", "message": msg}))
        return

    if parameter in _STATE_FLOAT_PARAMETERS:
        new_pause = float(value) if value is not None else 0.0
        if getattr(state, parameter) == new_pause:
            await ws.send(json.dumps({"status": "success", "message": f"Parameter {parameter} unchanged"}))
            return
        setattr(state, parameter, new_pause)
        _log_set(parameter, new_pause)
        await ws.send(json.dumps({"status": "success", "message": f"Parameter {parameter} set to {new_pause}"}))
        return

    # Recorder parameters
    if parameter in ALLOWED_PARAMETERS and hasattr(state.recorder, parameter):
        try:
            current = getattr(state.recorder, parameter)
        except Exception:
            current = _UNSET
        if current == value:
            await ws.send(json.dumps({"status": "success", "message": f"Parameter {parameter} unchanged"}))
            return
        # Pre-flight: input_device_index switches go through the audio reader
        # thread asynchronously, which means any open() failure is silent from
        # the WebSocket caller's perspective. Probe is_format_supported here
        # (synchronously, on the asyncio loop — fast metadata-only call) so we
        # can refuse cleanly with an error response instead of "success" +
        # silent fallback to default. The async runtime callback is still the
        # safety net for races where the device disappears between probe and
        # actual open.
        if parameter == "input_device_index" and value is not None:
            probe_error = _probe_input_device(int(value))
            if probe_error is not None:
                logger.warning(
                    "Refusing input_device_index switch to %s — probe failed: %s",
                    value,
                    probe_error,
                )
                # Also broadcast the same "device_switch_failed" data event the
                # async path emits, so the renderer has a single channel to
                # listen on for both probe-time and open-time failures.
                event_message = json.dumps(
                    {
                        "type": "device_switch_failed",
                        "requested_index": int(value),
                        "error_message": probe_error,
                        "fallback_index": None,
                    }
                )
                asyncio.run_coroutine_threadsafe(state.audio_queue.put(event_message), asyncio.get_running_loop())
                await ws.send(
                    json.dumps(
                        {
                            "status": "error",
                            "message": f"Cannot open input device {value}: {probe_error}",
                        }
                    )
                )
                return
        setattr(state.recorder, parameter, value)
        # ``model`` is special: its setter kicks off an *async* background
        # swap that may still fail (e.g. the requested model has no export
        # for the resolved quantization). Persisting the requested name here
        # — before the swap resolves — is what poisoned
        # ``~/.winstt/server-settings.json`` with a model that never loaded,
        # so every subsequent startup re-requested it and fell back. The
        # authoritative persist for ``model`` is ``on_model_swap_completed``
        # (callbacks.py), which records the model that *actually* loaded;
        # ``on_model_swap_failed`` correctly leaves the prior value intact.
        # Synchronous params (input_device_index, sensitivities, …) are safe
        # to persist eagerly — they have no deferred failure mode.
        if parameter != "model":
            persist_setting(parameter, value)
        _log_set(f"recorder.{parameter}", value)
        await ws.send(json.dumps({"status": "success", "message": f"Parameter {parameter} set to {value}"}))
    elif parameter not in ALLOWED_PARAMETERS:
        print(f"{bcolors.WARNING}Parameter {parameter} is not allowed (set_parameter){bcolors.ENDC}")
        await ws.send(
            json.dumps({"status": "error", "message": f"Parameter {parameter} is not allowed (set_parameter)"})
        )
    else:
        print(f"{bcolors.WARNING}Parameter {parameter} does not exist (set_parameter){bcolors.ENDC}")
        await ws.send(
            json.dumps({"status": "error", "message": f"Parameter {parameter} does not exist (set_parameter)"})
        )


@register_command("get_parameter")
async def _handle_get_parameter(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    parameter = data.get("parameter")
    request_id = data.get("request_id")

    if parameter in ALLOWED_PARAMETERS and hasattr(state.recorder, parameter):
        value = getattr(state.recorder, parameter)
        value_formatted = f"{value:.2f}" if isinstance(value, float) else f"{value}"
        value_truncated = value_formatted[:39] + "\u2026" if len(value_formatted) > 40 else value_formatted
        if state.extended_logging:
            _log_get(f"recorder.{parameter}", value_truncated)
        response: dict[str, Any] = {"status": "success", "parameter": parameter, "value": value}
        if request_id is not None:
            response["request_id"] = request_id
        await ws.send(json.dumps(response))
    elif parameter not in ALLOWED_PARAMETERS:
        print(f"{bcolors.WARNING}Parameter {parameter} is not allowed (get_parameter){bcolors.ENDC}")
        await ws.send(
            json.dumps({"status": "error", "message": f"Parameter {parameter} is not allowed (get_parameter)"})
        )
    else:
        print(f"{bcolors.WARNING}Parameter {parameter} does not exist (get_parameter){bcolors.ENDC}")
        await ws.send(
            json.dumps({"status": "error", "message": f"Parameter {parameter} does not exist (get_parameter)"})
        )


@register_command("call_method")
async def _handle_call_method(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    method_name = data.get("method")
    if method_name in ALLOWED_METHODS:
        method = getattr(state.recorder, method_name, None)
        if method and callable(method):
            args = data.get("args", [])
            kwargs = data.get("kwargs", {})
            method(*args, **kwargs)
            # PTT/toggle press: a remote `set_microphone(True)` always wants to also
            # begin a listening session. Bundling here lets the renderer send one
            # WebSocket frame per record start instead of two — fewer round trips,
            # one log line, and identical semantics. Loopback callers go through
            # `recorder.set_microphone(True)` directly (not via WebSocket) and so
            # are unaffected.
            wakeup = getattr(state.recorder, "wakeup", None)
            wakeup_paired = method_name == "set_microphone" and len(args) == 1 and args[0] is True and callable(wakeup)
            if wakeup_paired and callable(wakeup):
                wakeup()
                _log_call("set_microphone+wakeup", "True")
            else:
                arg_repr = ", ".join(repr(a) for a in args) if args else None
                _log_call(method_name, arg_repr)
            await ws.send(json.dumps({"status": "success", "message": f"Method {method_name} called"}))
        else:
            print(f"{bcolors.WARNING}Recorder does not have method {method_name}{bcolors.ENDC}")
            await ws.send(json.dumps({"status": "error", "message": f"Recorder does not have method {method_name}"}))
    else:
        print(f"{bcolors.WARNING}Method {method_name} is not allowed{bcolors.ENDC}")
        await ws.send(json.dumps({"status": "error", "message": f"Method {method_name} is not allowed"}))


@register_command("transcribe_file")
async def _handle_transcribe_file(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    request_id = data.get("request_id", "")
    file_path = data.get("file_path", "")
    fmt = data.get("format", "txt")
    loop = asyncio.get_event_loop()
    threading.Thread(
        target=handle_transcribe_file,
        args=(file_path, request_id, state, loop, fmt),
        daemon=True,
    ).start()
    await ws.send(json.dumps({"status": "success", "message": "File transcription started"}))


@register_command("list_models", pre_ready=True)
async def _handle_list_models(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    from src.recorder.domain.model_registry import ModelCatalog

    catalog = ModelCatalog()
    device = _active_device(state)
    accelerator = _active_accelerator(state)
    await ws.send(
        json.dumps(
            {
                "status": "success",
                "command": "list_models",
                "models": catalog.to_dicts(device=device, accelerator=accelerator),
            }
        )
    )


def _build_models_with_state_payload(device: str | None, accelerator: str | None) -> dict[str, Any]:
    """Synchronous catalog + cache-state assembly. Runs in a worker thread.

    Walks the HF snapshot tree once per model via ``model_state_dict`` — that
    rglob is the reason this is off-loop. Returning the ``value`` dict shape
    expected by the client's ``sendRequest`` promise resolver.
    """
    from src.recorder.domain.model_registry import ModelCatalog
    from src.recorder.infrastructure.model_state import (
        model_state_dict,
        system_info_dict,
    )
    from src.recorder.infrastructure.system_info import get_system_info

    catalog = ModelCatalog()
    sys_info = get_system_info()
    return {
        "models": catalog.to_dicts(device=device, accelerator=accelerator),
        "states": [model_state_dict(m, sys_info) for m in catalog.list_all()],
        "system_info": system_info_dict(sys_info),
    }


@register_command("list_models_with_state")
async def _handle_list_models_with_state(
    ws: ServerConnection,
    state: ServerState,
    data: dict[str, Any],
) -> None:
    """Return the catalog augmented with per-model cache state and hardware fitness.

    Renderer calls this when the settings panel opens. The shape is
    ``{models: [...], states: [{id, cache, estimated_bytes, comfortable_on_gpu,
    comfortable_on_cpu}], system_info: {total_ram_bytes, gpus}}`` —
    keeping ``states`` separate from ``models`` lets the renderer
    cache the (slow-changing) catalog and only refresh the (fast-changing)
    states after a download completes.

    Catalog assembly is off-loaded to a worker thread because each entry
    rglobs the HF cache snapshot dir (twice — overall + per-quantization);
    with ~50 catalog entries that's enough disk I/O to block the control
    channel's event loop past the renderer's 10s request timeout.
    """
    request_id = data.get("request_id")
    device = _active_device(state)
    accelerator = _active_accelerator(state)
    value = await asyncio.to_thread(_build_models_with_state_payload, device, accelerator)
    # Wrap in ``value`` so SttClient.sendRequest() resolves the promise
    # with the full payload (it reads ``data.value`` by convention).
    payload: dict[str, Any] = {
        "status": "success",
        "command": "list_models_with_state",
        "value": value,
    }
    if request_id is not None:
        payload["request_id"] = request_id
    await ws.send(json.dumps(payload))


@register_command(("reload_main_model", "reload_realtime_model"))
async def _handle_reload_model(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Kick off a background model swap on the recorder.

    Accepts ``reload_main_model`` / ``reload_realtime_model``. The ``model``
    field is the new HF model id (e.g. ``"base.en"`` — onnx-asr resolves
    that against the catalog). Returns immediately; UI watches the
    ``model_download_progress`` and ``model_swap_*`` data-channel events
    for live state.
    """
    command = data.get("command", "")
    model = data.get("model")
    if not isinstance(model, str) or not model:
        await ws.send(json.dumps({"status": "error", "message": "missing or invalid 'model' field"}))
        return
    if state.recorder is None:
        await ws.send(json.dumps({"status": "error", "message": "recorder not initialized"}))
        return
    kind = "main" if command == "reload_main_model" else "realtime"
    try:
        state.recorder.request_model_swap(kind, model)
    except Exception as e:  # pragma: no cover — request_model_swap rejects unknown kinds via ValueError
        await ws.send(json.dumps({"status": "error", "message": f"{type(e).__name__}: {e}"}))
        return
    _log_call(f"request_model_swap({kind}", model + ")")
    await ws.send(json.dumps({"status": "success", "message": f"model swap requested: kind={kind} name={model}"}))


@register_command("get_runtime_info")
async def _handle_get_runtime_info(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Reply with the active ORT runtime snapshot — drives the GPU/CPU chip.

    Honest about the *live* state of inference: a CPU-only onnxruntime
    install on a CUDA-capable machine reports ``is_gpu=False`` here, even
    when ``device=cuda`` is configured. Late-joining clients can call this
    if they missed the ``server_ready`` payload's ``runtime_info`` field.
    """
    request_id = data.get("request_id")
    info: dict[str, Any] | None = None
    if state.recorder is not None:
        try:
            info = augment_runtime_info(state.recorder.runtime_info())
        except Exception as e:  # pragma: no cover — defensive
            print(f"{bcolors.WARNING}runtime_info() raised: {e}{bcolors.ENDC}")
    payload: dict[str, Any] = {"status": "success", "command": "get_runtime_info", "value": info}
    if request_id is not None:
        payload["request_id"] = request_id
    await ws.send(json.dumps(payload))


@register_command("get_custom_models_dir", pre_ready=True)
async def _handle_get_custom_models_dir(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Reply with the absolute path the server scans for custom ONNX bundles.

    Electron uses the returned path for "Open custom models folder" so both
    sides agree on the location without re-deriving it from the userData
    path twice. Returns ``None`` (JSON ``null``) when no directory has been
    configured for this run (typical in dev when the flag is unset).
    """
    from src.recorder.domain.model_registry import get_custom_models_dir

    request_id = data.get("request_id")
    directory = get_custom_models_dir()
    payload: dict[str, Any] = {
        "status": "success",
        "command": "get_custom_models_dir",
        "value": str(directory) if directory is not None else None,
    }
    if request_id is not None:
        payload["request_id"] = request_id
    await ws.send(json.dumps(payload))


@register_command("list_input_devices", pre_ready=True)
async def _handle_list_input_devices(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    request_id = data.get("request_id")
    try:
        devices = _enumerate_input_devices()
        response_payload: dict[str, Any] = {"status": "success", "value": devices}
        if request_id is not None:
            response_payload["request_id"] = request_id
        await ws.send(json.dumps(response_payload))
    except Exception as e:
        error_msg = f"Failed to list input devices: {type(e).__name__}: {e}"
        print(f"{bcolors.FAIL}{error_msg}{bcolors.ENDC}")
        error_payload: dict[str, Any] = {
            "status": "error",
            "message": error_msg,
            "value": [],
        }
        if request_id is not None:
            error_payload["request_id"] = request_id
        await ws.send(json.dumps(error_payload))


def _enumerate_input_devices() -> list[dict[str, Any]]:
    """Return PyAudio input-capable devices that we can actually open.

    Indices match what PyAudioSource passes to ``pa.open(input_device_index=...)``,
    so the Settings UI must use these — Windows MMDevice indices do NOT match.
    Default device flagged via ``get_default_input_device_info``; missing default
    (no input hardware) is non-fatal.

    Each candidate is probed with ``is_format_supported`` to confirm the
    recorder can actually open it. Without this check, drivers that report
    ``maxInputChannels > 0`` but fail at ``pa.open()`` (the ``Errno -9999
    Unanticipated host error`` family) end up listed in the UI dropdown,
    the user picks one, and the switch silently fails. ``is_format_supported``
    is the canonical PyAudio pre-flight (system_info.py:59-68 in the
    reference) — a fast metadata check, no stream is opened.

    Probing is best-effort: if it raises with anything other than ValueError
    we keep the device (better to over-list than under-list — some drivers
    return ambiguous errors on the probe but still open fine). The host API
    name is resolved so the UI can disambiguate duplicate device names
    coming from MME / DirectSound / WASAPI variants of the same hardware.

    NOTE: must import plain ``pyaudio`` (NOT ``pyaudiowpatch``). The two ship
    different bundled PortAudio builds and their device-index spaces diverge —
    pyaudiowpatch replaces WDM-KS entries with loopback entries. PyAudioSource
    opens via ``pyaudio``, so the enumeration we hand the UI must come from the
    same package or the user's pick will address a different device.

    Windows duplicates: PortAudio enumerates each physical input once per Host
    API (MME, DirectSound, WASAPI, WDM-KS), so the same mic appears 3-4 times
    in the raw list. We restrict the listing to **WASAPI** on Windows — the
    modern stack since Vista, what Windows Sound Settings shows, what every
    mainstream app (Discord/Teams/Zoom/OBS) uses, and the only one that gets
    Windows-applied AEC/AGC. Legacy duplicates (MME/DirectSound) and the
    lower-level WDM-KS path (raw driver pin names like "WO Mic Wave", plus
    stale entries for disconnected Bluetooth headsets) are filtered out. On
    non-Windows platforms PortAudio doesn't suffer this per-API duplication,
    so we keep every host API.
    """
    import pyaudio

    audio = pyaudio.PyAudio()
    try:
        try:
            default_index: int = int(audio.get_default_input_device_info()["index"])
        except Exception:
            default_index = -1

        host_api_names: dict[int, str] = {}
        windows_apis_present = False
        try:
            for h in range(audio.get_host_api_count()):
                try:
                    info: dict[str, Any] = audio.get_host_api_info_by_index(h)
                    api_name = str(info.get("name", ""))
                    host_api_names[int(info["index"])] = api_name
                    if api_name.startswith("Windows ") or api_name == "MME":
                        windows_apis_present = True
                except Exception:
                    continue
        except Exception:
            host_api_names = {}

        devices: list[dict[str, Any]] = []
        for i in range(audio.get_device_count()):
            try:
                dev: dict[str, Any] = audio.get_device_info_by_index(i)
            except Exception:
                continue
            max_input = int(dev.get("maxInputChannels", 0))
            if max_input <= 0:
                continue

            host_api_index = int(dev.get("hostApi", -1))
            api_name = host_api_names.get(host_api_index, "")
            # On Windows, only enumerate from WASAPI. Other host APIs duplicate
            # the same hardware (MME/DirectSound) or expose stale/low-level
            # entries (WDM-KS).
            if windows_apis_present and api_name != "Windows WASAPI":
                continue

            name = str(dev.get("name", f"Device {i}"))

            # Pre-flight: probe at the rate the recorder will actually open
            # at (16 kHz mono int16). If that's unsupported, also try the
            # device's reported defaultSampleRate before giving up.
            if not _device_can_open(
                audio,
                int(dev["index"]),
                preferred_channels=min(max_input, 1),
                fallback_sample_rate=int(dev.get("defaultSampleRate", 0)),
            ):
                logger.info(
                    "Skipping input device %s (%s) — failed is_format_supported probe",
                    dev.get("index"),
                    dev.get("name"),
                )
                continue

            devices.append(
                {
                    "index": int(dev["index"]),
                    "name": name,
                    "isDefault": int(dev["index"]) == default_index,
                    "defaultSampleRate": int(dev.get("defaultSampleRate", 0)),
                    "hostApi": host_api_index,
                    "hostApiName": api_name,
                    "maxInputChannels": max_input,
                }
            )
        # PortAudio's default-input-device pointer is usually an MME index on
        # Windows, so the WASAPI variant of the system default never matches
        # by raw index. Re-flag the WASAPI device that shares a name with the
        # default so the UI still highlights it.
        if windows_apis_present and not any(d["isDefault"] for d in devices) and default_index >= 0:
            with contextlib.suppress(Exception):
                default_name = str(audio.get_device_info_by_index(default_index).get("name", "")).strip().lower()
                if default_name:
                    for d in devices:
                        if str(d["name"]).strip().lower() == default_name:
                            d["isDefault"] = True
                            break
        return devices
    finally:
        audio.terminate()


def _probe_input_device(device_index: int) -> str | None:
    """Synchronous fast probe — returns None if the device is openable, else
    a human-readable reason string. Spins up a short-lived PyAudio handle
    just for the check; the recorder's own audio_interface is left alone.
    """
    try:
        import pyaudio
    except ImportError:
        return None  # No PyAudio at all → don't block; setattr will surface.

    try:
        audio = pyaudio.PyAudio()
    except Exception as e:
        return f"audio subsystem unavailable: {e}"
    try:
        try:
            info: dict[str, Any] = audio.get_device_info_by_index(device_index)
        except Exception as e:
            return f"device index {device_index} not found ({e})"
        max_input = int(info.get("maxInputChannels", 0))
        if max_input <= 0:
            return f"device {info.get('name', device_index)!r} is not an input device"
        if not _device_can_open(
            audio,
            device_index,
            preferred_channels=min(max_input, 1),
            fallback_sample_rate=int(info.get("defaultSampleRate", 0)),
        ):
            return (
                f"device {info.get('name', device_index)!r} reports input channels "
                "but does not accept the recorder's format (16 kHz int16 mono)"
            )
        return None
    finally:
        with contextlib.suppress(Exception):
            audio.terminate()


def _device_can_open(
    audio: pyaudio.PyAudio,
    device_index: int,
    *,
    preferred_channels: int,
    fallback_sample_rate: int,
) -> bool:
    """Return True iff ``device_index`` can be opened for input by us.

    Tries 16 kHz first (the recorder's target rate) then the device's
    reported default rate. ``is_format_supported`` raises ValueError with
    a PortAudio error code on unsupported configurations (see PyAudio
    reference src/pyaudio.py:888-940). Any other exception type is treated
    as a probe failure rather than a hard reject — drivers occasionally
    surface non-ValueError noise during probing while still being openable.
    """
    import pyaudio

    channels = max(1, preferred_channels)
    candidate_rates: list[int] = [16000]
    if fallback_sample_rate and fallback_sample_rate not in candidate_rates:
        candidate_rates.append(fallback_sample_rate)

    saw_value_error = False
    for rate in candidate_rates:
        try:
            if audio.is_format_supported(
                rate,
                input_device=device_index,
                input_channels=channels,
                input_format=pyaudio.paInt16,
            ):
                return True
        except ValueError:
            saw_value_error = True
            continue
        except Exception:
            # Probe itself crashed — be lenient, see docstring.
            return True
    return not saw_value_error


@register_command("list_loopback_devices")
async def _handle_list_loopback_devices(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    request_id = data.get("request_id")
    try:
        devices = state.loopback_capture.list_devices()
        response_payload: dict[str, Any] = {"status": "success", "value": devices}
        if request_id is not None:
            response_payload["request_id"] = request_id
        await ws.send(json.dumps(response_payload))
    except Exception as e:
        error_msg = f"Failed to list loopback devices: {type(e).__name__}: {e}"
        print(f"{bcolors.FAIL}{error_msg}{bcolors.ENDC}")
        error_payload: dict[str, Any] = {
            "status": "error",
            "message": error_msg,
            "value": [],
        }
        if request_id is not None:
            error_payload["request_id"] = request_id
        await ws.send(json.dumps(error_payload))


@register_command("start_loopback")
async def _handle_start_loopback(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    device_index = data.get("device_index")
    if device_index is None or state.recorder is None:
        await ws.send(json.dumps({"status": "error", "message": "Missing device_index or recorder not ready"}))
        return
    # loopback_capture.start() does the recorder cold-init (VAD + transcriber
    # + diarizer + opens PyAudio loopback stream) — multi-second on cold
    # cache. Running it inline freezes the asyncio loop -> no WS message
    # can be processed -> the whole UI hangs (same antipattern that bit
    # TTS, see memory). Offload to a thread and post the WS response back
    # via run_coroutine_threadsafe, mirroring _handle_transcribe_file.
    idx = int(device_index)
    loop = asyncio.get_event_loop()
    # Capture the recorder reference now that we've narrowed it above; the
    # inner closure can't carry mypy narrowing across the function boundary.
    recorder = state.recorder

    def _start_loopback_sync() -> None:
        try:
            dev_info = state.loopback_capture.start(recorder, idx)
            started = json.dumps({"type": "loopback_started", "deviceName": dev_info.get("name", "")})
            asyncio.run_coroutine_threadsafe(state.audio_queue.put(started), loop)
            asyncio.run_coroutine_threadsafe(
                ws.send(json.dumps({"status": "success", "message": "Loopback started"})),
                loop,
            )
            print(
                f"{bcolors.OKGREEN}Loopback started: "
                f"{dev_info.get('name', '')} @ {dev_info.get('defaultSampleRate', 0)}Hz"
                f"{bcolors.ENDC}",
            )
        except Exception as exc:
            error_msg = f"Failed to start loopback (device {idx}): {type(exc).__name__}: {exc}"
            print(f"{bcolors.FAIL}{error_msg}{bcolors.ENDC}")
            asyncio.run_coroutine_threadsafe(
                ws.send(json.dumps({"status": "error", "message": error_msg})),
                loop,
            )

    threading.Thread(target=_start_loopback_sync, daemon=True, name="loopback-start").start()
    # Ack immediately so the renderer knows the request was accepted; the
    # real success/error follows from the worker thread above.
    await ws.send(json.dumps({"status": "pending", "message": "Loopback starting..."}))


@register_command("stop_loopback")
async def _handle_stop_loopback(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    # Stop should be near-instant (stream.close + thread.join), but mirror the
    # start path's defensive offload so any rare slow PyAudio teardown never
    # blocks the event loop either.
    loop = asyncio.get_event_loop()

    def _stop_loopback_sync() -> None:
        try:
            if state.recorder is not None and state.loopback_capture.is_active:
                state.loopback_capture.stop(state.recorder)
                asyncio.run_coroutine_threadsafe(
                    state.audio_queue.put(json.dumps({"type": "loopback_stopped"})),
                    loop,
                )
                print(f"{bcolors.OKGREEN}Loopback stopped{bcolors.ENDC}")
            asyncio.run_coroutine_threadsafe(
                ws.send(json.dumps({"status": "success", "message": "Loopback stopped"})),
                loop,
            )
        except Exception as exc:
            error_msg = f"Failed to stop loopback: {type(exc).__name__}: {exc}"
            print(f"{bcolors.FAIL}{error_msg}{bcolors.ENDC}")
            asyncio.run_coroutine_threadsafe(
                ws.send(json.dumps({"status": "error", "message": error_msg})),
                loop,
            )

    threading.Thread(target=_stop_loopback_sync, daemon=True, name="loopback-stop").start()


@register_command("cancel_download")
async def _handle_cancel_download(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    state.cancel_download_requested = True
    print(f"{bcolors.WARNING}[download] cancel requested by client{bcolors.ENDC}")
    await ws.send(json.dumps({"status": "success", "message": "Download cancel requested"}))


@register_command("get_live_resources", pre_ready=True)
async def _handle_get_live_resources(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Return a fresh live host-resource snapshot (RAM / CPU / per-GPU VRAM).

    ``pre_ready=True`` so the Settings panel can render resource badges
    before the recorder has finished loading its initial model. The
    snapshot is cached for ~1 s (see ``live_resources`` module) so a
    picker that renders 40 rows doesn't fan out 40 nvidia-smi probes.
    ``force_refresh`` (boolean) bypasses the cache — wired for a manual
    refresh button.
    """
    from src.recorder.infrastructure.live_resources import get_live_resources, live_resources_dict

    request_id = data.get("request_id")
    force = bool(data.get("force_refresh", False))
    snapshot = get_live_resources(force_refresh=force)
    payload: dict[str, Any] = {
        "status": "success",
        "command": "get_live_resources",
        "value": live_resources_dict(snapshot),
    }
    if request_id is not None:
        payload["request_id"] = request_id
    await ws.send(json.dumps(payload))


def _current_loaded_for_assess(state: ServerState) -> tuple[str | None, str | None, str | None, str | None]:
    """Best-effort: pull currently loaded main/realtime + quants for fit assess.

    Falls back to (None, None, None, None) when the recorder isn't up yet
    (pre-ready dispatch). The renderer side already knows about the user's
    most recent choice via settings store, but the *server* truth — what's
    actually resident in memory — is what fit-assessment needs.
    """
    rec = state.recorder
    if rec is None:
        return (None, None, None, None)
    try:
        info = rec.runtime_info()
    except Exception:
        logger.warning("runtime_info() failed while building assess context", exc_info=True)
        return (None, None, None, None)
    return (
        info.get("model"),
        info.get("onnx_quantization") or "",
        info.get("realtime_model"),
        info.get("realtime_quantization") or "",
    )


@register_command("assess_dictation_model_fit", pre_ready=True)
async def _handle_assess_dictation_model_fit(
    ws: ServerConnection,
    state: ServerState,
    data: dict[str, Any],
) -> None:
    """Return a server-authoritative fit assessment for a dictation candidate.

    Inputs (in ``data``):
      - ``model_id`` (required)
      - ``quantization`` (default "")
      - ``device`` (optional; "cpu"/"auto"/None)

    Replies with the wire-format dict from ``dictation_fit_dict``. Pre-ready
    so the Settings panel can fetch verdicts before any model is loaded.
    """
    from src.recorder.domain.model_registry import ModelCatalog
    from src.recorder.infrastructure.fit_assessment import (
        assess_dictation_fit,
        dictation_fit_dict,
    )
    from src.recorder.infrastructure.live_resources import get_live_resources

    request_id = data.get("request_id")
    model_id = data.get("model_id")
    if not isinstance(model_id, str) or not model_id:
        await ws.send(json.dumps({"status": "error", "message": "missing or invalid 'model_id' field"}))
        return
    quantization = data.get("quantization", "")
    if not isinstance(quantization, str):
        quantization = ""
    requested_device = data.get("device")
    if requested_device is not None and not isinstance(requested_device, str):
        requested_device = None

    loaded_main, loaded_main_quant, loaded_realtime, loaded_realtime_quant = _current_loaded_for_assess(state)
    catalog = ModelCatalog()
    live = get_live_resources()
    assessment = assess_dictation_fit(
        model_id,
        catalog=catalog,
        candidate_quant=quantization,
        requested_device=requested_device,
        loaded_main=loaded_main,
        loaded_main_quant=loaded_main_quant,
        loaded_realtime=loaded_realtime,
        loaded_realtime_quant=loaded_realtime_quant,
        live=live,
    )
    payload: dict[str, Any] = {
        "status": "success",
        "command": "assess_dictation_model_fit",
        "value": dictation_fit_dict(assessment),
    }
    if request_id is not None:
        payload["request_id"] = request_id
    await ws.send(json.dumps(payload))


@register_command("assess_ollama_model_fit", pre_ready=True)
async def _handle_assess_ollama_model_fit(
    ws: ServerConnection,
    state: ServerState,
    data: dict[str, Any],
) -> None:
    """Return a fit assessment for an Ollama LLM of ``size_bytes`` on top of STT.

    The verdict accounts for whatever dictation models are currently
    loaded — the Ollama dialog needs this so an Ollama recommendation
    stacked on top of a large Whisper doesn't get green-lit.
    """
    from src.recorder.domain.model_registry import ModelCatalog
    from src.recorder.infrastructure.fit_assessment import (
        assess_ollama_fit,
        ollama_fit_dict,
    )
    from src.recorder.infrastructure.live_resources import get_live_resources

    request_id = data.get("request_id")
    size_bytes = data.get("size_bytes", 0)
    try:
        size_int = int(size_bytes)
    except (TypeError, ValueError):
        await ws.send(json.dumps({"status": "error", "message": "invalid 'size_bytes' field"}))
        return

    loaded_main, loaded_main_quant, loaded_realtime, loaded_realtime_quant = _current_loaded_for_assess(state)
    catalog = ModelCatalog()
    live = get_live_resources()
    assessment = assess_ollama_fit(
        size_int,
        catalog=catalog,
        loaded_main=loaded_main,
        loaded_main_quant=loaded_main_quant,
        loaded_realtime=loaded_realtime,
        loaded_realtime_quant=loaded_realtime_quant,
        live=live,
    )
    payload: dict[str, Any] = {
        "status": "success",
        "command": "assess_ollama_model_fit",
        "value": ollama_fit_dict(assessment),
    }
    if request_id is not None:
        payload["request_id"] = request_id
    await ws.send(json.dumps(payload))


@register_command("delete_model_cache", pre_ready=True)
async def _handle_delete_model_cache(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Delete the HF cache directory for ``data["model_id"]`` and broadcast invalidation.

    Lets the renderer offer a "Discard" button for partial downloads: the
    next cache probe will report ``not_cached`` and the UI clears the
    paused-at-X% state. ``pre_ready=True`` so the user can wipe a partial
    download even before the recorder is fully booted (the catalog lookup
    works without it).
    """
    from src.recorder.domain.model_registry import ModelCatalog
    from src.recorder.infrastructure.model_cache import delete_cache, resolve_hf_repo

    model_id = data.get("model_id") or data.get("model")
    if not isinstance(model_id, str) or not model_id:
        await ws.send(json.dumps({"status": "error", "message": "missing or invalid 'model_id' field"}))
        return
    catalog = ModelCatalog()
    info = catalog.get(model_id)
    # NeMo / GigaAM / whisper-base catalog entries carry an onnx-asr short
    # alias (e.g. "nemo-canary-1b-v2") instead of "org/repo". Resolve via
    # onnx-asr's mapping table — without this, every "Discard" on a NeMo
    # model used to bail out with "no HF repo".
    hf_repo = resolve_hf_repo(info.onnx_model_name if info else None)
    if info is None or hf_repo is None:
        await ws.send(json.dumps({"status": "error", "message": f"no HF repo for model '{model_id}'"}))
        return
    removed = delete_cache(hf_repo)
    print(f"{bcolors.WARNING}[cache] delete requested for {model_id} (removed={removed}){bcolors.ENDC}")
    # Broadcast invalidation so any open settings panel re-fetches state.
    loop = asyncio.get_event_loop()
    cache_message = json.dumps({"type": "model_cache_changed", "model_id": model_id})
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(cache_message), loop)
    await ws.send(json.dumps({"status": "success", "message": f"cache deleted: {model_id}", "removed": removed}))


def _enqueue_streaming_event(state: ServerState, payload: dict[str, Any]) -> None:
    """Push a streaming-download event onto the data queue from a worker thread.

    Threading: the streaming downloader runs on a daemon thread, so we
    can't ``await audio_queue.put()`` directly. ``run_coroutine_threadsafe``
    schedules the put on the asyncio event loop that owns the queue.
    Best-effort — if the loop is gone (e.g. shutdown in flight) the
    exception is logged and the worker thread continues.
    """
    try:
        loop = asyncio.get_event_loop()
        asyncio.run_coroutine_threadsafe(state.audio_queue.put(json.dumps(payload)), loop)
    except Exception:
        logger.exception("Failed to enqueue streaming download event: %s", payload.get("type"))


def _ensure_streaming_registry(state: ServerState) -> StreamingDownloadRegistry:
    """Lazily construct + return the per-quant download registry.

    Kept lazy so the import of :mod:`streaming_downloader` only happens
    for users who actually trigger a download — boot stays fast for the
    bundled offline base. Registry persists across pauses so the same
    DownloadController (and its events) survive multiple pause/resume
    cycles within one session.
    """
    from src.recorder.infrastructure.streaming_downloader import StreamingDownloadRegistry

    if state.streaming_downloads is None:
        state.streaming_downloads = StreamingDownloadRegistry()
    # ``state.streaming_downloads`` is typed as ``object | None`` on the
    # dataclass to avoid importing ``StreamingDownloadRegistry`` at
    # state-module load time (keeps the lazy-import policy intact). The
    # branch above guarantees the value is the right type.
    assert isinstance(state.streaming_downloads, StreamingDownloadRegistry)
    return state.streaming_downloads


def _streaming_progress_sink(state: ServerState) -> Callable[[str, str, int, int, float], None]:
    """Return the per-chunk progress callback wired into the audio queue.

    Mirrors the legacy ``model_download_progress`` payload shape so the
    renderer's existing listener (electron/ws/contract.ts) accepts it
    without schema changes. ``quantization`` is an addition that the
    renderer reads to route the bytes to the correct badge — older
    clients ignore unknown keys.
    """

    def _on_progress(model: str, quant: str, downloaded: int, total: int, speed: float) -> None:
        progress = (downloaded / total) if total > 0 else 0.0
        _enqueue_streaming_event(
            state,
            {
                "type": "model_download_progress",
                "model": model,
                "quantization": quant,
                "progress": progress,
                "downloaded_bytes": downloaded,
                "total_bytes": total,
                "speed_bps": speed,
            },
        )

    return _on_progress


def _streaming_completion_sink(state: ServerState) -> Callable[[str, str, str], None]:
    """Return the per-download completion callback. ``outcome`` is one of
    ``"completed"`` / ``"paused"`` / ``"cancelled"`` / ``"error"`` — the
    renderer auto-closes its dialog only on ``"completed"``."""

    def _on_done(model: str, quant: str, outcome: str) -> None:
        _enqueue_streaming_event(
            state,
            {
                "type": "model_download_complete",
                "model": model,
                "quantization": quant,
                "outcome": outcome,
                # Legacy field kept for the older renderer listener path.
                "cancelled": outcome == "cancelled",
            },
        )
        # Tell the picker to refresh per-quant cache dots — completion
        # may have promoted "partial" → "cached" or wiped a partial on cancel.
        _enqueue_streaming_event(state, {"type": "model_cache_changed", "model_id": model})

    return _on_done


@register_command("predownload_model_quant", pre_ready=True)
async def _handle_predownload_model_quant(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Kick off a byte-level pause/resume capable download for one (model, quant).

    Distinct from the legacy "swap model" flow which restarts the server
    with new CLI args and lets ``onnx_asr.load_model()`` download as a
    side effect of model load. This command downloads into the HF cache
    WITHOUT changing the currently-loaded model — so the WS connection
    stays alive and the user can pause / resume / cancel mid-stream.

    Once the download completes, the renderer issues the normal
    ``set_parameter("model", ...)`` to actually swap — which is a fast
    no-network restart because the files are already cached.
    """
    from src.recorder.domain.model_registry import ModelCatalog
    from src.recorder.infrastructure.model_cache import resolve_hf_repo
    from src.recorder.infrastructure.streaming_downloader import start_streaming_download

    model_id = data.get("model_id") or data.get("model")
    if not isinstance(model_id, str) or not model_id:
        await ws.send(json.dumps({"status": "error", "message": "missing or invalid 'model_id' field"}))
        return
    quantization_raw = data.get("quantization", "")
    if not isinstance(quantization_raw, str):
        await ws.send(json.dumps({"status": "error", "message": "invalid 'quantization' field"}))
        return

    info = ModelCatalog().get(model_id)
    hf_repo = resolve_hf_repo(info.onnx_model_name if info else None)
    if info is None or hf_repo is None:
        await ws.send(json.dumps({"status": "error", "message": f"no HF repo for model '{model_id}'"}))
        return

    registry = _ensure_streaming_registry(state)
    _enqueue_streaming_event(
        state,
        {"type": "model_download_start", "model": model_id, "quantization": quantization_raw},
    )
    controller = start_streaming_download(
        registry,
        hf_repo,
        model_id,
        quantization_raw,
        _streaming_progress_sink(state),
        _streaming_completion_sink(state),
    )
    if controller is None:
        await ws.send(json.dumps({"status": "error", "message": "failed to resolve download metadata"}))
        return
    await ws.send(
        json.dumps(
            {
                "status": "success",
                "message": f"download started: {model_id}@{quantization_raw or 'default'}",
            }
        )
    )


@register_command("download_pause", pre_ready=True)
async def _handle_download_pause(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Pause an in-flight per-quant download. .partial files are preserved
    on disk and a subsequent ``download_resume`` picks up from the current
    byte offset via HTTP Range."""
    model_id = data.get("model_id") or data.get("model")
    quantization = data.get("quantization", "")
    if not isinstance(model_id, str) or not isinstance(quantization, str):
        await ws.send(json.dumps({"status": "error", "message": "invalid pause payload"}))
        return
    registry = _ensure_streaming_registry(state)
    controller = registry.get(model_id, quantization)
    if controller is None:
        await ws.send(json.dumps({"status": "error", "message": "no active download for that quant"}))
        return
    controller.request_pause()
    await ws.send(json.dumps({"status": "success", "message": "download paused"}))


@register_command("download_resume", pre_ready=True)
async def _handle_download_resume(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Resume a paused per-quant download. Same dispatch as the predownload
    handler — start_streaming_download is idempotent for the not-running
    case and resolves from on-disk .partial offsets."""
    await _handle_predownload_model_quant(ws, state, data)


@register_command("download_cancel_quant", pre_ready=True)
async def _handle_download_cancel_quant(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Cancel an in-flight per-quant download. The worker thread sees the
    cancel flag, the inner ``download_with_progress`` primitive unlinks
    the .partial of the file currently streaming, and the controller's
    completion event fires with outcome=``"cancelled"``. To also clear
    previously-completed files, follow with ``delete_model_quantization``."""
    model_id = data.get("model_id") or data.get("model")
    quantization = data.get("quantization", "")
    if not isinstance(model_id, str) or not isinstance(quantization, str):
        await ws.send(json.dumps({"status": "error", "message": "invalid cancel payload"}))
        return
    registry = _ensure_streaming_registry(state)
    controller = registry.get(model_id, quantization)
    if controller is None:
        await ws.send(json.dumps({"status": "error", "message": "no active download for that quant"}))
        return
    controller.request_cancel()
    await ws.send(json.dumps({"status": "success", "message": "download cancel requested"}))


@register_command("delete_model_quantization", pre_ready=True)
async def _handle_delete_model_quantization(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Delete ONLY the weight files for one ``(model_id, quantization)`` tuple.

    Powers the per-quant trash icon on the picker. The whole-repo
    :func:`delete_model_cache` is destructive for users who keep multiple
    precisions of the same model cached; this command surgically removes
    a single variant (e.g. delete Cohere fp16 while keeping Cohere q4)
    and rebroadcasts ``model_cache_changed`` so the picker's per-quant
    cache dots refresh. ``pre_ready=True`` matches the sibling handler.
    """
    from src.recorder.domain.model_registry import ModelCatalog
    from src.recorder.infrastructure.model_cache import delete_cache_by_quantization, resolve_hf_repo

    model_id = data.get("model_id") or data.get("model")
    if not isinstance(model_id, str) or not model_id:
        await ws.send(json.dumps({"status": "error", "message": "missing or invalid 'model_id' field"}))
        return
    quantization_raw = data.get("quantization", "")
    # An empty string is the catalog's "default precision" — that's a valid
    # variant id, not a missing field — so we only reject non-string types.
    if not isinstance(quantization_raw, str):
        await ws.send(json.dumps({"status": "error", "message": "invalid 'quantization' field"}))
        return
    catalog = ModelCatalog()
    info = catalog.get(model_id)
    hf_repo = resolve_hf_repo(info.onnx_model_name if info else None)
    if info is None or hf_repo is None:
        await ws.send(json.dumps({"status": "error", "message": f"no HF repo for model '{model_id}'"}))
        return
    removed = delete_cache_by_quantization(hf_repo, quantization_raw)
    print(
        f"{bcolors.WARNING}[cache] per-quant delete requested for "
        f"{model_id}@{quantization_raw or 'default'} (removed={removed}){bcolors.ENDC}"
    )
    loop = asyncio.get_event_loop()
    cache_message = json.dumps({"type": "model_cache_changed", "model_id": model_id})
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(cache_message), loop)
    await ws.send(
        json.dumps(
            {
                "status": "success",
                "message": f"quantization cache deleted: {model_id}@{quantization_raw or 'default'}",
                "removed": removed,
            }
        )
    )
