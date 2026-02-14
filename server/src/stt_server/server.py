"""Speech-to-Text (STT) Server with Real-Time Transcription and WebSocket Interface.

This server provides real-time speech-to-text (STT) transcription using the
RealtimeSTT library. It allows clients to connect via WebSocket to send audio
data and receive real-time transcription updates. The server supports
configurable audio recording parameters, voice activity detection (VAD), and
wake word detection. It is designed to handle continuous transcription as well
as post-recording processing, enabling real-time feedback with the option to
improve final transcription quality after the complete sentence is recognised.

Features
--------
- Real-time transcription using pre-configured or user-defined STT models.
- WebSocket-based communication for control and data handling.
- Flexible recording and transcription options, including configurable pauses
  for sentence detection.
- Supports Silero and WebRTC VAD for robust voice activity detection.

Starting the Server
-------------------
You can start the server using the command-line interface (CLI) command
``stt-server``, passing the desired configuration options::

    stt-server [OPTIONS]

WebSocket Interface
-------------------
The server supports two WebSocket connections:

1. **Control WebSocket** -- Used to send and receive commands, such as setting
   parameters or calling recorder methods.
2. **Data WebSocket** -- Used to send audio data for transcription and receive
   real-time transcription updates.

The server will broadcast real-time transcription updates to all connected
clients on the data WebSocket.
"""

from __future__ import annotations

import asyncio
import ctypes
import json
import os
import signal
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

import websockets
from colorama import init

from src.building_blocks.terminal import TerminalColors as bcolors
from src.recorder import AudioToTextRecorder
from src.stt_server.callbacks import build_recorder_callbacks
from src.stt_server.cli import parse_arguments
from src.stt_server.control_handler import control_handler
from src.stt_server.data_handler import broadcast_audio_messages, data_handler
from src.stt_server.loopback import LoopbackCapture
from src.stt_server.state import ServerState
from src.stt_server.text_processing import preprocess_text, text_detected

init()

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


def _recorder_thread(state: ServerState, loop: asyncio.AbstractEventLoop) -> None:
    """Initialize the recorder and run the text-processing loop."""
    print(f"{bcolors.OKGREEN}Initializing RealtimeSTT server with parameters:{bcolors.ENDC}")
    max_key_len = max(len(k) for k in state.recorder_config)
    separator = f"  {bcolors.OKBLUE}{'─' * (max_key_len + 2)}┬{'─' * 50}{bcolors.ENDC}"
    print(separator)
    for key, value in state.recorder_config.items():
        display_val = str(value)
        if callable(value):
            display_val = "<callback>"
        print(f"  {bcolors.OKBLUE}{key:<{max_key_len}}{bcolors.ENDC}  │ {display_val}")
    print(separator)
    try:
        state.recorder = AudioToTextRecorder(**state.recorder_config)
    except Exception as e:
        from src.recorder.domain.errors import DownloadCancelledError

        if isinstance(e, DownloadCancelledError):
            state.cancel_download_requested = False
            model_name = state.recorder_config.get("model", "unknown")
            print(f"{bcolors.WARNING}[download] cancelled: {model_name}{bcolors.ENDC}")
            message = json.dumps({"type": "model_download_complete", "model": model_name, "cancelled": True})
            state.download_state = None
            asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)
            state.recorder_ready.set()
            return
        raise
    print(f"{bcolors.OKGREEN}Models loaded, warming up CUDA kernels...{bcolors.ENDC}")
    state.recorder.warmup()
    print(f"{bcolors.OKGREEN}{bcolors.BOLD}RealtimeSTT initialized{bcolors.ENDC}")
    state.recorder_ready.set()

    # Broadcast server_ready to all connected control clients
    msg = json.dumps({"type": "server_ready"})
    for ws in list(state.control_connections):
        asyncio.run_coroutine_threadsafe(ws.send(msg), loop)

    def process_text(full_sentence: str) -> None:
        state.prev_text = ""
        full_sentence = preprocess_text(full_sentence)
        message = json.dumps({"type": "fullSentence", "text": full_sentence})
        asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)

        timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        if state.extended_logging:
            print(
                f"  [{timestamp}] Full text: {bcolors.BOLD}Sentence:{bcolors.ENDC} "
                f"{bcolors.OKGREEN}{full_sentence}{bcolors.ENDC}\n",
                flush=True,
                end="",
            )
        else:
            print(
                f"\r[{timestamp}] {bcolors.BOLD}Sentence:{bcolors.ENDC} "
                f"{bcolors.OKGREEN}{full_sentence}{bcolors.ENDC}\n",
            )

    try:
        assert state.recorder is not None
        while not state.stop_recorder:
            state.recorder.text(process_text)
    except KeyboardInterrupt:
        print(f"{bcolors.WARNING}Exiting application due to keyboard interrupt{bcolors.ENDC}")


def _persistent_watchdog(state: ServerState) -> None:
    """Force-exit if shutdown takes too long, even if signal handler was replaced."""
    while True:
        time.sleep(1)
        if state.shutdown_requested_at is not None:
            elapsed = time.monotonic() - state.shutdown_requested_at
            if elapsed > 10:
                print(f"{bcolors.FAIL}Watchdog: shutdown deadline exceeded, forcing exit.{bcolors.ENDC}")
                os._exit(1)


async def main_async() -> None:
    """Async entry point — sets up WebSocket servers, recorder, and shutdown handling."""
    args = parse_arguments()

    loopback_capture = LoopbackCapture()
    state = ServerState.from_args(args, loopback_capture)

    # Start persistent watchdog
    threading.Thread(target=_persistent_watchdog, args=(state,), daemon=True).start()

    loop = asyncio.get_event_loop()

    # Build the text_detected callback that needs both state and loop
    def _text_detected_cb(text: str) -> None:
        text_detected(text, state, loop)

    # Build recorder config from args + callbacks
    event_callbacks = build_recorder_callbacks(state, loop)
    state.recorder_config = {
        "model": args.model,
        "download_root": args.root,
        "realtime_model_type": args.rt_model,
        "language": args.lang,
        "batch_size": args.batch,
        "init_realtime_after_seconds": args.init_realtime_after_seconds,
        "realtime_batch_size": args.realtime_batch_size,
        "initial_prompt_realtime": args.initial_prompt_realtime,
        "input_device_index": args.input_device,
        "silero_sensitivity": args.silero_sensitivity,
        "silero_use_onnx": args.silero_use_onnx,
        "webrtc_sensitivity": args.webrtc_sensitivity,
        "post_speech_silence_duration": args.unknown_sentence_detection_pause,
        "min_length_of_recording": args.min_length_of_recording,
        "min_gap_between_recordings": args.min_gap_between_recordings,
        "enable_realtime_transcription": args.enable_realtime_transcription,
        "realtime_processing_pause": args.realtime_processing_pause,
        "silero_deactivity_detection": args.silero_deactivity_detection,
        "early_transcription_on_silence": args.early_transcription_on_silence,
        "beam_size": args.beam_size,
        "beam_size_realtime": args.beam_size_realtime,
        "initial_prompt": args.initial_prompt,
        "wake_words": args.wake_words,
        "wake_words_sensitivity": args.wake_words_sensitivity,
        "wake_word_timeout": args.wake_word_timeout,
        "wake_word_activation_delay": args.wake_word_activation_delay,
        "wakeword_backend": args.wakeword_backend,
        "openwakeword_model_paths": args.openwakeword_model_paths,
        "openwakeword_inference_framework": args.openwakeword_inference_framework,
        "wake_word_buffer_duration": args.wake_word_buffer_duration,
        "use_main_model_for_realtime": args.use_main_model_for_realtime,
        "spinner": False,
        "use_microphone": True,
        "on_realtime_transcription_update": _text_detected_cb,
        **event_callbacks,
        "no_log_file": True,
        "use_extended_logging": args.use_extended_logging,
        "level": state.loglevel,
        "compute_type": args.compute_type,
        "gpu_device_index": args.gpu_device_index,
        "device": args.device,
        "handle_buffer_overflow": args.handle_buffer_overflow,
        "suppress_tokens": args.suppress_tokens,
        "allowed_latency_limit": args.allowed_latency_limit,
        "faster_whisper_vad_filter": args.faster_whisper_vad_filter,
        "backend": args.backend,
        "onnx_quantization": args.onnx_quantization,
    }

    try:
        control_server = await websockets.serve(lambda ws: control_handler(ws, state), "localhost", args.control)
        data_server = await websockets.serve(lambda ws: data_handler(ws, state), "localhost", args.data)
        print(f"{bcolors.OKGREEN}Control server started on {bcolors.OKBLUE}ws://localhost:{args.control}{bcolors.ENDC}")
        print(f"{bcolors.OKGREEN}Data server started on {bcolors.OKBLUE}ws://localhost:{args.data}{bcolors.ENDC}")

        # Set up shutdown signal handling
        state.shutdown_event = asyncio.Event()
        loop = asyncio.get_running_loop()
        _shutdown_count = 0

        def _request_shutdown() -> None:
            nonlocal _shutdown_count
            _shutdown_count += 1
            if _shutdown_count >= 2:
                print(f"\n{bcolors.FAIL}Force exit.{bcolors.ENDC}")
                os._exit(1)
            state.shutdown_requested_at = time.monotonic()
            assert state.shutdown_event is not None
            state.shutdown_event.set()

        if sys.platform == "win32":

            def _win_signal_handler(_sig: int, _frame: object) -> None:
                state.stop_recorder = True
                try:
                    if state.recorder is not None:
                        state.recorder.abort()
                except Exception:
                    pass
                _request_shutdown()

            signal.signal(signal.SIGINT, _win_signal_handler)

            _CTRL_C_EVENT = 0
            _handler_type = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_ulong)

            def _raw_console_ctrl_handler(ctrl_type: int) -> int:
                if ctrl_type == _CTRL_C_EVENT:
                    _win_signal_handler(signal.SIGINT, None)
                    return 1
                return 0

            _console_ctrl_handler = _handler_type(_raw_console_ctrl_handler)
            ctypes.windll.kernel32.SetConsoleCtrlHandler(_console_ctrl_handler, 1)
        else:
            loop.add_signal_handler(signal.SIGINT, _request_shutdown)
            loop.add_signal_handler(signal.SIGTERM, _request_shutdown)

        broadcast_task = asyncio.create_task(broadcast_audio_messages(state))

        state.recorder_thread = threading.Thread(target=_recorder_thread, args=(state, loop), daemon=True)
        state.recorder_thread.start()
        await loop.run_in_executor(None, state.recorder_ready.wait)

        # Initialize sentence classifier if smart endpoint is enabled via CLI
        if args.smart_endpoint:
            try:
                from src.recorder.infrastructure.distilbert_classifier import DistilBertClassifier

                state.sentence_classifier = DistilBertClassifier()
                print(f"{bcolors.OKGREEN}Smart endpoint classifier loaded{bcolors.ENDC}")
            except Exception as e:
                print(f"{bcolors.WARNING}Failed to load smart endpoint classifier: {e}{bcolors.ENDC}")

        # Re-install Python SIGINT handler — CTranslate2 may have overridden it
        if sys.platform == "win32":
            signal.signal(signal.SIGINT, _win_signal_handler)

            def _reinstall_sigint() -> None:
                loop.call_soon_threadsafe(signal.signal, signal.SIGINT, _win_signal_handler)

            if state.recorder is not None:
                state.recorder._sigint_reinstall = _reinstall_sigint

        print(f"{bcolors.OKGREEN}Server started. Press Ctrl+C to stop the server.{bcolors.ENDC}")

        while not state.shutdown_event.is_set():
            await asyncio.sleep(0.5)

        print(f"\n{bcolors.WARNING}Server interrupted by user, shutting down...{bcolors.ENDC}")

        control_server.close()
        data_server.close()
        broadcast_task.cancel()
        await asyncio.wait_for(control_server.wait_closed(), timeout=2)
        await asyncio.wait_for(data_server.wait_closed(), timeout=2)
    except TimeoutError:
        pass
    except OSError:
        print(
            f"{bcolors.FAIL}Error: Could not start server on specified ports. "
            f"It's possible another instance of the server is already running, "
            f"or the ports are being used by another application.{bcolors.ENDC}",
        )
    finally:
        await shutdown_procedure(state)
        print(f"{bcolors.OKGREEN}Server shutdown complete.{bcolors.ENDC}")


async def shutdown_procedure(state: ServerState) -> None:
    """Gracefully shut down the recorder and cancel remaining tasks."""

    def _watchdog() -> None:
        time.sleep(8)
        print(f"{bcolors.FAIL}Shutdown deadline exceeded, forcing exit.{bcolors.ENDC}")
        os._exit(1)

    wd = threading.Thread(target=_watchdog, daemon=True)
    wd.start()

    if state.recorder and state.loopback_capture.is_active:
        state.loopback_capture.stop(state.recorder)
    if state.recorder:
        state.stop_recorder = True
        state.recorder.abort()

        if state.recorder_thread:
            state.recorder_thread.join(timeout=2)

        state.recorder.shutdown()
        print(f"{bcolors.OKGREEN}Recorder shut down{bcolors.ENDC}")

    tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


def _clear_pycache() -> None:
    """Remove all __pycache__ directories under src/ so stale .pyc files never mask source changes."""
    import shutil

    src_root = Path(__file__).resolve().parent.parent  # src/
    for cache_dir in src_root.rglob("__pycache__"):
        shutil.rmtree(cache_dir, ignore_errors=True)


def main() -> None:
    print(f"{bcolors.BOLD}{bcolors.OKCYAN}Starting server, please wait...{bcolors.ENDC}")
    _clear_pycache()
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        print(f"\n{bcolors.WARNING}Server interrupted by user.{bcolors.ENDC}")
    except SystemExit:
        pass
    finally:
        os._exit(0)


if __name__ == "__main__":
    main()
