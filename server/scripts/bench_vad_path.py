"""Bench the production transcribe-with-VAD path (PTT user path).

Uses segment_with_vad=True (the production main-transcriber default).
Verifies the optimization stack delivers the same wins when Silero VAD
chunks the audio first.
"""

from __future__ import annotations

import statistics
import sys
import time
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber  # noqa: E402


def load_speech(duration_s: float, sample_rate: int = 16_000) -> np.ndarray:
    wav = ROOT.parent / "examples" / "diart" / "tests" / "data" / "audio" / "sample.wav"
    with wave.open(str(wav), "rb") as w:
        rate = w.getframerate()
        pcm = w.readframes(w.getnframes())
        nch = w.getnchannels()
    a16 = np.frombuffer(pcm, dtype=np.int16)
    if nch == 2:
        a16 = a16.reshape(-1, 2).mean(axis=1).astype(np.int16)
    audio = a16.astype(np.float32) / 32768.0
    if rate != sample_rate:
        old_t = np.linspace(0, len(audio) / rate, len(audio), endpoint=False)
        new_n = int(len(audio) * sample_rate / rate)
        new_t = np.linspace(0, len(audio) / rate, new_n, endpoint=False)
        audio = np.interp(new_t, old_t, audio).astype(np.float32)
    n = int(duration_s * sample_rate)
    if len(audio) > n:
        return audio[:n]
    return np.tile(audio, (n // len(audio)) + 1)[:n]


def bench(model: str, audio: np.ndarray, providers: list[object], iters: int) -> tuple[float, str]:
    tx = OnnxAsrTranscriber(
        model_name=model,
        quantization=None,
        providers=providers,
        segment_with_vad=True,  # PRODUCTION main-transcriber path
        normalize_audio=True,
    )
    for _ in range(2):
        tx.transcribe(audio)
    samples: list[float] = []
    text = ""
    for _ in range(iters):
        t0 = time.perf_counter()
        r = tx.transcribe(audio)
        samples.append(time.perf_counter() - t0)
        text = r.text or text
    tx.shutdown()
    return statistics.median(samples) * 1000, text


def main() -> int:
    use_gpu = "--gpu" in sys.argv
    iters = 8 if use_gpu else 6
    ep_label = "CUDA" if use_gpu else "CPU"
    models = [
        "onnx-community/whisper-tiny",
        "onnx-community/moonshine-base-ONNX",
        "istupakov/canary-180m-flash-onnx",
    ]
    durations = [3.0, 10.0, 25.0]
    prov_list = ["CUDAExecutionProvider", "CPUExecutionProvider"] if use_gpu else ["CPUExecutionProvider"]

    print(f"\n=== VAD-path bench ({ep_label}, segment_with_vad=True) ===\n")
    print(f"  {'model':<46} {'audio':>7} {'med':>10}  text-len")
    for model in models:
        for dur in durations:
            audio = load_speech(dur)
            try:
                med, text = bench(model, audio, prov_list, iters)
            except Exception as e:
                print(f"  {model:<46} {dur:>5.1f}s  FAILED: {type(e).__name__}: {str(e)[:60]}")
                continue
            print(f"  {model:<46} {dur:>5.1f}s  {med:7.2f}ms   {len(text)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
