"""Kokoro-82M ONNX adapter for :class:`ISpeechSynthesizer`.

Wraps ``kokoro_onnx.Kokoro`` from the ``thewh1teagle/kokoro-onnx`` Python
package. Loads lazily on first ``synthesize_stream`` call so the server
boot path stays fast when TTS is disabled. Mirrors the STT side's policy
of falling back to CPU when the CUDA execution provider can't be loaded.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from typing_extensions import override

from src.synthesizer.domain.config import SynthesizerConfig
from src.synthesizer.domain.ports.synthesizer import (
    ISpeechSynthesizer,
    SynthesisChunk,
    VoiceInfo,
)
from src.synthesizer.infrastructure.asset_downloader import ensure_assets, resolve_cache_dir
from src.synthesizer.infrastructure.voice_catalog import KOKORO_VOICE_CATALOG

if TYPE_CHECKING:
    from kokoro_onnx import Kokoro

logger = logging.getLogger(__name__)


class KokoroSynthesizer(ISpeechSynthesizer):
    """ONNX-only Kokoro TTS adapter.

    Thread-safety: the underlying ``kokoro_onnx.Kokoro.create_stream`` is
    not documented to be re-entrant. We serialize concurrent stream
    requests behind ``_synth_lock`` so two near-simultaneous hotkey
    presses don't crash the ORT session.
    """

    _config: SynthesizerConfig
    _kokoro: Kokoro | None
    _ready: bool
    _synth_lock: threading.Lock
    _on_progress: object | None
    _should_cancel: object | None

    def __init__(self, config: SynthesizerConfig) -> None:
        self._config = config
        self._kokoro = None
        self._ready = False
        self._synth_lock = threading.Lock()
        self._on_progress = None
        self._should_cancel = None

    def attach_download_callbacks(
        self,
        on_progress: object,
        should_cancel: object,
    ) -> None:
        """Plug in the same lifecycle callbacks the STT side uses for downloads.

        Called from bootstrap right after construction. Stored as untyped
        objects because the concrete callback signature lives in the
        ``stt_server`` layer and we don't want to import that here.
        """
        self._on_progress = on_progress
        self._should_cancel = should_cancel

    def _resolve_provider(self) -> str:
        """Pick the ORT execution provider.

        Mirrors the STT-side ``device.resolve_device`` policy: "auto" tries
        CUDA first and falls back to CPU on import / DLL failure; "cuda"
        and "cpu" pin explicitly.
        """
        wanted = self._config.device.lower()
        if wanted == "cpu":
            return "CPUExecutionProvider"
        try:
            import onnxruntime

            providers = onnxruntime.get_available_providers()
        except Exception:
            return "CPUExecutionProvider"
        if "CUDAExecutionProvider" in providers and wanted in ("auto", "cuda"):
            return "CUDAExecutionProvider"
        return "CPUExecutionProvider"

    def _ensure_loaded(self) -> None:
        """Lazy-load the ONNX session + voicepacks on first use."""
        if self._kokoro is not None:
            return
        cache_dir = resolve_cache_dir(self._config.cache_dir)
        # The callbacks are typed at the call site but kept opaque here.
        model_path, voices_path = ensure_assets(
            cache_dir,
            self._config.model_filename,
            self._config.voices_filename,
            on_progress=self._on_progress,  # type: ignore[arg-type]
            should_cancel=self._should_cancel,  # type: ignore[arg-type]
        )
        provider = self._resolve_provider()
        # kokoro-onnx selects its ORT execution provider from the
        # ``ONNX_PROVIDER`` environment variable (see kokoro_onnx.__init__:
        # it defaults to CPU, then overrides with [ONNX_PROVIDER] when set).
        # The constructor does NOT accept ``providers`` / ``session_options``
        # kwargs — passing them raises TypeError. So we steer the provider
        # via the env var instead.
        os.environ["ONNX_PROVIDER"] = provider
        try:
            from kokoro_onnx import Kokoro

            self._kokoro = Kokoro(str(model_path), str(voices_path))
        except ImportError as exc:
            raise RuntimeError(
                "kokoro-onnx is not installed. Run `uv sync --extra cpu --extra tts` (or `--extra gpu --extra tts`)."
            ) from exc
        except Exception:
            # CUDA EP can fail to come up (missing CUDA DLLs, driver mismatch).
            # Retry pinned to CPU so TTS still works — mirrors the STT side's
            # graceful CUDA→CPU demotion.
            if provider != "CPUExecutionProvider":
                logger.warning("Kokoro init on %s failed; retrying on CPU", provider, exc_info=True)
                os.environ["ONNX_PROVIDER"] = "CPUExecutionProvider"
                from kokoro_onnx import Kokoro

                self._kokoro = Kokoro(str(model_path), str(voices_path))
            else:
                raise
        self._ready = True

    @override
    async def synthesize_stream(
        self,
        text: str,
        voice: str,
        lang: str,
        speed: float,
    ) -> AsyncIterator[SynthesisChunk]:
        """Yield audio chunks per sentence as Kokoro emits them."""
        # Resolve effective parameters with sensible fallbacks to config defaults.
        effective_voice = voice or self._config.voice
        effective_lang = lang or self._config.lang
        # Clamp speed to the same range the config allows.
        effective_speed = max(0.5, min(2.0, speed if speed > 0 else self._config.speed))

        # Trim to avoid the known phoneme-overflow IndexError on long input;
        # Kokoro's own splitter handles sentences, but we cap total length
        # defensively. Practical max for a single synthesize call is well
        # under 10 KB of text.
        text = text.strip()
        if not text:
            return
        if len(text) > 8_000:
            text = text[:8_000]

        # Hold the lock for the whole stream — Kokoro sessions are not
        # designed to be interleaved across coroutines.
        async with _AsyncLock(self._synth_lock):
            # ``_ensure_loaded`` does a ~190 MB blocking HTTP download on
            # first use plus a multi-second ORT session create. Running it
            # inline would freeze the asyncio event loop for the whole
            # download (no progress events, no other WS traffic). Offload
            # to the default thread-pool executor so the loop stays live
            # and the ``_on_progress`` callback (which posts back via
            # ``run_coroutine_threadsafe``) can actually flush frames.
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, self._ensure_loaded)
            kokoro = self._kokoro
            if kokoro is None:  # pragma: no cover - defensive
                raise RuntimeError("Kokoro failed to initialize")

            stream = kokoro.create_stream(
                text,
                voice=effective_voice,
                speed=effective_speed,
                lang=effective_lang,
            )
            seq = 0
            last: tuple[Any, int] | None = None
            async for samples, sample_rate in stream:
                if last is not None:
                    prev_samples, prev_sr = last
                    yield SynthesisChunk(
                        audio=prev_samples,
                        sample_rate=prev_sr,
                        seq=seq,
                        is_final=False,
                    )
                    seq += 1
                last = (samples, sample_rate)
            if last is not None:
                final_samples, final_sr = last
                yield SynthesisChunk(
                    audio=final_samples,
                    sample_rate=final_sr,
                    seq=seq,
                    is_final=True,
                )

    @override
    def list_voices(self) -> list[VoiceInfo]:
        return list(KOKORO_VOICE_CATALOG)

    @override
    def is_ready(self) -> bool:
        return self._ready

    @override
    def shutdown(self) -> None:
        # kokoro_onnx exposes no explicit close; relying on GC plus session
        # teardown when the ORT session is dereferenced.
        self._kokoro = None
        self._ready = False


class _AsyncLock:
    """Adapt a threading.Lock into an async context manager.

    Used because the Kokoro session isn't async-safe but our call site is.
    """

    def __init__(self, lock: threading.Lock) -> None:
        self._lock = lock

    async def __aenter__(self) -> None:
        # Acquire non-blocking with a quick yield loop so the asyncio loop
        # doesn't stall if a synth is already in flight.
        import asyncio

        while not self._lock.acquire(blocking=False):
            await asyncio.sleep(0.01)

    async def __aexit__(self, *_: object) -> None:
        self._lock.release()
