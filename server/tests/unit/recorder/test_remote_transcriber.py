"""Unit tests for the RemoteTranscriber cloud adapter.

The adapter is in `infrastructure/` and is excluded from coverage by the
project's pytest config, but the cross-thread Future bridge and the WAV
encoder are fiddly enough that they deserve their own tests — both
exercise threading primitives that are hard to debug in integration
without a quick local check.
"""

from __future__ import annotations

import base64
import io
import threading
import wave
from typing import Any

import numpy as np
import pytest

from src.building_blocks.errors import TranscriptionError
from src.recorder.infrastructure.remote_transcriber import (
    RemoteTranscriber,
    _float32_to_wav_bytes,
)


def _silence(seconds: float = 0.1, sample_rate: int = 16_000) -> np.ndarray:
    """Generate a silent float32 buffer of the requested duration."""
    return np.zeros(int(seconds * sample_rate), dtype=np.float32)


def test_float32_to_wav_bytes_produces_valid_wav() -> None:
    audio = _silence(0.05)
    wav_bytes = _float32_to_wav_bytes(audio, sample_rate=16_000)
    with wave.open(io.BytesIO(wav_bytes)) as wav:
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2  # 16-bit
        assert wav.getframerate() == 16_000
        assert wav.getnframes() == audio.shape[0]


def test_float32_to_wav_bytes_clips_out_of_range_samples() -> None:
    # A sample at 2.0 would wrap when cast to int16 — clip should rescue it.
    audio = np.array([2.0, -2.0, 0.5, -0.5], dtype=np.float32)
    wav_bytes = _float32_to_wav_bytes(audio)
    with wave.open(io.BytesIO(wav_bytes)) as wav:
        frames = wav.readframes(wav.getnframes())
    samples = np.frombuffer(frames, dtype=np.int16)
    assert samples[0] == 32_767  # +1.0 clip max
    assert samples[1] == -32_767  # -1.0 clip min (we don't dip below -32767)


def test_transcribe_sends_envelope_with_required_fields() -> None:
    sent: list[dict[str, Any]] = []

    def send(envelope: dict[str, Any]) -> None:
        sent.append(envelope)

    transcriber = RemoteTranscriber(
        provider="openai",
        model_id="gpt-4o-mini-transcribe",
        send_request=send,
    )

    # Run transcribe on a background thread so the main thread can deliver
    # the response (deliver_response → set_result on the Future).
    result_holder: list[Any] = []

    def run() -> None:
        result_holder.append(transcriber.transcribe(_silence(0.05), language="en"))

    worker = threading.Thread(target=run)
    worker.start()

    # Wait for the envelope to be sent.
    for _ in range(100):
        if sent:
            break
        threading.Event().wait(0.01)

    assert len(sent) == 1
    envelope = sent[0]
    assert envelope["command"] == "stt_cloud_transcribe_request"
    assert envelope["provider"] == "openai"
    assert envelope["model_id"] == "gpt-4o-mini-transcribe"
    assert envelope["media_type"] == "audio/wav"
    assert envelope["language"] == "en"
    assert isinstance(envelope["request_id"], str) and len(envelope["request_id"]) > 0
    # Audio is base64-encoded; round-trip to confirm it decodes to bytes.
    decoded = base64.b64decode(envelope["audio_b64"])
    assert len(decoded) > 44  # WAV header is 44 bytes + at least one sample

    # Deliver a successful response.
    delivered = transcriber.deliver_response(
        {
            "command": "stt_cloud_transcribe_response",
            "request_id": envelope["request_id"],
            "ok": True,
            "text": "hello world",
            "language": "en",
        }
    )
    assert delivered is True

    worker.join(timeout=2.0)
    assert not worker.is_alive()
    [result] = result_holder
    assert result.text == "hello world"
    assert result.language == "en"


def test_transcribe_raises_on_error_response() -> None:
    sent: list[dict[str, Any]] = []
    transcriber = RemoteTranscriber("openai", "gpt-4o-mini-transcribe", sent.append)

    result_holder: list[Any] = []
    error_holder: list[Exception] = []

    def run() -> None:
        try:
            result_holder.append(transcriber.transcribe(_silence(0.05)))
        except TranscriptionError as exc:  # pragma: no cover - filtered by assert below
            error_holder.append(exc)

    worker = threading.Thread(target=run)
    worker.start()
    for _ in range(100):
        if sent:
            break
        threading.Event().wait(0.01)
    transcriber.deliver_response(
        {
            "command": "stt_cloud_transcribe_response",
            "request_id": sent[0]["request_id"],
            "ok": False,
            "error_code": "auth",
            "error_message": "Invalid API key",
        }
    )
    worker.join(timeout=2.0)

    assert not result_holder
    assert len(error_holder) == 1
    assert "auth" in str(error_holder[0])
    assert "Invalid API key" in str(error_holder[0])


def test_deliver_response_returns_false_for_unknown_request_id() -> None:
    transcriber = RemoteTranscriber("openai", "whisper-1", send_request=lambda _: None)
    assert (
        transcriber.deliver_response(
            {
                "command": "stt_cloud_transcribe_response",
                "request_id": "ghost",
                "ok": True,
                "text": "",
            }
        )
        is False
    )


def test_shutdown_cancels_pending_requests() -> None:
    sent: list[dict[str, Any]] = []
    transcriber = RemoteTranscriber("openai", "whisper-1", sent.append)
    error_holder: list[Exception] = []

    def run() -> None:
        try:
            transcriber.transcribe(_silence(0.05))
        except TranscriptionError as exc:
            error_holder.append(exc)

    worker = threading.Thread(target=run)
    worker.start()
    for _ in range(100):
        if sent:
            break
        threading.Event().wait(0.01)

    transcriber.shutdown()
    worker.join(timeout=2.0)
    assert len(error_holder) == 1


def test_transcribe_rejects_after_shutdown() -> None:
    transcriber = RemoteTranscriber("openai", "whisper-1", send_request=lambda _: None)
    transcriber.shutdown()
    with pytest.raises(TranscriptionError):
        transcriber.transcribe(_silence(0.05))
    assert transcriber.is_ready() is False


def test_transcribe_timeout_raises_transcription_error() -> None:
    sent: list[dict[str, Any]] = []
    transcriber = RemoteTranscriber(
        "openai",
        "whisper-1",
        sent.append,
        request_timeout_s=0.05,
    )
    with pytest.raises(TranscriptionError, match="timed out"):
        transcriber.transcribe(_silence(0.02))
