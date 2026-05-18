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

        state.synthesizer = build_synthesizer(
            cfg,
            on_progress=_on_progress,
            should_cancel=_should_cancel,
        )
        print(f"{bcolors.OKGREEN}TTS synthesizer constructed (lazy-load on first request){bcolors.ENDC}")
        return True
    except Exception as exc:
        logger.warning("Failed to construct TTS synthesizer", exc_info=True)
        print(f"{bcolors.WARNING}TTS init failed: {type(exc).__name__}: {exc}{bcolors.ENDC}")
        return False


@register_command("init_tts", pre_ready=True)
async def _handle_init_tts(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Ensure the synthesizer is constructed. Idempotent. Pre-ready safe."""
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


@register_command("shutdown_tts")
async def _handle_shutdown_tts(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Release the synthesizer's resources."""
    if state.synthesizer is not None:
        try:
            state.synthesizer.shutdown()
        except Exception:
            logger.warning("synthesizer.shutdown() raised", exc_info=True)
        state.synthesizer = None
    await ws.send(
        json.dumps({"status": "success", "type": "shutdown_tts", "request_id": data.get("request_id")})
    )


@register_command("list_tts_voices", pre_ready=True)
async def _handle_list_voices(ws: ServerConnection, state: ServerState, data: dict[str, Any]) -> None:
    """Return the static voice catalog. Doesn't require the model to be loaded."""
    from src.synthesizer.infrastructure.voice_catalog import KOKORO_VOICE_CATALOG, SUPPORTED_LANGUAGES

    voices = [
        {"id": v.id, "label": v.label, "language": v.language, "gender": v.gender}
        for v in KOKORO_VOICE_CATALOG
    ]
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
        message = json.dumps(
            {"type": "tts_failed", "request_id": request_id, "reason": "Synthesizer not initialized"}
        )
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
        _enqueue(
            state,
            loop,
            json.dumps(
                {
                    "type": "tts_failed",
                    "request_id": request_id,
                    "reason": f"{type(exc).__name__}: {exc}",
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
