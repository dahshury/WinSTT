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
import contextlib
import ctypes
import faulthandler
import json
import os
import shutil
import signal
import sys
import threading
import time
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

import websockets

from src.building_blocks.terminal import TerminalColors as bcolors
from src.building_blocks.terminal import enable_ansi_on_windows, force_utf8_stdio, format_now_hms_ms
from src.recorder import AudioToTextRecorder

# Import for side effects: registers TTS commands on the control-handler
# registry via the ``@register_command`` decorator. Must precede the
# WebSocket server starting up.
from src.stt_server import tts_handler as _tts_handler  # noqa: F401
from src.stt_server.callbacks import build_recorder_callbacks
from src.stt_server.cli import parse_arguments
from src.stt_server.control_handler import control_handler
from src.stt_server.data_handler import broadcast_audio_messages, data_handler
from src.stt_server.loopback import LoopbackCapture
from src.stt_server.observability import configure_observability
from src.stt_server.state import ServerState
from src.stt_server.text_processing import preprocess_text, text_detected

# Order matters: switch stdio to UTF-8 BEFORE any print() can fire, so
# the startup banner's box-drawing characters (┌ ─ │ …) don't crash the
# recorder thread on Windows cp1252 consoles.
force_utf8_stdio()
enable_ansi_on_windows()

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


#: Startup safety-net: the model the recorder will fall back to when the
#: user's chosen model can't be loaded (corrupted cache that can't be
#: refetched, repo removed, network down with no cache, etc.). ``tiny`` is
#: the smallest Whisper export and the most likely candidate to either be
#: already cached or to download in seconds. The fallback only kicks in
#: during startup — runtime model swaps initiated by the renderer keep
#: surfacing failures through the existing ``model_swap_failed`` path.
_STARTUP_FALLBACK_MODEL = "tiny"


def _emit_download_cancelled(
    state: ServerState,
    loop: asyncio.AbstractEventLoop,
    model_name: str,
) -> None:
    """Mirror the legacy cancellation event the renderer's modal watches for."""
    state.cancel_download_requested = False
    print(f"{bcolors.WARNING}[download] cancelled: {model_name}{bcolors.ENDC}")
    message = json.dumps({"type": "model_download_complete", "model": model_name, "cancelled": True})
    state.download_state = None
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def _emit_startup_fallback_swap_failed(
    state: ServerState,
    loop: asyncio.AbstractEventLoop,
    *,
    original: str,
    loaded: str,
    reason: str,
) -> None:
    """Inform the renderer that startup load fell back to a different model.

    Reuses the existing ``model_swap_failed`` event so the renderer's
    :file:`SwapFailureToast` lights up unchanged — the user sees the same
    "swap failed" UX they'd see for an in-session swap. The ``runtime_info``
    in :py:func:`server_ready` carries ``loaded`` as the new active model
    and the renderer's :file:`sync-active-model` hook reconciles its picker
    + settings to match.
    """
    message = json.dumps(
        {
            "type": "model_swap_failed",
            "kind": "main",
            "name": original,
            "reason": f"Failed to load {original} at startup — loaded {loaded} instead",
            "category": "unknown",
            "detail": reason,
        }
    )
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def _try_load_recorder(state: ServerState, model_name: str) -> str | None:
    """Build + warm the recorder with ``model_name``. Two-phase: construct
    first (which installs ``state.recorder`` so command dispatch can find it
    immediately), then warm in a separate try block.

    **Construct failure** (file-not-found, corrupt graph, missing fp16
    variant, ORT init failure) returns a reason string and leaves
    ``state.recorder`` cleared — the caller (``_load_recorder_with_fallback``)
    can then try the next model.

    **Warmup failure** (e.g. CUDA JIT compile error mid-warmup) returns a
    reason string but **does not clear** ``state.recorder``. The recorder
    is still usable: the first real PTT call pays the JIT cost we tried to
    front-load, but ``set_microphone`` and ``text()`` continue to dispatch
    correctly. This avoids the silent soft-brick that triggered the
    Option C architecture.

    Explicit user-cancellation (``DownloadCancelledError``) propagates so
    the caller can distinguish "the user said no" from "the file is broken".
    """
    from src.recorder.domain.errors import DownloadCancelledError

    config = {**state.recorder_config, "model": model_name}

    # ── Phase 1: construct ────────────────────────────────────────────
    # AudioToTextRecorder.__init__ is lazy; the heavy ORT session creation
    # happens inside ``construct()`` (which threads through _ensure_service).
    # Any irrecoverable failure here means the model file is unusable —
    # surface it to the fallback chain.
    try:
        recorder = AudioToTextRecorder(**config)
        recorder.construct()
    except DownloadCancelledError:
        state.recorder = None
        raise
    except Exception as exc:
        reason = f"{type(exc).__name__}: {exc}"
        print(f"{bcolors.WARNING}[startup] failed to construct '{model_name}': {reason}{bcolors.ENDC}")
        state.recorder = None
        return reason

    # Install the recorder BEFORE warmup. If warmup raises or hangs, the
    # WS command dispatcher can still find ``set_microphone`` / ``text``
    # / etc. on this object (they paying the JIT cost on first call).
    state.recorder = recorder

    # ── Phase 2: warmup ───────────────────────────────────────────────
    try:
        recorder.warmup()
    except DownloadCancelledError:
        # Cancellation here is unusual (no downloads at warmup time) but
        # honour it the same way as during construct — caller decides.
        raise
    except Exception as exc:
        reason = f"{type(exc).__name__}: {exc}"
        print(
            f"{bcolors.WARNING}[startup] warmup raised for '{model_name}': "
            f"{reason} — recorder is still installed; first PTT call will "
            f"pay the JIT cost{bcolors.ENDC}"
        )
        return reason
    return None


def _load_recorder_with_fallback(state: ServerState, loop: asyncio.AbstractEventLoop) -> bool:
    """Load the user's chosen model, falling back to ``tiny`` on failure.

    Returns True when a recorder is live (possibly on the fallback model);
    False when every candidate failed. On a successful fallback, the chosen
    fallback is persisted via :func:`persist_setting` so the next restart
    doesn't reproduce the failure, and the renderer learns about the swap
    through the ``server_ready`` payload's ``runtime_info.model`` field
    (the renderer's active-model reconciler updates the picker + toasts).

    An explicit user-initiated cancellation (:class:`DownloadCancelledError`)
    short-circuits the chain — the renderer asked for that exact cancel and
    silently swapping to a different model would be misleading.
    """
    from src.recorder.domain.errors import DownloadCancelledError
    from src.stt_server.cli import persist_setting

    user_model = state.recorder_config.get("model", "unknown")
    chain: list[str] = [user_model]
    if user_model != _STARTUP_FALLBACK_MODEL:
        chain.append(_STARTUP_FALLBACK_MODEL)

    first_failure_reason: str | None = None
    for candidate in chain:
        try:
            failure = _try_load_recorder(state, candidate)
            if failure is None:
                if candidate != user_model:
                    print(
                        f"{bcolors.WARNING}[startup] fell back to '{candidate}' "
                        f"after '{user_model}' failed{bcolors.ENDC}"
                    )
                    _emit_startup_fallback_swap_failed(
                        state,
                        loop,
                        original=user_model,
                        loaded=candidate,
                        reason=first_failure_reason or "load failed",
                    )
                persist_setting("model", candidate)
                # Keep ``state.recorder_config["model"]`` in sync with the
                # actually-loaded model so subsequent code paths (banner,
                # logs, runtime_info builders) report the right name.
                state.recorder_config["model"] = candidate
                return True
            if first_failure_reason is None:
                first_failure_reason = failure
        except DownloadCancelledError:
            _emit_download_cancelled(state, loop, candidate)
            return False

    print(
        f"{bcolors.FAIL}[startup] every candidate failed "
        f"({', '.join(chain)}) — server will run without a recorder{bcolors.ENDC}"
    )
    return False


def _broadcast_server_ready(
    state: ServerState,
    loop: asyncio.AbstractEventLoop,
    *,
    ready: bool,
    error: str | None = None,
) -> None:
    """Send a structured ``server_ready`` message to every control client.

    Replaces the legacy ``print("Recorder initialized")`` stdout-grep
    signaling Electron used to scrape for. The WS event is now the
    canonical signal — typed, race-free with broadcast, and able to
    distinguish success (``ready=True``) from total-load-failure
    (``ready=False`` with an error string).

    The payload also carries ``runtime_info`` (providers list + is_gpu +
    actually-loaded model names) so the renderer can paint an honest
    GPU/CPU chip and the model picker without a follow-up round trip.
    Late-joining clients fetch the same info via ``get_runtime_info``.
    """
    from src.stt_server.control_handler import augment_runtime_info

    msg_payload: dict[str, Any] = {"type": "server_ready", "ready": ready}
    if not ready and error:
        msg_payload["error"] = error
    if ready:
        try:
            raw_runtime_info = state.recorder.runtime_info() if state.recorder is not None else None
        except Exception:
            raw_runtime_info = None
        runtime_info = augment_runtime_info(raw_runtime_info)
        if runtime_info is not None:
            msg_payload["runtime_info"] = runtime_info
    msg = json.dumps(msg_payload)
    for ws in list(state.control_connections):
        asyncio.run_coroutine_threadsafe(ws.send(msg), loop)


def _recorder_thread(state: ServerState, loop: asyncio.AbstractEventLoop) -> None:
    """Initialize the recorder and run the text-processing loop."""
    print(f"{bcolors.OKGREEN}Initializing RealtimeSTT server with parameters:{bcolors.ENDC}")
    rows = [(k, "<callback>" if callable(v) else str(v)) for k, v in state.recorder_config.items()]
    key_w = max(len("Parameter"), *(len(k) for k, _ in rows))
    val_w = min(80, max(len("Value"), *(len(v) for _, v in rows)))
    c, e = bcolors.OKBLUE, bcolors.ENDC
    top = f"  {c}┌{'─' * (key_w + 2)}┬{'─' * (val_w + 2)}┐{e}"
    sep = f"  {c}├{'─' * (key_w + 2)}┼{'─' * (val_w + 2)}┤{e}"
    bot = f"  {c}└{'─' * (key_w + 2)}┴{'─' * (val_w + 2)}┘{e}"
    print(top)
    print(f"  {c}│{e} {'Parameter':<{key_w}} {c}│{e} {'Value':<{val_w}} {c}│{e}")
    print(sep)
    for key, val in rows:
        chunks = [val[i : i + val_w] for i in range(0, len(val), val_w)] or [""]
        print(f"  {c}│{e} {key:<{key_w}} {c}│{e} {chunks[0]:<{val_w}} {c}│{e}")
        for chunk in chunks[1:]:
            print(f"  {c}│{e} {' ' * key_w} {c}│{e} {chunk:<{val_w}} {c}│{e}")
    print(bot)
    print(f"{bcolors.OKGREEN}Loading and warming up models...{bcolors.ENDC}")
    load_ok = _load_recorder_with_fallback(state, loop)
    if not load_ok:
        # Every fallback failed (or user cancelled the original download).
        # Unblock main() so the WS servers can still accept connections,
        # broadcast a structured failure ready event so the renderer can
        # show an explicit error chip instead of an indefinite spinner.
        state.recorder_ready.set()
        _broadcast_server_ready(state, loop, ready=False, error="every model failed to load")
        return

    # Operator-readable log line. NOT used by Electron for ready
    # detection anymore — the canonical signal is the ``server_ready``
    # WS event emitted below (see :func:`_broadcast_server_ready`).
    # Renamed deliberately from the legacy "Recorder initialized"
    # phrase to break any lingering stdout greppers that might still
    # exist downstream.
    print(f"{bcolors.OKGREEN}{bcolors.BOLD}[stt-server] recorder ready{bcolors.ENDC}")
    state.recorder_ready.set()
    _broadcast_server_ready(state, loop, ready=True)

    # Capture the wav_path emitted on TranscriptionCompleted so the fullSentence
    # JSON forwarded to the renderer carries it alongside the text. Wired here
    # (rather than in callbacks.py) because the recorder's facade publishes the
    # event on its own thread, so this subscription happens on the same thread
    # as `recorder.text(process_text)` below — no cross-thread lock needed.
    from src.recorder.domain.events import TranscriptionCompleted as _TC

    last_wav_path: list[str] = [""]

    def _capture_wav(event: _TC) -> None:
        last_wav_path[0] = event.wav_path

    if state.recorder is not None:
        state.recorder.event_bus.subscribe(_TC, _capture_wav)

    def process_text(full_sentence: str) -> None:
        state.prev_text = ""
        full_sentence = preprocess_text(full_sentence)
        wav_path = last_wav_path[0]
        last_wav_path[0] = ""
        message_payload: dict[str, Any] = {"type": "fullSentence", "text": full_sentence}
        if wav_path:
            message_payload["wav_path"] = wav_path
        message = json.dumps(message_payload)
        asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)

        timestamp = format_now_hms_ms()
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
        # Defense-in-depth wrapper around ``recorder.text()``: the inner
        # ``_safe_transcribe`` already catches model-runtime exceptions
        # (ONNX RuntimeException etc.) and returns None, but anything
        # raised OUTSIDE that path (audio source loss, VAD/wake-word
        # adapter failure, an event-bus handler bug, …) would propagate
        # here and kill the recorder thread silently — the user would
        # see "Sentence: …" stop appearing and have to restart the
        # server to dictate again. Catch broadly, log, brief backoff to
        # avoid tight-spin on a permanently-broken state, then resume.
        # Consecutive failures get a longer backoff so a wholly dead
        # recorder doesn't burn CPU.
        consecutive_failures = 0
        while not state.stop_recorder:
            try:
                state.recorder.text(process_text)
                consecutive_failures = 0
            except KeyboardInterrupt:
                raise
            except Exception:
                consecutive_failures += 1
                print(
                    f"{bcolors.FAIL}[recorder-thread] text() raised "
                    f"(failure #{consecutive_failures}); continuing.{bcolors.ENDC}",
                    flush=True,
                )
                import traceback

                traceback.print_exc()
                # 0.5 s, 1 s, 2 s, 4 s, capped at 5 s. Tight enough that
                # a transient one-off feels instant, slow enough that a
                # broken model doesn't melt the CPU emitting log spam.
                time.sleep(min(0.5 * (2 ** min(consecutive_failures - 1, 4)), 5.0))
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


def _refresh_catalog_languages_in_background(state: ServerState, loop: asyncio.AbstractEventLoop) -> None:
    """Worker thread: pull fresh language metadata from HF and broadcast it.

    Runs once per server launch. On success: persists the new overlay so
    next launch is correct before the network call completes, and pushes
    the refreshed catalog out the data channel so any open settings panel
    re-renders the language dropdown without restart. All failure modes
    (no network, HF outage, missing huggingface_hub install) are logged
    at debug and swallowed — the bundled catalog plus prior overlay is a
    valid fallback.
    """
    try:
        from src.recorder.domain.catalog_overlay import load_overlay, save_overlay
        from src.recorder.domain.catalog_refresh import fetch_language_overlay
        from src.recorder.domain.model_registry import ModelCatalog
    except Exception:  # pragma: no cover - defensive
        return
    try:
        catalog = ModelCatalog()
        new_overlay = fetch_language_overlay(catalog.list_all())
    except Exception as exc:
        print(f"{bcolors.WARNING}[catalog-refresh] HF fetch failed: {type(exc).__name__}: {exc}{bcolors.ENDC}")
        return
    if not new_overlay:
        return
    existing = load_overlay()
    if existing == new_overlay:
        return
    save_overlay(new_overlay)
    # Re-build the catalog so the overlay we just wrote is reflected in
    # the broadcast payload. Sending the bundled snapshot would defeat
    # the point — settings panel would still see Arabic on Canary until
    # the user restarts the app.
    try:
        from src.stt_server.control_handler import _active_accelerator, _active_device

        refreshed = ModelCatalog()
        device = _active_device(state)
        accelerator = _active_accelerator(state)
    except Exception:
        return
    payload = json.dumps(
        {
            "type": "model_catalog_updated",
            "models": refreshed.to_dicts(device=device, accelerator=accelerator),
        },
    )
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(payload), loop)


def _resolve_log_dir(args_log_dir: str | None) -> Path | None:
    """Pick the log directory: CLI flag wins, then ``WINSTT_LOG_DIR`` env var."""
    raw = args_log_dir or os.environ.get("WINSTT_LOG_DIR")
    if not raw:
        return None
    return Path(raw).expanduser()


def _resolve_custom_models_dir(args_custom_dir: str | None) -> Path | None:
    """Pick the custom-models scan dir: CLI flag wins, then ``WINSTT_CUSTOM_MODELS_DIR`` env var.

    ``None`` (the default) tells :class:`ModelCatalog` to skip the scan
    entirely. Electron passes the userData-anchored path on launch so the
    scan and the "open custom models folder" action both target the same
    on-disk location.
    """
    raw = args_custom_dir or os.environ.get("WINSTT_CUSTOM_MODELS_DIR")
    if not raw:
        return None
    return Path(raw).expanduser()


def _resolve_release() -> str | None:
    """Read the server's own package version for Sentry's ``release`` field."""
    try:
        return f"winstt-server@{version('winstt-server')}"
    except PackageNotFoundError:
        return None


def _apply_data_dir(arg_data_dir: str | None) -> None:
    """Apply the Electron-supplied data dir BEFORE observability + recorder init.

    Honors ``--data-dir`` first, then ``$WINSTT_DATA_DIR``. When neither is
    set, no-op — the historic defaults (``%APPDATA%`` / ``~/.winstt``) stay in
    effect. Idempotent: only sets env vars when they aren't already set, so
    portable-boot.ts's earlier ``setPath`` values from the Electron main
    process always win when both have written.

    Creates the data-dir tree (``./``, ``./hf/``, ``./logs/``) so subsequent
    code that does ``Path(...).mkdir(parents=True, exist_ok=True)`` doesn't
    race on first launch under a portable install.
    """
    raw = arg_data_dir or os.environ.get("WINSTT_DATA_DIR")
    if not raw:
        return
    data_dir = Path(raw).expanduser()
    hf_dir = data_dir / "hf"
    logs_dir = data_dir / "logs"
    for d in (data_dir, hf_dir, logs_dir):
        try:
            d.mkdir(parents=True, exist_ok=True)
        except OSError:
            # Best-effort: a portable install on a read-only USB stick will
            # surface the error downstream when logging actually opens the
            # file. Don't fail boot here.
            pass
    os.environ.setdefault("WINSTT_DATA_DIR", str(data_dir))
    os.environ.setdefault("HF_HOME", str(hf_dir))
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(hf_dir))
    os.environ.setdefault("WINSTT_LOG_DIR", str(logs_dir))


async def main_async() -> None:
    """Async entry point — sets up WebSocket servers, recorder, and shutdown handling."""
    args = parse_arguments()

    # Apply the portable / Electron-supplied data-dir BEFORE observability so
    # the log file lands inside ``<data-dir>/logs`` when ``--log-dir`` wasn't
    # passed explicitly. No-op when neither ``--data-dir`` nor
    # ``WINSTT_DATA_DIR`` is set — historic defaults stay in effect.
    _apply_data_dir(getattr(args, "data_dir", None))

    # Configure logging + Sentry as early as possible so that any errors below
    # (websocket bind failures, recorder init crashes, etc.) land in the log
    # file and — if a DSN is set — also flow to Sentry. Must come before any
    # heavy imports / threading.
    configure_observability(
        log_dir=_resolve_log_dir(args.log_dir),
        debug=bool(getattr(args, "debug", False)),
        release=_resolve_release(),
    )

    # Wire the user-provided custom-models directory into the catalog
    # before any catalog construction. Idempotent module-level config —
    # subsequent ``ModelCatalog()`` calls (control_handler, bootstrap, …)
    # all see the configured directory and surface the user's bundles.
    from src.recorder.domain.model_registry import set_custom_models_dir

    custom_dir = _resolve_custom_models_dir(getattr(args, "custom_models_dir", None))
    if custom_dir is not None:
        custom_dir.mkdir(parents=True, exist_ok=True)
    set_custom_models_dir(custom_dir)

    # Seed the bundled offline base model into the HF cache before any
    # model load so the app transcribes with zero network on first run.
    # Idempotent + best-effort: a populated cache is left untouched.
    from src.recorder.infrastructure.seed_cache import seed_bundled_models

    seeded = seed_bundled_models()
    if seeded:
        print(f"{bcolors.OKGREEN}[seed] offline base model ready: {', '.join(seeded)}{bcolors.ENDC}")

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
        "init_realtime_after_seconds": args.init_realtime_after_seconds,
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
        # Diarization — facade kwargs map to DiarizationConfig.enabled / .max_speakers.
        "enable_diarization": args.enable_diarization,
        "diarization_max_speakers": args.diarization_max_speakers,
        # Handy-style on-demand mic: defaults release the device on PTT
        # idle so the OS mic-in-use indicator doesn't stay lit. Flags
        # override at boot — toggling them in settings requires a server
        # restart (handled by STARTUP_ONLY_KEYS on the renderer side).
        "always_on_microphone": args.always_on_microphone,
        "lazy_stream_close": args.lazy_stream_close,
        "lazy_close_timeout_seconds": args.lazy_close_timeout_seconds,
        # Tail-of-recording capture window for user-driven stops (PTT
        # release / toggle off). Catches trailing syllables that leave
        # the lips just after the key-up. 0 = off; matches Handy.
        "extra_recording_buffer_ms": args.extra_recording_buffer_ms,
        # Whisper-native translate (multilingual → English in a single
        # decode) + idle-unload timeout to free RAM/VRAM between sessions.
        # Both port directly from Handy's settings vocabulary.
        "translate_to_english": args.translate_to_english,
        "model_unload_timeout_seconds": (
            None if args.model_unload_timeout_seconds < 0 else args.model_unload_timeout_seconds
        ),
        "spinner": False,
        "use_microphone": True,
        # Wire dynamic-silence classification + WS broadcast off the
        # STABILIZED stream (RealtimeSTT-faithful, monotonic safetext + fresh
        # tail) instead of raw Whisper output. The raw stream was thrashing
        # the smart-endpoint classifier on every Whisper rerank, cutting
        # users off mid-thought, and feeding the renderer's preview a flickery
        # text that "removed big chunks and re-added them". Stabilized text
        # keeps the safetext floor, so the preview never regresses below the
        # confirmed prefix. The noise-repetition detector's audio-variance
        # gate is the real safety net there, not raw text growth.
        "on_realtime_transcription_stabilized": _text_detected_cb,
        **event_callbacks,
        "no_log_file": True,
        "use_extended_logging": args.use_extended_logging,
        "level": state.loglevel,
        "compute_type": args.compute_type,
        "gpu_device_index": args.gpu_device_index,
        "device": args.device,
        "handle_buffer_overflow": args.handle_buffer_overflow,
        "allowed_latency_limit": args.allowed_latency_limit,
        "backend": args.backend,
        "onnx_quantization": args.onnx_quantization,
    }

    try:
        # Disable websockets' built-in keepalive ping for localhost connections.
        # The default 20s ping_interval / 20s ping_timeout tears the connection
        # down whenever a dictation session goes idle for ~40s — and a localhost
        # link has no network to detect failures on, so the keepalive is pure
        # overhead.  The Electron client reconnects automatically if the socket
        # actually dies (e.g. because the server crashed), so we lose nothing.
        control_server = await websockets.serve(
            lambda ws: control_handler(ws, state),
            "localhost",
            args.control,
            ping_interval=None,
        )
        data_server = await websockets.serve(
            lambda ws: data_handler(ws, state),
            "localhost",
            args.data,
            ping_interval=None,
        )
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
                except Exception as e:
                    # Signal handler — keep this print-based, not logger.* (the
                    # logging subsystem may not be safe to call from a signal
                    # context). The shutdown continues regardless.
                    print(f"{bcolors.WARNING}recorder.abort() failed in SIGINT handler: {e}{bcolors.ENDC}")
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

        # Kick off a background HuggingFace refresh of the model catalog's
        # language whitelists. The bundled catalog.json snapshot was taken
        # at release; per-program-run refresh keeps the picker honest when
        # NVIDIA / openai update a model card. Failure here is silent —
        # the bundled (or last cached) overlay is always a valid fallback.
        threading.Thread(
            target=_refresh_catalog_languages_in_background,
            args=(state, loop),
            daemon=True,
            name="catalog-refresh",
        ).start()

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
    src_root = Path(__file__).resolve().parent.parent  # src/
    for cache_dir in src_root.rglob("__pycache__"):
        shutil.rmtree(cache_dir, ignore_errors=True)


def main() -> None:
    # Dump a native Python+C stack trace to stderr on SIGSEGV / SIGABRT /
    # SIGFPE / SIGBUS / SIGILL.  Without this a crash in PyAudio, CTranslate2,
    # ONNX Runtime, or any other native dependency prints only
    # "Segmentation fault" with no clue which thread or call site triggered
    # it.  Signal-safe; adds no overhead until a signal fires.
    faulthandler.enable()
    print(f"{bcolors.BOLD}{bcolors.OKCYAN}Starting server, please wait...{bcolors.ENDC}", flush=True)
    _clear_pycache()
    exit_code = 0
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        print(f"\n{bcolors.WARNING}Server interrupted by user.{bcolors.ENDC}", flush=True)
    except SystemExit as e:
        # Surface the SystemExit code so an early arg/config error doesn't look
        # like a clean shutdown to the parent process. Print the message too —
        # argparse raises SystemExit with a friendly message that's otherwise
        # lost when stdout is block-buffered for piped output.
        code = e.code if isinstance(e.code, int) else (1 if e.code else 0)
        if e.code and not isinstance(e.code, int):
            print(f"{bcolors.FAIL}SystemExit: {e.code}{bcolors.ENDC}", flush=True)
        exit_code = code
    except BaseException:
        # Print the full traceback before os._exit blows away the buffer.
        # Without this, an unhandled exception in main_async() (e.g. a crash
        # during observability / data-dir / custom-models init that runs
        # BEFORE the logger is configured) presents as a silent "exit 0" to
        # the spawning Electron process — exactly the failure mode that
        # masked the DirectML / custom-models init bug we just diagnosed.
        import traceback

        traceback.print_exc()
        sys.stderr.flush()
        sys.stdout.flush()
        exit_code = 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(exit_code)


if __name__ == "__main__":
    main()
