"""WebSocket control handler — processes JSON commands from clients."""

from __future__ import annotations

import asyncio
import json
import threading
from datetime import datetime
from typing import Any

import websockets
from websockets.asyncio.server import ServerConnection

from src.building_blocks.terminal import TerminalColors as bcolors
from src.building_blocks.terminal import debug_print
from src.stt_server.cli import persist_setting
from src.stt_server.file_transcribe import handle_transcribe_file
from src.stt_server.state import ServerState

# Define allowed methods and parameters for security
ALLOWED_METHODS: list[str] = [
    "set_microphone",
    "abort",
    "stop",
    "clear_audio_queue",
    "wakeup",
    "shutdown",
    "text",
]

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
]


def _log_set(name: str, value: object) -> None:
    """Print a timestamped parameter-set log line."""
    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    v = f"{value:.2f}" if isinstance(value, float) else value
    print(f"  [{ts}] {bcolors.OKGREEN}Set {name} to: {bcolors.OKBLUE}{v}{bcolors.ENDC}")


def _log_get(name: str, value: str) -> None:
    """Print a timestamped parameter-get log line."""
    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    print(f"  [{ts}] {bcolors.OKGREEN}Get {name}: {bcolors.OKBLUE}{value}{bcolors.ENDC}")


# Commands that can be handled before the recorder is ready
PRE_READY_COMMANDS: set[str] = {"list_models"}


async def control_handler(websocket: ServerConnection, state: ServerState) -> None:
    """Handle incoming control WebSocket messages."""
    debug_print(f"New control connection from {websocket.remote_address}", enabled=state.debug_logging)
    print(f"{bcolors.OKGREEN}Control client connected{bcolors.ENDC}")
    state.control_connections.add(websocket)
    if state.recorder_ready.is_set():
        await websocket.send(json.dumps({"type": "server_ready"}))
    try:
        async for message in websocket:
            msg_preview = message[:200] if isinstance(message, str) else message[:200].decode("utf-8", errors="replace")
            debug_print(f"Received control message: {msg_preview}...", enabled=state.debug_logging)
            if not state.recorder_ready.is_set():
                if isinstance(message, str):
                    try:
                        pre_data = json.loads(message)
                        if pre_data.get("command") not in PRE_READY_COMMANDS:
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
    """Route a parsed command to the appropriate handler."""
    handlers: dict[str, Any] = {
        "set_parameter": _handle_set_parameter,
        "get_parameter": _handle_get_parameter,
        "call_method": _handle_call_method,
        "transcribe_file": _handle_transcribe_file,
        "list_models": _handle_list_models,
        "list_loopback_devices": _handle_list_loopback_devices,
        "start_loopback": _handle_start_loopback,
        "stop_loopback": _handle_stop_loopback,
        "cancel_download": _handle_cancel_download,
    }
    handler = handlers.get(str(command))
    if handler is not None:
        await handler(ws, state, data)
    else:
        print(f"{bcolors.WARNING}Unknown command: {command}{bcolors.ENDC}")
        await ws.send(json.dumps({"status": "error", "message": f"Unknown command {command}"}))


# ─── Individual command handlers ─────────────────────────────────────────


async def _handle_set_parameter(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    parameter = data.get("parameter")
    value = data.get("value")

    # Server-local parameters (not on recorder)
    if parameter == "silence_timing":
        state.silence_timing = bool(value)
        _log_set("silence_timing", state.silence_timing)
        msg = f"Parameter silence_timing set to {state.silence_timing}"
        await ws.send(json.dumps({"status": "success", "message": msg}))
        return

    if parameter == "smart_endpoint_enabled":
        state.smart_endpoint_enabled = bool(value)
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
        state.detection_speed = float(value) if value is not None else 0.0
        _log_set("detection_speed", state.detection_speed)
        msg = f"Parameter detection_speed set to {state.detection_speed}"
        await ws.send(json.dumps({"status": "success", "message": msg}))
        return

    # Recorder parameters
    if parameter in ALLOWED_PARAMETERS and hasattr(state.recorder, parameter):
        setattr(state.recorder, parameter, value)
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


async def _handle_call_method(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    method_name = data.get("method")
    if method_name in ALLOWED_METHODS:
        method = getattr(state.recorder, method_name, None)
        if method and callable(method):
            args = data.get("args", [])
            kwargs = data.get("kwargs", {})
            method(*args, **kwargs)
            _log_set(f"method recorder.{method_name}", "called")
            await ws.send(json.dumps({"status": "success", "message": f"Method {method_name} called"}))
        else:
            print(f"{bcolors.WARNING}Recorder does not have method {method_name}{bcolors.ENDC}")
            await ws.send(json.dumps({"status": "error", "message": f"Recorder does not have method {method_name}"}))
    else:
        print(f"{bcolors.WARNING}Method {method_name} is not allowed{bcolors.ENDC}")
        await ws.send(json.dumps({"status": "error", "message": f"Method {method_name} is not allowed"}))


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


async def _handle_list_models(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    from src.recorder.domain.model_registry import ModelCatalog

    catalog = ModelCatalog()
    await ws.send(json.dumps({"status": "success", "command": "list_models", "models": catalog.to_dicts()}))


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


async def _handle_start_loopback(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    device_index = data.get("device_index")
    if device_index is None or state.recorder is None:
        await ws.send(json.dumps({"status": "error", "message": "Missing device_index or recorder not ready"}))
        return
    try:
        dev_info = state.loopback_capture.start(state.recorder, int(device_index))
        loop = asyncio.get_event_loop()
        message = json.dumps({"type": "loopback_started", "deviceName": dev_info.get("name", "")})
        asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)
        print(
            f"{bcolors.OKGREEN}Loopback started: "
            f"{dev_info.get('name', '')} @ {dev_info.get('defaultSampleRate', 0)}Hz"
            f"{bcolors.ENDC}",
        )
        await ws.send(json.dumps({"status": "success", "message": "Loopback started"}))
    except Exception as e:
        error_msg = f"Failed to start loopback (device {device_index}): {type(e).__name__}: {e}"
        print(f"{bcolors.FAIL}{error_msg}{bcolors.ENDC}")
        await ws.send(json.dumps({"status": "error", "message": error_msg}))


async def _handle_stop_loopback(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    if state.recorder is not None and state.loopback_capture.is_active:
        state.loopback_capture.stop(state.recorder)
        loop = asyncio.get_event_loop()
        message = json.dumps({"type": "loopback_stopped"})
        asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)
        print(f"{bcolors.OKGREEN}Loopback stopped{bcolors.ENDC}")
    await ws.send(json.dumps({"status": "success", "message": "Loopback stopped"}))


async def _handle_cancel_download(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    state.cancel_download_requested = True
    print(f"{bcolors.WARNING}[download] cancel requested by client{bcolors.ENDC}")
    await ws.send(json.dumps({"status": "success", "message": "Download cancel requested"}))
