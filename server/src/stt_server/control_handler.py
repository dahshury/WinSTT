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


def _log_call(name: str, args: object = None) -> None:
    """Print a timestamped method-call log line."""
    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    suffix = f"({args})" if args else "()"
    print(f"  [{ts}] {bcolors.OKCYAN}Call recorder.{name}{suffix}{bcolors.ENDC}")


def _log_get(name: str, value: str) -> None:
    """Print a timestamped parameter-get log line."""
    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    print(f"  [{ts}] {bcolors.OKGREEN}Get {name}: {bcolors.OKBLUE}{value}{bcolors.ENDC}")


# Sentinel for "current value could not be read" — distinct from any real value so
# the no-op-write guard in _handle_set_parameter never silently swallows a write
# whose getter raised.
_UNSET: object = object()

# Commands that can be handled before the recorder is ready
PRE_READY_COMMANDS: set[str] = {"list_models", "list_input_devices"}


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
        "list_input_devices": _handle_list_input_devices,
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
        if state.smart_endpoint_enabled == new_value and (
            not new_value or state.sentence_classifier is not None
        ):
            await ws.send(
                json.dumps({"status": "success", "message": "Parameter smart_endpoint_enabled unchanged"})
            )
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

    # Recorder parameters
    if parameter in ALLOWED_PARAMETERS and hasattr(state.recorder, parameter):
        try:
            current = getattr(state.recorder, parameter)
        except Exception:
            current = _UNSET
        if current == value:
            await ws.send(
                json.dumps({"status": "success", "message": f"Parameter {parameter} unchanged"})
            )
            return
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
            # PTT/toggle press: a remote `set_microphone(True)` always wants to also
            # begin a listening session. Bundling here lets the renderer send one
            # WebSocket frame per record start instead of two — fewer round trips,
            # one log line, and identical semantics. Loopback callers go through
            # `recorder.set_microphone(True)` directly (not via WebSocket) and so
            # are unaffected.
            wakeup = getattr(state.recorder, "wakeup", None)
            wakeup_paired = (
                method_name == "set_microphone" and len(args) == 1 and args[0] is True and callable(wakeup)
            )
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
    """Return PyAudio input-capable devices (the index space the recorder uses).

    Indices match what PyAudioSource passes to ``pa.open(input_device_index=...)``,
    so the Settings UI must use these — Windows MMDevice indices do NOT match.
    Default device flagged via ``get_default_input_device_info``; missing default
    (no input hardware) is non-fatal.

    NOTE: must import plain ``pyaudio`` (NOT ``pyaudiowpatch``). The two ship
    different bundled PortAudio builds and their device-index spaces diverge —
    pyaudiowpatch replaces WDM-KS entries with loopback entries. PyAudioSource
    opens via ``pyaudio``, so the enumeration we hand the UI must come from the
    same package or the user's pick will address a different device.
    """
    import pyaudio

    audio = pyaudio.PyAudio()
    try:
        try:
            default_index: int = int(audio.get_default_input_device_info()["index"])
        except Exception:
            default_index = -1
        devices: list[dict[str, Any]] = []
        for i in range(audio.get_device_count()):
            try:
                dev: dict[str, Any] = audio.get_device_info_by_index(i)
            except Exception:
                continue
            if int(dev.get("maxInputChannels", 0)) <= 0:
                continue
            devices.append(
                {
                    "index": int(dev["index"]),
                    "name": str(dev.get("name", f"Device {i}")),
                    "isDefault": int(dev["index"]) == default_index,
                    "defaultSampleRate": int(dev.get("defaultSampleRate", 0)),
                    "hostApi": int(dev.get("hostApi", -1)),
                    "maxInputChannels": int(dev.get("maxInputChannels", 0)),
                }
            )
        return devices
    finally:
        audio.terminate()


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
