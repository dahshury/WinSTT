"""Cloud STT adapter: proxies ``transcribe()`` to electron-main over WS.

When the user picks a cloud model (e.g. ``openai:gpt-4o-mini-transcribe``)
the facade instantiates this adapter instead of the local
:class:`OnnxAsrTranscriber`. The pipeline thread calls ``transcribe()``
synchronously; this implementation:

1. Serialises the float32 audio buffer to 16-bit PCM WAV in memory.
2. Base64-encodes the WAV bytes (control channel is JSON-only).
3. Generates a fresh ``request_id`` and sends a
   ``stt_cloud_transcribe_request`` envelope via the injected
   ``send_request`` callable (the WS server's ``broadcast_to_control``
   wrapper).
4. Blocks on a ``concurrent.futures.Future`` until the matching
   ``stt_cloud_transcribe_response`` arrives — which is resolved by the
   server's WS receive loop calling :meth:`deliver_response`.
5. Returns a :class:`TranscriptionResult`, or raises
   :class:`TranscriptionError` for typed cloud failures.

Threading model:

* ``transcribe`` runs on the pipeline thread.
* ``deliver_response`` runs on the asyncio loop thread (called from the
  WS receive coroutine).

The :class:`concurrent.futures.Future` is the cross-thread bridge — the
pipeline thread can ``.result(timeout=…)`` on it, and the asyncio thread
can ``.set_result(...)`` on it without scheduling anything back into the
pipeline's event loop. The pending-request map is guarded by a
``threading.Lock`` so the two threads can safely insert/remove entries.

API keys never touch this side — they're loaded by electron-main from
the encrypted settings store at request time and used to construct the
provider client there. Server-side only knows ``(provider, model_id)``.
"""

from __future__ import annotations

import base64
import io
import logging
import threading
import time
import uuid
import wave
from collections.abc import Callable
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from typing import Any

import numpy as np
from typing_extensions import override

from src.building_blocks.errors import TranscriptionError
from src.building_blocks.types import AudioArray
from src.recorder.domain.ports.transcriber import ITranscriber, TranscriptionResult

logger = logging.getLogger(__name__)

# Mirror the spec's ``CloudSttErrorCode`` enum. Kept as plain strings to
# avoid a dependency between the spec and this module — the spec is the
# source of truth for the wire format; this constant is the local copy
# used to identify failures coming back from electron-main.
_CLOUD_ERROR_CODES = frozenset(
    {
        "auth",
        "network",
        "rate_limit",
        "key_missing",
        "audio_too_large",
        "provider_error",
        "aborted",
        "timeout",
    }
)

# Default per-request wall-clock timeout. Cloud transcribe round-trips
# on OpenAI/ElevenLabs are typically 0.5-5 s for a 10 s utterance; 120 s
# is a hedge against a stuck network. Electron's own AbortSignal fires
# at 90 s, so this only triggers if electron itself is unresponsive
# (e.g. main process hung). When it fires we cancel the pending future
# so the pipeline returns rather than blocking forever — the
# TranscriptionError surfaces as a normal "no text" path downstream.
_DEFAULT_REQUEST_TIMEOUT_S = 120.0


# Wire-protocol envelope keys — kept here as named constants so that
# typo'd field names fail at lint time, not at runtime when a real
# cloud call fails to correlate.
_REQUEST_COMMAND = "stt_cloud_transcribe_request"
_RESPONSE_COMMAND = "stt_cloud_transcribe_response"


# ── Module-level wiring for stt_server ↔ RemoteTranscriber ──────────
#
# The recorder facade / bootstrap doesn't know about the WebSocket. The
# stt_server registers a ``cloud_sender`` here at startup; every
# RemoteTranscriber dispatches through ``dispatch_to_cloud_sender``
# which resolves the sender at call time (so a server restart that
# re-registers the callable doesn't require re-creating in-flight
# RemoteTranscribers — they just pick up the new sender on next call).
#
# Symmetrically, RemoteTranscriber instances register themselves as
# "active" on construct and clear on shutdown, so the stt_server's
# receive loop can route ``stt_cloud_transcribe_response`` envelopes
# back via :func:`deliver_cloud_response` without holding a direct
# reference.
_cloud_sender: Callable[[dict[str, Any]], None] | None = None
_active_transcriber: RemoteTranscriber | None = None
_registry_lock = threading.Lock()


def register_cloud_sender(sender: Callable[[dict[str, Any]], None] | None) -> None:
    """Install (or clear) the global cloud-STT dispatcher.

    Called by the stt_server during startup with a callable that
    schedules a JSON send onto its asyncio loop. Pass ``None`` at
    shutdown to clear the reference and surface a clear error on any
    late-arriving transcribe call.
    """
    global _cloud_sender
    with _registry_lock:
        _cloud_sender = sender


def dispatch_to_cloud_sender(envelope: dict[str, Any]) -> None:
    """Default ``send_request`` used by every RemoteTranscriber.

    Resolves the registered sender at call time so a hot-swap of the
    stt_server's send path is picked up without rebuilding the
    transcriber. Raises :class:`TranscriptionError` if no sender is
    registered — that means the server is misconfigured (cloud
    transcribers shouldn't be built without an stt_server present).
    """
    with _registry_lock:
        sender = _cloud_sender
    if sender is None:
        raise TranscriptionError(
            "No cloud sender registered; cloud STT requires the stt_server to call register_cloud_sender() at startup."
        )
    sender(envelope)


def deliver_cloud_response(response: dict[str, Any]) -> bool:
    """Server-side hook: route a response envelope to the active transcriber.

    Returns ``True`` iff a matching pending request was resolved. The
    stt_server logs unrouted responses at info level — they happen on
    stale acks after a timeout or model swap.
    """
    with _registry_lock:
        transcriber = _active_transcriber
    if transcriber is None:
        return False
    return transcriber.deliver_response(response)


def _set_active_transcriber(transcriber: RemoteTranscriber | None) -> None:
    """Register the current cloud transcriber, or clear on shutdown."""
    global _active_transcriber
    with _registry_lock:
        _active_transcriber = transcriber


@dataclass(frozen=True)
class _PendingRequest:
    """One in-flight transcribe call awaiting an electron response."""

    future: Future[dict[str, Any]]
    request_id: str
    started_at: float


def _float32_to_wav_bytes(audio: AudioArray, sample_rate: int = 16_000) -> bytes:
    """Encode a float32 numpy buffer in [-1, 1] as a 16-bit PCM WAV.

    Mono. Single-pass; the caller already has the full utterance buffered
    (this is invoked at silence-end, not mid-stream). Out-of-range samples
    are clipped — the OnnxAsr peak-normalize step usually keeps them in
    range, but the clip guard prevents a 16-bit wraparound on the rare
    overshoot.
    """
    clipped = np.clip(audio, -1.0, 1.0)
    int16 = (clipped * 32_767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)  # 16-bit
        wav.setframerate(sample_rate)
        wav.writeframes(int16.tobytes())
    return buf.getvalue()


class RemoteTranscriber(ITranscriber):
    """ITranscriber adapter that proxies to electron-main via WS RPC."""

    def __init__(
        self,
        provider: str,
        model_id: str,
        send_request: Callable[[dict[str, Any]], None] | None = None,
        *,
        request_timeout_s: float = _DEFAULT_REQUEST_TIMEOUT_S,
        sample_rate: int = 16_000,
    ) -> None:
        """Initialize a cloud-STT proxy.

        Args:
            provider: ``"openai"`` or ``"elevenlabs"``. Validated by the
                electron handler on receipt; we don't gate locally so
                future providers can be added by extending the spec
                enum without touching this file.
            model_id: Provider-native model id (e.g.
                ``"gpt-4o-mini-transcribe"``).
            send_request: Thread-safe callable that forwards a JSON
                envelope to electron-main over the control channel.
                Typically a bound method on the WS server that schedules
                the send onto the asyncio loop.
            request_timeout_s: Max wall-clock seconds to await a
                response. Defaults to 120 s; electron's own AbortSignal
                fires earlier (90 s) so this is a backstop.
            sample_rate: Sample rate of the input audio. The buffered
                pipeline operates at 16 kHz; pass the rate explicitly so
                this adapter survives a future sample-rate change.
        """
        self._provider = provider
        self._model_id = model_id
        # Default to the module-level dispatcher so bootstrap callers don't
        # need a reference to the stt_server. Tests pass an explicit callable
        # (mock) to bypass the global state.
        self._send_request = send_request if send_request is not None else dispatch_to_cloud_sender
        self._request_timeout_s = request_timeout_s
        self._sample_rate = sample_rate
        self._pending: dict[str, _PendingRequest] = {}
        self._pending_lock = threading.Lock()
        self._shutdown_event = threading.Event()
        # Register as the active transcriber so the stt_server's receive
        # loop can route response envelopes back via deliver_cloud_response.
        # Cleared on shutdown (or replaced by the next swap's transcriber).
        _set_active_transcriber(self)

    @property
    def provider(self) -> str:
        return self._provider

    @property
    def model_id(self) -> str:
        return self._model_id

    @override
    def transcribe(
        self,
        audio: AudioArray,
        language: str = "",
        use_prompt: bool = True,
        custom_words: list[str] | None = None,
        initial_prompt_text: str | None = None,
    ) -> TranscriptionResult:
        # Decoder-bias prompts are local-engine concerns; remote cloud STT
        # providers each have their own bias surface (OpenAI: ``prompt``;
        # ElevenLabs: ``vocabulary``) and we don't expose them yet. Both
        # parameters are accepted for ITranscriber signature parity and
        # ignored — server-side rapidfuzz still cleans up.
        del custom_words, initial_prompt_text
        if self._shutdown_event.is_set():
            raise TranscriptionError("RemoteTranscriber has been shut down")

        request_id = uuid.uuid4().hex
        wav_bytes = _float32_to_wav_bytes(audio, self._sample_rate)
        audio_b64 = base64.b64encode(wav_bytes).decode("ascii")

        future: Future[dict[str, Any]] = Future()
        pending = _PendingRequest(future=future, request_id=request_id, started_at=time.time())
        with self._pending_lock:
            self._pending[request_id] = pending

        envelope: dict[str, Any] = {
            "command": _REQUEST_COMMAND,
            "request_id": request_id,
            "provider": self._provider,
            "model_id": self._model_id,
            "audio_b64": audio_b64,
            "media_type": "audio/wav",
        }
        if language:
            envelope["language"] = language

        try:
            self._send_request(envelope)
        except Exception as exc:
            self._remove_pending(request_id)
            raise TranscriptionError(f"Failed to dispatch cloud transcribe: {exc}") from exc

        try:
            response = future.result(timeout=self._request_timeout_s)
        except FutureTimeoutError as exc:
            self._remove_pending(request_id)
            raise TranscriptionError(f"Cloud transcribe timed out after {self._request_timeout_s:.0f}s") from exc
        finally:
            self._remove_pending(request_id)

        return self._result_from_response(response, started_at=pending.started_at)

    def deliver_response(self, response: dict[str, Any]) -> bool:
        """Resolve the in-flight request matching ``response['request_id']``.

        Called by the WS server's receive coroutine when it sees a
        ``stt_cloud_transcribe_response`` envelope. Returns ``True`` iff
        a matching pending request was found and resolved; ``False``
        means the response was unsolicited (stale, duplicate, or after
        a timeout) and the caller should log it but not error.

        Safe to call from any thread (typically the asyncio loop).
        """
        request_id = response.get("request_id")
        if not isinstance(request_id, str):
            return False
        with self._pending_lock:
            pending = self._pending.pop(request_id, None)
        if pending is None:
            return False
        if not pending.future.done():
            pending.future.set_result(response)
        return True

    @override
    def is_ready(self) -> bool:
        # Always "ready" — the AI SDK call is per-request; there's no
        # warm-up state to track. The actual readiness gate is whether
        # the user configured an API key, but that's enforced
        # electron-side and surfaces as a ``key_missing`` error on the
        # first transcribe call rather than blocking ``is_ready``.
        return not self._shutdown_event.is_set()

    @override
    def shutdown(self) -> None:
        """Cancel every in-flight request and refuse new ones."""
        self._shutdown_event.set()
        with self._pending_lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for entry in pending:
            if not entry.future.done():
                entry.future.set_exception(TranscriptionError("RemoteTranscriber shut down with pending request"))
        # Only clear the active pointer if it's still pointing at us — a
        # newer swap may already have installed its own transcriber.
        global _active_transcriber
        with _registry_lock:
            if _active_transcriber is self:
                _active_transcriber = None

    def _remove_pending(self, request_id: str) -> None:
        with self._pending_lock:
            self._pending.pop(request_id, None)

    def _result_from_response(
        self,
        response: dict[str, Any],
        *,
        started_at: float,
    ) -> TranscriptionResult:
        if response.get("ok"):
            text = response.get("text", "")
            language = response.get("language") or ""
            duration = response.get("duration_seconds")
            elapsed = float(duration) if isinstance(duration, int | float) else time.time() - started_at
            return TranscriptionResult(
                text=str(text),
                language=str(language),
                language_probability=0.0,
                duration_seconds=elapsed,
            )
        code = response.get("error_code")
        message = response.get("error_message") or "Cloud STT failed"
        if isinstance(code, str) and code in _CLOUD_ERROR_CODES:
            logger.warning(
                "Cloud STT %s/%s failed (%s): %s",
                self._provider,
                self._model_id,
                code,
                message,
            )
            raise TranscriptionError(f"{code}: {message}")
        raise TranscriptionError(f"Cloud STT failed: {message}")
