"""Microbenchmark for OnnxAsrTranscriber.

Loads a small model on CPU (so it doesn't fight the live server's CUDA context),
runs N transcribe() calls on a fixed audio sample, and measures per-call latency
plus cProfile output for Python-level hot spots.

Run with: `uv run python scripts/bench_transcribe.py [model_name] [iterations]`
Default: whisper-tiny, 30 iterations, 8 s audio.
"""

from __future__ import annotations

import cProfile
import io
import pstats
import statistics
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber  # noqa: E402


def make_audio(duration_s: float = 8.0, sample_rate: int = 16_000) -> np.ndarray:
    """Synthetic audio: sine wave + low-amplitude noise. Not real speech, but
    matches the shape/dtype/range Whisper sees. Deterministic via seed.
    """
    rng = np.random.default_rng(0xC0FFEE)
    t = np.arange(int(duration_s * sample_rate), dtype=np.float32) / sample_rate
    # 440 Hz tone modulated to mimic prosody-ish dynamics + low-amp noise
    audio = 0.3 * np.sin(2 * np.pi * 440 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.5 * t))
    audio += 0.02 * rng.standard_normal(t.shape).astype(np.float32)
    return audio.astype(np.float32, copy=False)


def bench(model_name: str, iterations: int, duration_s: float, *, sess_opts: object | None = None) -> tuple[float, str]:
    """Returns (median_ms, transcript) so caller can compare configs."""
    print(f"Loading {model_name} (CPU) …", flush=True)
    t0 = time.perf_counter()
    extra: dict[str, object] = {}
    if sess_opts is not None:
        extra["sess_options"] = sess_opts  # type: ignore[assignment]
    tx = OnnxAsrTranscriber(
        model_name=model_name,
        quantization=None,
        providers=["CPUExecutionProvider"],
        segment_with_vad=False,
        normalize_audio=True,
    )
    # Hot-swap sess_options would require fork mod; instead, the caller-side
    # config knobs we CAN tune are exposed via onnxruntime SessionOptions at
    # model-load time. For this microbenchmark we keep the default config.
    _ = extra  # placeholder for future fork-level knob plumbing
    load_s = time.perf_counter() - t0
    print(f"  load: {load_s * 1000:.0f} ms")

    audio = make_audio(duration_s=duration_s)
    print(f"  audio: {duration_s:.1f} s @ 16 kHz, peak={float(np.max(np.abs(audio))):.3f}")

    # Warm 3 runs (let ORT compile / fill arenas)
    for _ in range(3):
        tx.transcribe(audio)

    # Measure N runs
    samples: list[float] = []
    first_text: str | None = None
    for i in range(iterations):
        start = time.perf_counter()
        result = tx.transcribe(audio)
        samples.append(time.perf_counter() - start)
        if first_text is None:
            first_text = result.text
        elif result.text != first_text:
            print(f"  ⚠ output drift at iter {i}: {first_text!r} → {result.text!r}", flush=True)

    print()
    print(f"=== {model_name} (N={iterations}, audio={duration_s:.1f}s, CPU) ===")
    print(f"  text:    {first_text!r}")
    print(f"  median:  {statistics.median(samples) * 1000:7.2f} ms")
    print(f"  mean:    {statistics.mean(samples) * 1000:7.2f} ms")
    print(f"  stdev:   {statistics.stdev(samples) * 1000:7.2f} ms")
    print(f"  min/max: {min(samples) * 1000:.2f} / {max(samples) * 1000:.2f} ms")
    print(f"  RTF:     {statistics.median(samples) / duration_s:.4f}x (lower=faster)")

    # cProfile a smaller burst to find Python hot spots without measurement noise
    prof = cProfile.Profile()
    prof.enable()
    for _ in range(max(5, iterations // 4)):
        tx.transcribe(audio)
    prof.disable()
    s = io.StringIO()
    pstats.Stats(prof, stream=s).strip_dirs().sort_stats("cumulative").print_stats(25)
    print()
    print("=== cProfile (top 25 by cumulative time) ===")
    print(s.getvalue())

    tx.shutdown()
    return statistics.median(samples) * 1000, first_text or ""


if __name__ == "__main__":
    model = sys.argv[1] if len(sys.argv) > 1 else "whisper-tiny"
    iters = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    dur = float(sys.argv[3]) if len(sys.argv) > 3 else 8.0
    bench(model, iters, dur)
