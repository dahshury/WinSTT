"""Benchmark fp32 vs fp16 across model sizes on CUDA + CPU.

Goal: find the crossover (if any) where fp16 stops being slower than
fp32. Also probe peak GPU memory so we can answer "useless?" honestly —
even if compute is slower, fp16 halves the weights' VRAM footprint.

Models: tiny, base, small, large-v3-turbo. Skips int8/etc. — those are
covered elsewhere.
"""

from __future__ import annotations

import contextlib
import ctypes
import gc
import json
import os
import sys
import time
from pathlib import Path

import soundfile as sf


# Inline CUDA DLL injection mirroring server.infrastructure.device.
def _inject_cuda_dlls() -> None:
    if sys.platform != "win32":
        return
    try:
        import nvidia
    except ImportError:
        return
    pkgs = ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc", "cufft", "curand", "nvjitlink", "cusparse", "cusolver")
    for nv_root in (Path(p) for p in nvidia.__path__):
        for pkg in pkgs:
            bin_dir = nv_root / pkg / "bin"
            if bin_dir.is_dir():
                with contextlib.suppress(OSError):
                    os.add_dll_directory(str(bin_dir))
                for dll in bin_dir.glob("*.dll"):
                    with contextlib.suppress(OSError):
                        ctypes.WinDLL(str(dll))


_inject_cuda_dlls()

import onnx_asr  # noqa: E402  # import after CUDA DLL injection
import onnxruntime as rt  # noqa: E402  # import after CUDA DLL injection

AUDIO = Path(r"E:\DL\Projects\WinSTT\examples\faster-whisper\tests\data\physicsworks.wav")
audio, sr = sf.read(str(AUDIO), dtype="float32")
if audio.ndim > 1:
    audio = audio.mean(axis=1)
print(f"audio: {len(audio) / sr:.1f}s")

# Try a quick GPU memory probe via pynvml if available.
try:
    import pynvml

    pynvml.nvmlInit()
    handle = pynvml.nvmlDeviceGetHandleByIndex(0)

    def gpu_mem_mb() -> int:
        return int(pynvml.nvmlDeviceGetMemoryInfo(handle).used / 1024 / 1024)

    HAS_NVML = True
except Exception:
    HAS_NVML = False

    def gpu_mem_mb() -> int:
        return -1


def bench(model_repo: str, device: str, quant: str | None) -> dict:
    label = f"{model_repo.split('/')[-1]}-{device}-{quant or 'fp32'}"
    print(f"\n=== {label} ===", flush=True)
    providers = ["CPUExecutionProvider"] if device == "cpu" else ["CUDAExecutionProvider", "CPUExecutionProvider"]

    gc.collect()
    base_mem = gpu_mem_mb() if device != "cpu" else -1

    opts = rt.SessionOptions()
    if quant == "fp16":
        opts.graph_optimization_level = rt.GraphOptimizationLevel.ORT_ENABLE_EXTENDED

    t0 = time.perf_counter()
    try:
        m = onnx_asr.load_model(model_repo, quantization=quant, providers=providers, sess_options=opts)
    except Exception as e:
        return {"label": label, "error": str(e).splitlines()[0]}
    load_s = time.perf_counter() - t0
    after_load_mem = gpu_mem_mb() if device != "cpu" else -1

    # Warm-up
    with contextlib.suppress(Exception):
        m.recognize(audio[: 16000 * 5], sample_rate=sr)
    after_warmup_mem = gpu_mem_mb() if device != "cpu" else -1

    # Two timed runs
    times = []
    for _ in range(2):
        t1 = time.perf_counter()
        text = m.recognize(audio, sample_rate=sr)
        times.append(time.perf_counter() - t1)
    peak_mem = gpu_mem_mb() if device != "cpu" else -1

    best = min(times)
    result = {
        "label": label,
        "load_s": round(load_s, 2),
        "infer_best_s": round(best, 3),
        "rtf": round((len(audio) / sr) / best, 1),
        "text_head": text[:60],
    }
    if device != "cpu" and HAS_NVML:
        result["gpu_mb_baseline"] = base_mem
        result["gpu_mb_after_load"] = after_load_mem
        result["gpu_mb_after_warmup"] = after_warmup_mem
        result["gpu_mb_peak"] = peak_mem
        result["gpu_mb_model_delta"] = after_warmup_mem - base_mem
    print(json.dumps(result), flush=True)

    # Force cleanup so memory snapshot of next run is clean
    if hasattr(m, "close"):
        m.close()
    del m
    gc.collect()
    return result


results: list[dict] = []
matrix = [
    # (repo, devices, quants)
    ("onnx-community/whisper-tiny", ["cpu", "cuda"], [None, "fp16"]),
    ("onnx-community/whisper-base", ["cpu", "cuda"], [None, "fp16"]),
    ("onnx-community/whisper-small", ["cpu", "cuda"], [None, "fp16"]),
    ("onnx-community/whisper-large-v3-turbo", ["cuda"], [None, "fp16"]),  # CPU too slow for 800M
]

for repo, devices, quants in matrix:
    for dev in devices:
        for q in quants:
            results.append(bench(repo, dev, q))

print("\n\n==== SUMMARY ====")
print(f"{'label':45s} {'load':>7s} {'best':>7s} {'rtf':>7s}  {'mem MB':>7s}")
for r in results:
    if "error" in r:
        print(f"{r['label']:45s}  FAIL: {r['error'][:80]}")
        continue
    mem = r.get("gpu_mb_model_delta", "-")
    print(
        f"{r['label']:45s} "
        f"{r['load_s']:>6.2f}s "
        f"{r['infer_best_s']:>6.2f}s "
        f"{r['rtf']:>6.1f}x  "
        f"{mem:>6}{'MB' if isinstance(mem, int) else ''}"
    )

Path("E:/DL/Projects/WinSTT/server/scratch/bench_fp16_crossover.json").write_text(
    json.dumps(results, indent=2, default=str)
)
