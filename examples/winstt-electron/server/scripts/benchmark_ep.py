"""Wall-clock benchmark for ONNX Runtime execution providers on the
default WinSTT STT model (onnx-community/whisper-tiny q4).

Run in a venv that has exactly ONE of these EP wheels installed:

  * ``onnxruntime`` (CPU only)
  * ``onnxruntime-gpu`` (CUDA EP + its NVIDIA DLL chain via the [gpu] extra)
  * ``onnxruntime-directml`` (DirectML EP — Windows-only)

``onnxruntime-gpu`` and ``onnxruntime-directml`` share the ``onnxruntime/``
package directory, so they cannot coexist. The runner script
``benchmark_ep_all.py`` automates this with sibling venvs.

The benchmark transcribes a 5-second synthetic test signal ten times,
discards two warm-up runs, and reports min / p50 / p95 / max wall-clock
latency in ms. Output: JSON to stdout + human-readable lines to stderr.
"""

from __future__ import annotations

import argparse
import json
import platform
import statistics
import sys
import time
from typing import Any

import numpy as np

# Default model — the same one we vendor as the offline base STT
# (whisper-tiny q4 — see project_offline_base_and_tts_pack memory note).
DEFAULT_MODEL = "onnx-community/whisper-tiny"
DEFAULT_QUANT = "q4"
DEFAULT_RUNS = 10
DEFAULT_WARMUP = 2
SAMPLE_RATE = 16_000
DURATION_S = 5.0


def _make_test_audio() -> np.ndarray:
    """A 5-second mix of two sine tones with a small envelope.

    Pure silence (zeros) breaks Whisper's NoSpeechProb token; a real signal
    keeps the decoder honest. We don't care what the model TRANSCRIBES —
    only that the forward pass exercises both the encoder and decoder
    end-to-end on the chosen EP.
    """
    n = int(SAMPLE_RATE * DURATION_S)
    t = np.arange(n, dtype=np.float32) / SAMPLE_RATE
    envelope = 0.5 * (1.0 - np.cos(2 * np.pi * t / DURATION_S))
    sig = 0.4 * np.sin(2 * np.pi * 440 * t) + 0.2 * np.sin(2 * np.pi * 880 * t)
    return (sig * envelope).astype(np.float32)


def _select_provider_list(ep_name: str) -> list[Any]:
    """Build the providers argument for ``onnx_asr.load_model``.

    Always falls back to CPU after the requested EP so the session creation
    is robust even if the GPU EP is registered but unusable. ``cuda`` adds
    no provider options here — the benchmark only cares about steady-state
    latency, and the default ORT CUDA EP options (EXHAUSTIVE conv search)
    match the production runtime in ``device.py``.
    """
    if ep_name == "cuda":
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    if ep_name == "directml":
        return ["DmlExecutionProvider", "CPUExecutionProvider"]
    if ep_name == "cpu":
        return ["CPUExecutionProvider"]
    msg = f"Unknown EP {ep_name!r}; expected one of cuda|directml|cpu"
    raise ValueError(msg)


def _inject_cuda_dlls_if_needed() -> None:
    """For the CUDA benchmark — mirror the runtime's DLL injection.

    Without this, raw ``import onnxruntime`` fails to find ``cublasLt64_12.dll``
    even though the nvidia-*-cu12 wheels are installed in site-packages.
    Calling the project's own helper keeps the benchmark in sync with
    production behavior.
    """
    try:
        from src.recorder.infrastructure.device import _inject_cuda_dlls
    except ImportError:
        return
    _inject_cuda_dlls()


def run(ep: str, model: str, quant: str, runs: int, warmup: int) -> dict[str, Any]:
    """Time ``runs`` recognize() calls; return percentile summary."""
    if ep == "cuda":
        _inject_cuda_dlls_if_needed()

    import onnx_asr  # must happen AFTER DLL injection
    import onnxruntime as rt

    available = rt.get_available_providers()
    providers = _select_provider_list(ep)
    print(f"[{ep}] ORT {rt.__version__} available={available}", file=sys.stderr)
    print(f"[{ep}] requested providers={providers}", file=sys.stderr)
    if ep == "cuda" and "CUDAExecutionProvider" not in available:
        raise SystemExit("CUDAExecutionProvider not registered with ORT — install onnxruntime-gpu")
    if ep == "directml" and "DmlExecutionProvider" not in available:
        raise SystemExit("DmlExecutionProvider not registered with ORT — install onnxruntime-directml")

    audio = _make_test_audio()
    load_t = time.perf_counter()
    m = onnx_asr.load_model(model, quantization=quant, providers=providers)
    load_ms = (time.perf_counter() - load_t) * 1000
    print(f"[{ep}] model loaded in {load_ms:.1f} ms", file=sys.stderr)

    # Warmup — first call pays for JIT / cuDNN heuristics / DML compilation.
    for _ in range(warmup):
        m.recognize(audio, sample_rate=SAMPLE_RATE)

    samples_ms: list[float] = []
    for _ in range(runs):
        t = time.perf_counter()
        m.recognize(audio, sample_rate=SAMPLE_RATE)
        samples_ms.append((time.perf_counter() - t) * 1000)

    samples_ms.sort()
    n = len(samples_ms)
    summary = {
        "ep": ep,
        "ort_version": rt.__version__,
        "model": model,
        "quantization": quant,
        "providers_requested": providers,
        "providers_available": available,
        "platform": platform.platform(),
        "warmup_runs": warmup,
        "timed_runs": runs,
        "duration_s": DURATION_S,
        "load_ms": load_ms,
        "min_ms": samples_ms[0],
        "p50_ms": samples_ms[n // 2],
        "p95_ms": samples_ms[min(n - 1, round(0.95 * (n - 1)))],
        "p99_ms": samples_ms[min(n - 1, round(0.99 * (n - 1)))],
        "max_ms": samples_ms[-1],
        "mean_ms": statistics.fmean(samples_ms),
        "stdev_ms": statistics.pstdev(samples_ms),
        "samples_ms": samples_ms,
    }
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ep", required=True, choices=["cuda", "directml", "cpu"])
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--quantization", default=DEFAULT_QUANT)
    parser.add_argument("--runs", type=int, default=DEFAULT_RUNS)
    parser.add_argument("--warmup", type=int, default=DEFAULT_WARMUP)
    args = parser.parse_args()

    summary = run(args.ep, args.model, args.quantization, args.runs, args.warmup)
    print(json.dumps(summary, indent=2))
    print(
        f"[{summary['ep']}] min={summary['min_ms']:.1f} ms "
        f"p50={summary['p50_ms']:.1f} ms "
        f"p95={summary['p95_ms']:.1f} ms "
        f"p99={summary['p99_ms']:.1f} ms "
        f"max={summary['max_ms']:.1f} ms "
        f"mean={summary['mean_ms']:.1f} ms "
        f"stdev={summary['stdev_ms']:.1f} ms",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
