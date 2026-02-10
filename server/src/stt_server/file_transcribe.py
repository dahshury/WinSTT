"""File transcription handler for the STT server."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from src.building_blocks.terminal import TerminalColors as bcolors
from src.stt_server.state import ServerState

SUPPORTED_AUDIO_EXT = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".wma"}
SUPPORTED_VIDEO_EXT = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm"}
SUPPORTED_FILE_EXT = SUPPORTED_AUDIO_EXT | SUPPORTED_VIDEO_EXT


def _send_file_event(event: dict[str, Any], state: ServerState, loop: asyncio.AbstractEventLoop) -> None:
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(json.dumps(event)), loop)


def _format_srt_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _format_srt(segments: list[Any]) -> str:
    lines: list[str] = []
    for i, seg in enumerate(segments, 1):
        start = _format_srt_time(seg.start)
        end = _format_srt_time(seg.end)
        lines.append(f"{i}")
        lines.append(f"{start} --> {end}")
        lines.append(seg.text.strip())
        lines.append("")
    return "\n".join(lines)


def handle_transcribe_file(
    file_path: str,
    request_id: str,
    state: ServerState,
    loop: asyncio.AbstractEventLoop,
    fmt: str = "txt",
) -> None:
    """Transcribe an audio/video file using the already-loaded Whisper model."""
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
                "message": "Transcribing...",
            },
            state,
            loop,
        )

        # Access the transcriber's underlying WhisperModel (not BatchedInferencePipeline)
        transcriber = state.recorder._service._transcriber  # type: ignore[union-attr]
        model = transcriber._model  # type: ignore[union-attr]

        # BatchedInferencePipeline wraps the real model — unwrap it for file transcription
        import faster_whisper

        if isinstance(model, faster_whisper.BatchedInferencePipeline):
            model = model.model

        # vad_filter=False: Silero VAD filters out singing/music as non-speech.
        # For file transcription we want everything, so disable VAD and let
        # Whisper's own 30-second windowed decoding handle the full file.
        segments, _info = model.transcribe(
            file_path,
            language=state.recorder.language or None,
            beam_size=getattr(transcriber, "_beam_size", 5),
            initial_prompt=getattr(transcriber, "_initial_prompt", None),
            suppress_tokens=getattr(transcriber, "_suppress_tokens", [-1]),
            vad_filter=False,
        )
        seg_list = list(segments)

        text = _format_srt(seg_list) if fmt == "srt" else " ".join(seg.text for seg in seg_list).strip()

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
        _send_file_event(
            {
                "type": "file_transcription_error",
                "request_id": request_id,
                "file_path": file_path,
                "error": str(e),
            },
            state,
            loop,
        )
        print(f"{bcolors.FAIL}File transcription error: {e}{bcolors.ENDC}")
