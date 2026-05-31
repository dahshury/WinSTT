"""One-shot transcription helper — runs the project's onnx-asr backend on a
WAV file and prints the transcript to stdout.

Usage: uv run python scripts/transcribe_file.py <path-to-16khz-mono-wav>

Splits long audio into 30s chunks because parakeet's recognize() pulls the
whole array into memory; chunking keeps the working set bounded and lets
us emit partial output as we go.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import onnx_asr  # type: ignore[import-untyped]
import soundfile as sf

CHUNK_SECONDS = 30
SAMPLE_RATE = 16_000


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: transcribe_file.py <wav>", file=sys.stderr)
        sys.exit(2)
    wav_path = Path(sys.argv[1])
    audio, sr = sf.read(wav_path, dtype="float32")
    if sr != SAMPLE_RATE:
        msg = f"expected {SAMPLE_RATE} Hz audio, got {sr}"
        raise SystemExit(msg)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    model_name = "istupakov/parakeet-tdt-0.6b-v3-onnx"
    print(f"[transcribe] loading {model_name}…", file=sys.stderr)
    model = onnx_asr.load_model(model_name)

    chunk_size = CHUNK_SECONDS * SAMPLE_RATE
    n = len(audio)
    out: list[str] = []
    for i, start in enumerate(range(0, n, chunk_size)):
        chunk = audio[start : start + chunk_size]
        # Last sliver might be < 1s; pad to 1s so the model has enough context.
        if len(chunk) < SAMPLE_RATE:
            chunk = np.pad(chunk, (0, SAMPLE_RATE - len(chunk)))
        text = model.recognize(chunk, sample_rate=SAMPLE_RATE)
        print(f"[transcribe] chunk {i + 1}: {len(chunk) / SAMPLE_RATE:.1f}s", file=sys.stderr)
        if text:
            out.append(text.strip())

    print("\n".join(out))


if __name__ == "__main__":
    main()
