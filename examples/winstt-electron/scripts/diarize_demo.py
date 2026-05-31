"""End-to-end demo: timestamped Whisper + speaker diarization on an audio file.

Usage:
    python scripts/diarize_demo.py path/to/audio.mp3
    python scripts/diarize_demo.py path/to/audio.wav --num-speakers 2
    python scripts/diarize_demo.py path/to/audio.mp3 --whisper-model whisper-base

Accepts MP3 / WAV / any format ffmpeg can decode; converts to 16 kHz mono internally.

Loads:
    - ``onnx-community/whisper-tiny.en_timestamped`` (or another timestamped Whisper)
      via :func:`onnx_asr.load_model` for word-level timestamps.
    - ``onnx-community/pyannote-segmentation-3.0`` + ``Wespeaker/wespeaker-voxceleb-resnet34-LM``
      via :func:`onnx_asr.load_diarizer` for speaker turns.

Prints each word colored by its dominant speaker, plus a summary timeline.
"""

from __future__ import annotations

import argparse
import io
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np

# Windows: force UTF-8 on stdout/stderr so unicode arrows + ANSI escapes print cleanly.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

import onnx_asr  # noqa: E402

# ANSI 256-color foreground codes — chosen for terminal readability on
# both dark and light backgrounds.
_PALETTE = [
    "\033[38;5;39m",   # cyan / blue
    "\033[38;5;208m",  # orange
    "\033[38;5;42m",   # green
    "\033[38;5;213m",  # pink
    "\033[38;5;226m",  # yellow
    "\033[38;5;141m",  # purple
    "\033[38;5;203m",  # red
    "\033[38;5;87m",   # teal
]
_RESET = "\033[0m"
_DIM = "\033[2m"
_BOLD = "\033[1m"


def _color_for(speaker: int) -> str:
    if speaker < 0:
        return _DIM
    return _PALETTE[speaker % len(_PALETTE)]


def _load_audio_mono16k(path: Path) -> np.ndarray:
    """Decode anything ffmpeg understands → 16 kHz mono float32 in [-1, 1]."""
    if not path.exists():
        raise FileNotFoundError(path)
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError(
            "ffmpeg not found on PATH — install it or pass a 16 kHz mono WAV."
        )
    cmd = [
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", str(path),
        "-f", "wav", "-ac", "1", "-ar", "16000",
        "-acodec", "pcm_s16le",
        "pipe:1",
    ]
    proc = subprocess.run(cmd, capture_output=True, check=True)
    with wave.open(io.BytesIO(proc.stdout), "rb") as wf:
        n = wf.getnframes()
        pcm = wf.readframes(n)
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    return samples


def _format_seconds(t: float) -> str:
    m, s = divmod(t, 60)
    return f"{int(m):02d}:{s:05.2f}"


def _print_speaker_timeline(segments: list[onnx_asr.DiarSegment]) -> None:
    print(f"\n{_BOLD}=== Speaker timeline ==={_RESET}")
    n_speakers = len({s.speaker for s in segments}) if segments else 0
    total = sum((s.end - s.start) for s in segments)
    print(f"Detected {n_speakers} speaker(s), {total:.1f} s of total speech.\n")
    for seg in segments:
        col = _color_for(seg.speaker)
        print(
            f"  [{_format_seconds(seg.start)} → {_format_seconds(seg.end)}] "
            f"{col}SPEAKER {seg.speaker}{_RESET} "
            f"{_DIM}({seg.end - seg.start:.2f}s){_RESET}"
        )


def _print_transcript(
    words_with_speakers: list[tuple[str, float, float, int]],
) -> None:
    print(f"\n{_BOLD}=== Word-level transcript (colored by speaker) ==={_RESET}\n")
    current_speaker = -2
    line = ""
    for text, start, _end, speaker in words_with_speakers:
        if speaker != current_speaker:
            if line:
                print(line + _RESET)
            current_speaker = speaker
            tag = f"SPK{speaker}" if speaker >= 0 else "???"
            stamp = _format_seconds(start)
            line = f"  {_DIM}[{stamp}]{_RESET} {_color_for(speaker)}{_BOLD}{tag}{_RESET}{_color_for(speaker)}:{text}"
        else:
            line += text
    if line:
        print(line + _RESET)


def _print_speaker_grouped(
    words_with_speakers: list[tuple[str, float, float, int]],
) -> None:
    """Per-utterance grouping: each contiguous same-speaker word run on its own line."""
    print(f"\n{_BOLD}=== Per-utterance transcript ==={_RESET}\n")
    if not words_with_speakers:
        print(f"  {_DIM}(no words){_RESET}")
        return
    current_speaker = words_with_speakers[0][3]
    utt_start = words_with_speakers[0][1]
    utt_text: list[str] = []
    for text, start, end, speaker in words_with_speakers:
        if speaker != current_speaker:
            print(
                f"  {_DIM}[{_format_seconds(utt_start)}]{_RESET} "
                f"{_color_for(current_speaker)}{_BOLD}SPK{current_speaker}{_RESET}"
                f"{_color_for(current_speaker)}:{''.join(utt_text)}{_RESET}"
            )
            current_speaker = speaker
            utt_start = start
            utt_text = [text]
        else:
            utt_text.append(text)
        _ = end  # unused, kept for clarity
    print(
        f"  {_DIM}[{_format_seconds(utt_start)}]{_RESET} "
        f"{_color_for(current_speaker)}{_BOLD}SPK{current_speaker}{_RESET}"
        f"{_color_for(current_speaker)}:{''.join(utt_text)}{_RESET}"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("audio", type=Path, help="Input audio file (MP3/WAV/…).")
    ap.add_argument(
        "--whisper-model",
        default="onnx-community/whisper-base_timestamped",
        help="HF model id for a timestamped Whisper export.",
    )
    ap.add_argument(
        "--quantization", default=None,
        help="ORT quantization tier for Whisper (None | int8 | fp16 | q4 | …).",
    )
    ap.add_argument(
        "--num-speakers", type=int, default=None,
        help="If known, force exactly this many clusters.",
    )
    ap.add_argument(
        "--threshold", type=float, default=0.7,
        help="AHC cosine-distance cutoff when --num-speakers is not given.",
    )
    ap.add_argument(
        "--language", default="en",
        help="Language code for Whisper (en, ru, zh, …). Ignored by .en models.",
    )
    args = ap.parse_args()

    audio_path: Path = args.audio.resolve()
    print(f"{_BOLD}Loading audio:{_RESET} {audio_path}")
    t0 = time.perf_counter()
    audio = _load_audio_mono16k(audio_path)
    duration = audio.shape[0] / 16_000
    print(f"  → {duration:.2f} s, 16 kHz mono ({time.perf_counter() - t0:.2f} s decode)")

    print(f"\n{_BOLD}Loading Whisper:{_RESET} {args.whisper_model}"
          + (f" ({args.quantization})" if args.quantization else ""))
    t0 = time.perf_counter()
    asr = onnx_asr.load_model(args.whisper_model, quantization=args.quantization)
    print(f"  → loaded in {time.perf_counter() - t0:.2f} s")

    print(f"\n{_BOLD}Transcribing with word timestamps...{_RESET}")
    t0 = time.perf_counter()
    asr_ts = asr.with_timestamps()
    # ``language`` is silently ignored by English-only ``.en`` exports.
    result = asr_ts.recognize(
        audio,
        sample_rate=16_000,
        language=args.language,
        return_word_timestamps=True,
    )
    asr_time = time.perf_counter() - t0
    print(f"  → done in {asr_time:.2f} s "
          f"({_DIM}RTF={asr_time / max(duration, 1e-6):.3f}{_RESET})")

    words = result.words or []
    if not words:
        print(f"{_DIM}  (whisper produced no word timestamps; check --whisper-model){_RESET}")
        print(f"  full text: {result.text!r}")
        return 1
    print(f"  → {len(words)} words")

    print(f"\n{_BOLD}Loading diarizer:{_RESET} pyannote-segmentation-3.0 + wespeaker-resnet34-LM")
    t0 = time.perf_counter()
    diarizer = onnx_asr.load_diarizer()
    print(f"  → loaded in {time.perf_counter() - t0:.2f} s")

    print(f"\n{_BOLD}Running diarization...{_RESET}")
    t0 = time.perf_counter()
    segments = diarizer.diarize(
        audio, sample_rate=16_000,
        num_speakers=args.num_speakers,
        threshold=args.threshold,
    )
    diar_time = time.perf_counter() - t0
    print(f"  → {len(segments)} segments in {diar_time:.2f} s "
          f"({_DIM}RTF={diar_time / max(duration, 1e-6):.3f}{_RESET})")

    if not segments:
        print(f"{_DIM}  (no speech detected){_RESET}")
        return 1

    _print_speaker_timeline(segments)

    words_with_speakers = onnx_asr.assign_speakers_to_words(
        [(w.text, w.start, w.end) for w in words],
        segments,
    )
    _print_transcript(words_with_speakers)
    _print_speaker_grouped(words_with_speakers)

    asr.close()
    diarizer.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
