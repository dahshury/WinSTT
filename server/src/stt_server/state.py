"""Mutable server state — replaces module-level globals in server.py."""

from __future__ import annotations

import argparse
import asyncio
import logging
import threading
import wave
from collections import deque
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from websockets.asyncio.server import ServerConnection

    from src.recorder import AudioToTextRecorder
    from src.recorder.domain.ports.sentence_classifier import ISentenceClassifier
    from src.stt_server.loopback import LoopbackCapture
    from src.synthesizer.domain.ports.synthesizer import ISpeechSynthesizer


@dataclass
class ServerState:
    """Encapsulates all mutable server state that was formerly module-level globals."""

    # ─── Core objects ────────────────────────────────────────────────
    args: argparse.Namespace
    loopback_capture: LoopbackCapture
    recorder: AudioToTextRecorder | None = None
    sentence_classifier: ISentenceClassifier | None = None
    synthesizer: ISpeechSynthesizer | None = None

    # ─── Configuration flags (from CLI args) ─────────────────────────
    debug_logging: bool = False
    extended_logging: bool = False
    send_recorded_chunk: bool = False
    log_incoming_chunks: bool = False
    silence_timing: bool = False
    smart_endpoint_enabled: bool = False
    detection_speed: float = 2.0

    # ─── WAV writing ─────────────────────────────────────────────────
    writechunks: str | bool = False
    wav_file: wave.Wave_write | None = None

    # ─── Silence timing heuristics ───────────────────────────────────
    hard_break_even_on_background_noise: float = 3.0
    hard_break_even_on_background_noise_min_texts: int = 3
    hard_break_even_on_background_noise_min_similarity: float = 0.99
    hard_break_even_on_background_noise_min_chars: int = 15
    text_time_deque: deque[tuple[float, str]] = field(default_factory=deque)

    # Recent audio-level samples (timestamp, normalized RMS in 0..1). Maintained
    # by ``on_audio_level`` and consumed by the noise-repetition guard in
    # ``text_processing`` — if recent levels show variance the user is still
    # speaking, so don't force-stop on transcription repetition.
    recent_audio_levels: deque[tuple[float, float]] = field(default_factory=deque)
    # Standard-deviation threshold over the noise-break window above which we
    # treat the audio as active speech and skip the force-stop. Empirically
    # speech RMS varies by >0.05; steady fan/HVAC noise is near 0.01.
    noise_break_audio_variance_threshold: float = 0.025

    # Sentence-pause durations (seconds) — runtime-mutable, hydrated from
    # ``args`` at startup but overridable via ``set_parameter`` so the
    # frontend Quality panel can expose sliders for them. text_processing
    # reads from state (not args) so changes take effect on the next
    # realtime tick without recreating the recorder.
    mid_sentence_detection_pause: float = 2.0
    end_of_sentence_detection_pause: float = 0.45
    unknown_sentence_detection_pause: float = 1.3

    # ─── Recorder lifecycle ──────────────────────────────────────────
    recorder_config: dict[str, Any] = field(default_factory=dict)
    recorder_ready: threading.Event = field(default_factory=threading.Event)
    recorder_thread: threading.Thread | None = None
    stop_recorder: bool = False
    prev_text: str = ""

    # ─── Shutdown ────────────────────────────────────────────────────
    shutdown_event: asyncio.Event | None = None
    shutdown_requested_at: float | None = None

    # ─── Download state ──────────────────────────────────────────────
    download_state: str | None = None
    cancel_download_requested: bool = False
    # Per-(model, quantization) streaming-download controllers. Lives on
    # state so the WS handlers can address an in-flight download by id
    # without a global singleton; field is None when no per-quant
    # download has ever been started this session (the registry is
    # constructed lazily by the predownload command handler).
    streaming_downloads: object | None = None

    # ─── WebSocket connections & queues ──────────────────────────────
    control_connections: set[ServerConnection] = field(default_factory=set)
    data_connections: set[ServerConnection] = field(default_factory=set)
    control_queue: asyncio.Queue[str] = field(default_factory=asyncio.Queue)
    # Widened to accept binary frames for TTS audio chunks (Server → Client).
    # JSON events stay as ``str``; TTS chunks travel as ``bytes`` framed with
    # a 4-byte length prefix + JSON metadata + raw PCM, mirroring the inbound
    # audio framing used by the data channel.
    audio_queue: asyncio.Queue[str | bytes] = field(default_factory=asyncio.Queue)

    # ─── TTS state ───────────────────────────────────────────────────
    tts_active_request_id: str | None = None
    cancel_tts_requested: bool = False
    # Install-lifecycle control flags (separate from ``cancel_tts_requested``,
    # which scopes only to in-flight synthesis). ``tts_install_paused`` is
    # polled by the downloader's ``should_pause`` callback and causes the
    # streaming loop to exit cleanly preserving the ``.partial`` file for
    # resume. ``cancel_tts_install_requested`` is polled by ``should_cancel``
    # and triggers an unlink + ``InterruptedError`` to abort the install.
    tts_install_paused: bool = False
    cancel_tts_install_requested: bool = False

    # ─── Logging ─────────────────────────────────────────────────────
    loglevel: int = logging.WARNING

    @classmethod
    def from_args(cls, args: argparse.Namespace, loopback_capture: LoopbackCapture) -> ServerState:
        """Create state from parsed CLI arguments."""
        return cls(
            args=args,
            loopback_capture=loopback_capture,
            debug_logging=args.debug,
            extended_logging=args.use_extended_logging,
            writechunks=args.write,
            log_incoming_chunks=args.logchunks,
            silence_timing=args.silence_timing,
            smart_endpoint_enabled=args.smart_endpoint,
            detection_speed=args.detection_speed,
            mid_sentence_detection_pause=args.mid_sentence_detection_pause,
            end_of_sentence_detection_pause=args.end_of_sentence_detection_pause,
            unknown_sentence_detection_pause=args.unknown_sentence_detection_pause,
        )
