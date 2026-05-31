"""File transcription handler for the STT server.

Post Track B step 1: powered by onnx-asr directly (no faster_whisper). Media
files are decoded to 16 kHz mono float32 PCM via ``ffmpeg`` and fed into the
already-loaded :class:`OnnxAsrTranscriber` — the *same* WhisperX-style
VAD-segmented pipeline used for live recordings. ``txt`` joins the segment
texts; ``srt`` keeps the per-speech-run ``(start, end, text)`` tuples (cues
land on natural silence boundaries from Silero VAD, not Whisper's internal
``<|t|>`` tokens).
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
from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber
from src.stt_server.state import ServerState

if TYPE_CHECKING:
    from numpy.typing import NDArray

SUPPORTED_AUDIO_EXT = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".wma"}
SUPPORTED_VIDEO_EXT = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm"}
SUPPORTED_FILE_EXT = SUPPORTED_AUDIO_EXT | SUPPORTED_VIDEO_EXT

# onnx-asr's preprocessors target 16 kHz mono — decode straight to it so the
# library's resampler is a no-op.
_TARGET_SAMPLE_RATE = 16_000

# Only push a progress event when the fraction advances by at least this much.
# The VAD adapter yields ~one batch (≤8 chunks) per pull, so updates are
# already coarse; this just collapses any rare same-fraction repeats so the WS
# data channel isn't spammed on very long files.
_PROGRESS_EMIT_STEP = 0.01


class _FileTranscriptionCanceled(Exception):
    """Raised from the progress callback to abort an in-flight file transcription.

    Not an *error* — the user paused the queue (pressed push-to-talk to dictate)
    or cancelled the file explicitly. The worker catches it and emits a
    ``file_transcription_canceled`` event instead of an error so Electron can
    re-queue the file and resume after dictation.
    """


def _send_file_event(event: dict[str, Any], state: ServerState, loop: asyncio.AbstractEventLoop) -> None:
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(json.dumps(event)), loop)


def _format_srt_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _build_output(segments: list[tuple[float, float, str]], fmt: str) -> str:
    """Assemble the final transcript from the accumulated chunks (incl. resumed)."""
    if fmt == "srt":
        return _format_srt(segments) if segments else ""
    return " ".join(text.strip() for _, _, text in segments if text.strip())


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
    resume_from: float = 0.0,
    prior_segments: list[tuple[float, float, str]] | None = None,
) -> None:
    """Transcribe an audio/video file using the already-loaded onnx-asr model.

    ``resume_from`` (seconds) + ``prior_segments`` (absolute-timestamp chunks
    already finished) continue a previously-paused file: only the audio AFTER
    ``resume_from`` is transcribed and the results are concatenated, so a resume
    picks up where it stopped instead of restarting from the beginning.
    """
    file_name = Path(file_path).name
    # Finished chunks (absolute timestamps), seeded with whatever a prior run
    # produced. Bound before the try so the cancel handler can hand it back.
    accumulated: list[tuple[float, float, str]] = list(prior_segments or [])
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

        # Claim the single active slot. Do NOT reset the cancel flag here — it is
        # request-scoped, so a pause/cancel issued during this file's dispatch
        # window (before the worker started) already names THIS request_id and
        # must survive into the loop below. A stale flag naming a *different*
        # request is inert (the on_chunk check matches by id), and the finally
        # clears our own flag on exit.
        state.active_file_request_id = request_id

        # Route through the same OnnxAsrTranscriber the live recorder uses —
        # one WhisperX-style VAD-segmented codepath for both mic and files.
        service = state.recorder._service
        assert service is not None, (
            "Recorder service must be initialised before file transcription — "
            "callers gate on state.recorder above, which only becomes non-None "
            "after _ensure_service() succeeds in the facade."
        )
        transcriber = service._transcriber
        if not isinstance(transcriber, OnnxAsrTranscriber):
            _send_file_event(
                {
                    "type": "file_transcription_error",
                    "request_id": request_id,
                    "file_path": file_path,
                    "file_name": file_name,
                    "error": "Active transcriber does not support file transcription",
                },
                state,
                loop,
            )
            return

        _send_file_event(
            {
                "type": "file_transcription_progress",
                "request_id": request_id,
                "file_path": file_path,
                "file_name": file_name,
                "progress": 0.0,
                "stage": "decoding",
                "message": "Decoding…",
            },
            state,
            loop,
        )

        audio = _decode_media_to_pcm(file_path, sample_rate=_TARGET_SAMPLE_RATE)

        # Resume support: total stays in FULL-file terms; we transcribe only the
        # audio AFTER ``resume_from`` (a silence boundary from a prior cancel) and
        # concatenate with the already-finished ``accumulated`` chunks. Progress
        # and the next resume point are absolute, so a re-pause continues cleanly.
        total_full_s = float(len(audio)) / _TARGET_SAMPLE_RATE
        if resume_from > 0.0:
            audio = audio[int(resume_from * _TARGET_SAMPLE_RATE) :]

        initial_frac = min(resume_from / total_full_s, 1.0) if total_full_s > 0.0 else 0.0
        _send_file_event(
            {
                "type": "file_transcription_progress",
                "request_id": request_id,
                "file_path": file_path,
                "file_name": file_name,
                "progress": initial_frac,
                "stage": "transcribing",
                "message": "Transcribing…",
            },
            state,
            loop,
        )

        language = state.recorder.language or ""
        last_emitted = initial_frac

        def on_chunk(start: float, end: float, text: str) -> None:
            nonlocal last_emitted
            # Slice-relative → absolute timestamps, and stash for resume BEFORE
            # the cancel check so a finished chunk is never lost.
            accumulated.append((resume_from + start, resume_from + end, text))
            # Poll the request-scoped cancel flag between chunks (batch_size=1 on
            # the file path makes this every chunk) so a pause/cancel aborts here.
            if state.cancel_file_transcription_requested == request_id:
                raise _FileTranscriptionCanceled
            frac = min((resume_from + end) / total_full_s, 1.0) if total_full_s > 0.0 else 1.0
            if frac - last_emitted >= _PROGRESS_EMIT_STEP or frac >= 1.0:
                last_emitted = frac
                _send_file_event(
                    {
                        "type": "file_transcription_progress",
                        "request_id": request_id,
                        "file_path": file_path,
                        "file_name": file_name,
                        "progress": frac,
                        "stage": "transcribing",
                        "message": "Transcribing…",
                    },
                    state,
                    loop,
                )

        # The return value is ignored — ``on_chunk`` accumulates the chunks
        # (with the resumed prefix), and ``_build_output`` assembles the final
        # transcript from ``accumulated``. ``srt`` uses fine cues (merge off),
        # ``txt`` the merged-VAD coarse chunks.
        if fmt == "srt":
            transcriber.transcribe_segments(audio, language=language, on_chunk=on_chunk)
        else:
            transcriber.transcribe(audio, language=language, on_chunk=on_chunk)

        text = _build_output(accumulated, fmt)

        _send_file_event(
            {
                "type": "file_transcription_progress",
                "request_id": request_id,
                "file_path": file_path,
                "file_name": file_name,
                "progress": 1.0,
                "stage": "transcribing",
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

    except _FileTranscriptionCanceled:
        # Not an error — paused (push-to-talk or a manual Stop) or cancelled.
        # Hand back how far we got + the finished chunks so a resume continues
        # from here instead of restarting.
        resume_point = accumulated[-1][1] if accumulated else resume_from
        _send_file_event(
            {
                "type": "file_transcription_canceled",
                "request_id": request_id,
                "file_path": file_path,
                "file_name": file_name,
                "resume_from": resume_point,
                "partial_segments": [[s, e, t] for s, e, t in accumulated],
            },
            state,
            loop,
        )
        print(
            f"{bcolors.WARNING}File transcription canceled: {file_name} "
            f"(resume_from={resume_point:.1f}s){bcolors.ENDC}"
        )

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
    finally:
        # Release the active slot only if it's still ours — defensive against a
        # late callback from a superseded request flipping a newer file's flag.
        if state.active_file_request_id == request_id:
            state.active_file_request_id = None
        # Clear the cancel flag only if it still names THIS request, so a cancel
        # already queued for the next file (request-scoped) isn't wiped.
        if state.cancel_file_transcription_requested == request_id:
            state.cancel_file_transcription_requested = None
