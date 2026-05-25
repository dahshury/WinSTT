"""TTS command handlers — separate module from the giant control_handler.py.

Handles:
    - ``init_tts`` / ``shutdown_tts`` (lifecycle)
    - ``tts_synthesize`` (fire-and-forget; progress on the data channel)
    - ``tts_cancel`` (cooperative cancellation flag)
    - ``list_tts_voices`` (static catalog → JSON reply)

Wire format for streamed audio frames (server → client, data channel):

    [ uint32 metadata_length LE ][ metadata JSON UTF-8 ][ float32 PCM LE ]

    metadata = {
        "type": "tts_chunk",
        "request_id": "abc-123",
        "sample_rate": 24000,
        "seq": 0,
        "is_final": false,
        "format": "f32le",
        "channels": 1,
    }

Completion / failure ride the same channel as JSON events:

    { "type": "tts_complete", "request_id": "..." }
    { "type": "tts_failed",   "request_id": "...", "reason": "..." }
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import TYPE_CHECKING, Any

import numpy as np

from src.building_blocks.terminal import TerminalColors as bcolors
from src.stt_server.control_handler import register_command
from src.stt_server.state import ServerState

if TYPE_CHECKING:
    from websockets.asyncio.server import ServerConnection

logger = logging.getLogger(__name__)

# Module-level strong reference set: ``asyncio.create_task`` returns a Task
# whose only reference may be the running event loop's internal weakref,
# meaning the task can be garbage-collected mid-flight (RUF006). Add tasks
# here and remove them via the done-callback below.
_active_tasks: set[asyncio.Task[None]] = set()


def _enqueue(state: ServerState, loop: asyncio.AbstractEventLoop, message: str | bytes) -> None:
    """Thread-safe enqueue into the shared broadcast queue."""
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)


def _make_chunk_frame(
    request_id: str,
    audio: np.ndarray,
    sample_rate: int,
    seq: int,
    is_final: bool,
) -> bytes:
    """Pack one PCM chunk into a binary WebSocket frame."""
    metadata = {
        "type": "tts_chunk",
        "request_id": request_id,
        "sample_rate": int(sample_rate),
        "seq": seq,
        "is_final": is_final,
        "format": "f32le",
        "channels": 1,
    }
    meta_bytes = json.dumps(metadata).encode("utf-8")
    meta_len = len(meta_bytes).to_bytes(4, "little")
    pcm = np.ascontiguousarray(audio, dtype=np.float32).tobytes()
    return meta_len + meta_bytes + pcm


def _ensure_synthesizer(state: ServerState) -> bool:
    """Lazy-initialize the synthesizer on first TTS request.

    Returns True if the synthesizer is ready (or just became ready); False
    if construction failed. Errors are logged but never raised — callers
    surface a ``tts_failed`` event.
    """
    if state.synthesizer is not None:
        return True
    try:
        from src.synthesizer.bootstrap import build_synthesizer
        from src.synthesizer.domain.config import SynthesizerConfig

        cfg = SynthesizerConfig(
            enabled=True,
            cache_dir=getattr(state.args, "tts_cache_dir", None),
            voice=getattr(state.args, "tts_voice", "af_heart") or "af_heart",
            lang=getattr(state.args, "tts_lang", "en-us") or "en-us",
            speed=getattr(state.args, "tts_speed", 1.0) or 1.0,
            device=getattr(state.args, "tts_device", "auto") or "auto",
        )

        loop = asyncio.get_event_loop()

        def _on_progress(progress: float, downloaded: int, total: int) -> None:
            if progress <= 0.0:
                message = json.dumps({"type": "tts_model_download_start"})
            elif progress >= 1.0:
                message = json.dumps({"type": "tts_model_download_complete", "cancelled": False})
            else:
                message = json.dumps(
                    {
                        "type": "tts_model_download_progress",
                        "progress": progress,
                        "downloaded_bytes": downloaded,
                        "total_bytes": total,
                    }
                )
            _enqueue(state, loop, message)

        def _should_cancel() -> bool:
            return state.cancel_tts_requested

        def _on_status(phase: str) -> None:
            _enqueue(state, loop, json.dumps({"type": "tts_install_status", "phase": phase}))

        state.synthesizer = build_synthesizer(
            cfg,
            on_progress=_on_progress,
            should_cancel=_should_cancel,
            on_status=_on_status,
        )
        print(f"{bcolors.OKGREEN}TTS synthesizer constructed (lazy-load on first request){bcolors.ENDC}")
        return True
    except Exception as exc:
        logger.warning("Failed to construct TTS synthesizer", exc_info=True)
        print(f"{bcolors.WARNING}TTS init failed: {type(exc).__name__}: {exc}{bcolors.ENDC}")
        return False


async def _warm_up_synthesizer(state: ServerState, loop: asyncio.AbstractEventLoop) -> None:
    """Background task: actually download the engine pack + load the ONNX session.

    ``_ensure_synthesizer`` only builds the Python wrapper — it does not
    touch the network or load the model. Without this task the first
    user-visible failure surfaces on the very first ``tts_synthesize``,
    long after the toggle reports as enabled. Running ``warm_up`` here
    means the install progress + any failure surface immediately on the
    off→on edge, before the user clicks Play.

    Progress events flow naturally via the ``on_progress``/``on_status``
    callbacks wired in ``_ensure_synthesizer`` — this coroutine only adds
    the explicit failure event so the UI can show a Retry banner instead
    of leaving the toggle stuck in "enabled with no engine".
    """
    if state.synthesizer is None or state.synthesizer.is_ready():
        return
    try:
        await loop.run_in_executor(None, state.synthesizer.warm_up)
    except Exception as exc:
        logger.warning("TTS warm-up failed", exc_info=True)
        from src.recorder.domain.swap_errors import classify_swap_error

        info = classify_swap_error(exc)
        _enqueue(
            state,
            loop,
            json.dumps(
                {
                    "type": "tts_install_failed",
                    "reason": info.user_message,
                    "category": str(info.category),
                }
            ),
        )


@register_command("init_tts", pre_ready=True)
async def _handle_init_tts(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Ensure the synthesizer is constructed AND warm. Idempotent. Pre-ready safe.

    Two-step: ``_ensure_synthesizer`` builds the wrapper (cheap, no I/O),
    then a background task eagerly warms the engine so the download +
    progress + any failure surface immediately rather than waiting for
    the user's first ``tts_synthesize``.
    """
    ok = _ensure_synthesizer(state)
    await ws.send(
        json.dumps(
            {
                "status": "success" if ok else "error",
                "type": "init_tts",
                "ready": ok,
                "request_id": data.get("request_id"),
            }
        )
    )
    if ok:
        loop = asyncio.get_event_loop()
        task = asyncio.create_task(_warm_up_synthesizer(state, loop))
        _active_tasks.add(task)
        task.add_done_callback(_active_tasks.discard)


@register_command("shutdown_tts")
async def _handle_shutdown_tts(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Release the synthesizer's resources."""
    if state.synthesizer is not None:
        try:
            state.synthesizer.shutdown()
        except Exception:
            logger.warning("synthesizer.shutdown() raised", exc_info=True)
        state.synthesizer = None
    await ws.send(json.dumps({"status": "success", "type": "shutdown_tts", "request_id": data.get("request_id")}))


@register_command("list_tts_voices", pre_ready=True)
async def _handle_list_voices(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Return the static voice catalog. Doesn't require the model to be loaded."""
    from src.synthesizer.infrastructure.voice_catalog import KOKORO_VOICE_CATALOG, SUPPORTED_LANGUAGES

    voices = [{"id": v.id, "label": v.label, "language": v.language, "gender": v.gender} for v in KOKORO_VOICE_CATALOG]
    languages = [{"code": code, "label": label} for code, label in SUPPORTED_LANGUAGES]
    request_id = data.get("request_id")
    # Wrap the payload in ``value`` so ``SttClient.sendRequest()`` resolves the
    # pending promise correctly — it reads ``data.value`` by convention (see
    # ``resolveControlRequest`` in electron/ws/stt-client.ts). Returning the
    # fields at the top level made the renderer receive ``undefined``.
    payload: dict[str, Any] = {
        "status": "success",
        "command": "list_tts_voices",
        "value": {"voices": voices, "languages": languages},
    }
    if request_id is not None:
        payload["request_id"] = request_id
    await ws.send(json.dumps(payload))


@register_command("tts_download_estimate", pre_ready=True)
async def _handle_tts_download_estimate(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Report what enabling TTS will download — drives the confirm dialog.

    Pre-ready safe and side-effect free: it only inspects disk, never
    downloads. The renderer shows ``total_bytes`` in the confirmation
    dialog and must not send ``init_tts`` until the user accepts.
    """
    from src.synthesizer.infrastructure.support_pack import (
        ENGINE_PACK_BYTES,
        KOKORO_MODEL_BYTES,
        KOKORO_VOICES_BYTES,
        is_installed,
        resolve_runtime_dir,
    )

    cache_override = getattr(state.args, "tts_cache_dir", None)
    engine_installed = is_installed(resolve_runtime_dir())

    components: list[dict[str, Any]] = []
    if not engine_installed:
        components.append({"id": "engine", "label": "TTS engine", "bytes": ENGINE_PACK_BYTES})
    # Model/voices presence is cheap to check via the kokoro cache dir.
    from src.synthesizer.domain.config import SynthesizerConfig
    from src.synthesizer.infrastructure.asset_downloader import resolve_cache_dir

    cfg = SynthesizerConfig(cache_dir=cache_override)
    kokoro_dir = resolve_cache_dir(cfg.cache_dir)
    if not (kokoro_dir / cfg.model_filename).exists():
        components.append({"id": "model", "label": "Voice model", "bytes": KOKORO_MODEL_BYTES})
    if not (kokoro_dir / cfg.voices_filename).exists():
        components.append({"id": "voices", "label": "Voicepacks", "bytes": KOKORO_VOICES_BYTES})

    total = sum(int(c["bytes"]) for c in components)
    request_id = data.get("request_id")
    payload: dict[str, Any] = {
        "status": "success",
        "command": "tts_download_estimate",
        "value": {
            "total_bytes": total,
            "components": components,
            "already_installed": total == 0,
        },
    }
    if request_id is not None:
        payload["request_id"] = request_id
    await ws.send(json.dumps(payload))


@register_command("tts_cancel")
async def _handle_tts_cancel(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Set the cooperative cancellation flag for the active TTS request."""
    state.cancel_tts_requested = True
    await ws.send(
        json.dumps(
            {
                "status": "success",
                "type": "tts_cancel",
                "request_id": data.get("request_id"),
                "active": state.tts_active_request_id,
            }
        )
    )


async def _run_synthesis(
    state: ServerState,
    loop: asyncio.AbstractEventLoop,
    request_id: str,
    text: str,
    voice: str,
    lang: str,
    speed: float,
) -> None:
    """Background coroutine that streams audio chunks back to the client."""
    if state.synthesizer is None:
        message = json.dumps({"type": "tts_failed", "request_id": request_id, "reason": "Synthesizer not initialized"})
        _enqueue(state, loop, message)
        return

    state.cancel_tts_requested = False
    state.tts_active_request_id = request_id
    started_at = time.monotonic()
    try:
        async for chunk in state.synthesizer.synthesize_stream(text, voice, lang, speed):
            if state.cancel_tts_requested:
                _enqueue(
                    state,
                    loop,
                    json.dumps({"type": "tts_complete", "request_id": request_id, "cancelled": True}),
                )
                return
            frame = _make_chunk_frame(
                request_id=request_id,
                audio=chunk.audio,
                sample_rate=chunk.sample_rate,
                seq=chunk.seq,
                is_final=chunk.is_final,
            )
            _enqueue(state, loop, frame)
        elapsed_ms = int((time.monotonic() - started_at) * 1000)
        _enqueue(
            state,
            loop,
            json.dumps(
                {
                    "type": "tts_complete",
                    "request_id": request_id,
                    "cancelled": False,
                    "elapsed_ms": elapsed_ms,
                }
            ),
        )
    except Exception as exc:
        logger.warning("TTS synthesis failed", exc_info=True)
        # Reuse the STT swap-error classifier so an offline failure during
        # the on-demand engine/model download surfaces the same clear
        # "check your internet connection" message instead of a raw
        # "RuntimeError: Failed to download …" trace.
        from src.recorder.domain.swap_errors import classify_swap_error

        info = classify_swap_error(exc)
        _enqueue(
            state,
            loop,
            json.dumps(
                {
                    "type": "tts_failed",
                    "request_id": request_id,
                    "reason": info.user_message,
                    "category": str(info.category),
                }
            ),
        )
    finally:
        if state.tts_active_request_id == request_id:
            state.tts_active_request_id = None
        state.cancel_tts_requested = False


@register_command("tts_synthesize", pre_ready=True)
async def _handle_tts_synthesize(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Kick off a background synthesis task; reply immediately with ack.

    Pre-ready safe because TTS doesn't depend on the STT recorder being up.
    """
    request_id = str(data.get("request_id") or "")
    text = data.get("text")
    if not isinstance(text, str) or not text.strip():
        await ws.send(
            json.dumps(
                {
                    "status": "error",
                    "type": "tts_synthesize",
                    "request_id": request_id,
                    "message": "text is required",
                }
            )
        )
        return

    voice = str(data.get("voice") or "")
    lang = str(data.get("lang") or "")
    try:
        speed = float(data.get("speed") or 1.0)
    except (TypeError, ValueError):
        speed = 1.0

    if not _ensure_synthesizer(state):
        await ws.send(
            json.dumps(
                {
                    "status": "error",
                    "type": "tts_synthesize",
                    "request_id": request_id,
                    "message": "Failed to initialize TTS engine. See server logs.",
                }
            )
        )
        return

    # Ack immediately. Progress (chunks + complete/failed) streams on the
    # data channel as it happens.
    await ws.send(
        json.dumps(
            {
                "status": "success",
                "type": "tts_synthesize",
                "request_id": request_id,
                "message": "synthesis started",
            }
        )
    )

    loop = asyncio.get_event_loop()
    # Hold a strong reference to the task so it isn't garbage-collected mid-run.
    # The set self-cleans via the discard-on-done callback.
    task = asyncio.create_task(_run_synthesis(state, loop, request_id, text, voice, lang, speed))
    _active_tasks.add(task)
    task.add_done_callback(_active_tasks.discard)
