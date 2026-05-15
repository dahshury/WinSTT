"""File transcription handler for the STT server.

Post Track B step 1: powered by onnx-asr directly (no faster_whisper). Media
files are decoded to 16 kHz mono float32 PCM via ``ffmpeg`` and fed into the
already-loaded onnx-asr model — for SRT exports we use the model's
``with_timestamps()`` adapter to surface per-segment ``(start, end, text)``
tuples.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import traceback
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

from src.building_blocks.terminal import TerminalColors as bcolors
from src.stt_server.state import ServerState

if TYPE_CHECKING:
    from numpy.typing import NDArray

SUPPORTED_AUDIO_EXT = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".wma"}
SUPPORTED_VIDEO_EXT = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm"}
SUPPORTED_FILE_EXT = SUPPORTED_AUDIO_EXT | SUPPORTED_VIDEO_EXT

# onnx-asr's preprocessors target 16 kHz mono — decode straight to it so the
# library's resampler is a no-op.
_TARGET_SAMPLE_RATE = 16_000


def _send_file_event(event: dict[str, Any], state: ServerState, loop: asyncio.AbstractEventLoop) -> None:
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(json.dumps(event)), loop)


def _format_srt_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _format_srt(segments: list[tuple[float, float, str]]) -> str:
    lines: list[str] = []
    for i, (start, end, text) in enumerate(segments, 1):
        lines.append(f"{i}")
        lines.append(f"{_format_srt_time(start)} --> {_format_srt_time(end)}")
        lines.append(text.strip())
        lines.append("")
    return "\n".join(lines)


def _decode_media_to_pcm(path: str, sample_rate: int = _TARGET_SAMPLE_RATE) -> NDArray[np.float32]:
    """Decode an audio/video file to mono float32 PCM at ``sample_rate`` via ffmpeg.

    Raises ``RuntimeError`` if ffmpeg is not installed or the decode fails — the
    server's previous engine (faster_whisper) bundled ffmpeg via PyAV; with the
    torch drop we rely on the system ffmpeg binary instead.
    """
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        path,
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, check=True)
    except FileNotFoundError as exc:
        msg = "ffmpeg not found — install ffmpeg and put it on PATH to enable file transcription"
        raise RuntimeError(msg) from exc
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode("utf-8", errors="replace") if exc.stderr else "(no stderr)"
        msg = f"ffmpeg decode failed: {stderr.strip()}"
        raise RuntimeError(msg) from exc

    return np.frombuffer(result.stdout, dtype=np.float32).copy()


def handle_transcribe_file(
    file_path: str,
    request_id: str,
    state: ServerState,
    loop: asyncio.AbstractEventLoop,
    fmt: str = "txt",
) -> None:
    """Transcribe an audio/video file using the already-loaded onnx-asr model."""
    file_name = Path(file_path).name
    try:
        p = Path(file_path)
        if not p.exists():
            _send_file_event(
                {
                    "type": "file_transcription_error",
                    "request_id": request_id,
                    "file_path": file_path,
                    "error": "File not found",
                },
                state,
                loop,
            )
            return

        ext = p.suffix.lower()
        if ext not in SUPPORTED_FILE_EXT:
            _send_file_event(
                {
                    "type": "file_transcription_error",
                    "request_id": request_id,
                    "file_path": file_path,
                    "error": f"Unsupported format: {ext}",
                },
                state,
                loop,
            )
            return

        assert state.recorder is not None, "Recorder must be initialized"

        _send_file_event(
            {
                "type": "file_transcription_progress",
                "request_id": request_id,
                "file_path": file_path,
                "file_name": file_name,
                "progress": 0.1,
                "message": "Decoding...",
            },
            state,
            loop,
        )

        # Pull the underlying onnx-asr model from the OnnxAsrTranscriber adapter.
        transcriber = state.recorder._service._transcriber  # type: ignore[union-attr]
        model: Any = transcriber._model  # type: ignore[union-attr]

        audio = _decode_media_to_pcm(file_path, sample_rate=_TARGET_SAMPLE_RATE)

        _send_file_event(
            {
                "type": "file_transcription_progress",
                "request_id": request_id,
                "file_path": file_path,
                "file_name": file_name,
                "progress": 0.3,
                "message": "Transcribing...",
            },
            state,
            loop,
        )

        language = state.recorder.language or None

        if fmt == "srt":
            # with_timestamps() returns an adapter whose recognize() emits
            # TimestampedResult.segments — a list of (start, end, text) tuples
            # produced by Whisper's <|t|> timestamp tokens.
            result = model.with_timestamps().recognize(
                audio,
                sample_rate=_TARGET_SAMPLE_RATE,
                language=language,
                return_timestamps=True,
            )
            segments = result.segments or []
            text = _format_srt(segments) if segments else (result.text or "")
        else:
            text = model.recognize(
                audio,
                sample_rate=_TARGET_SAMPLE_RATE,
                language=language,
            )

        _send_file_event(
            {
                "type": "file_transcription_progress",
                "request_id": request_id,
                "file_path": file_path,
                "file_name": file_name,
                "progress": 1.0,
                "message": "Complete",
            },
            state,
            loop,
        )

        _send_file_event(
            {
                "type": "file_transcription_complete",
                "request_id": request_id,
                "file_path": file_path,
                "file_name": file_name,
                "text": text,
                "format": fmt,
            },
            state,
            loop,
        )

        print(f"{bcolors.OKGREEN}File transcription complete: {file_name} ({len(text)} chars){bcolors.ENDC}")

    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"
        stack_trace = traceback.format_exc()
        _send_file_event(
            {
                "type": "file_transcription_error",
                "request_id": request_id,
                "file_path": file_path,
                "file_name": file_name,
                "error": error_msg,
                "error_type": type(e).__name__,
            },
            state,
            loop,
        )
        print(f"{bcolors.FAIL}File transcription error ({file_name}): {error_msg}{bcolors.ENDC}")
        if state.extended_logging:
            print(f"{bcolors.FAIL}{stack_trace}{bcolors.ENDC}")
