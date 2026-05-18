"""CUDA-only bench. Three runs each (warmup + 2 timed) to get steady-state RTF."""

from __future__ import annotations

import contextlib
import ctypes
import json

# Inline DLL injection mirroring server/src/recorder/infrastructure/device.py
import os
import time
from pathlib import Path

import soundfile as sf


def _inject_cuda_dlls() -> None:
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

import onnxruntime as rt  # noqa: E402  # import after CUDA DLL injection

print("providers:", rt.get_available_providers())
PROVIDERS = ["CUDAExecutionProvider", "CPUExecutionProvider"]

AUDIO_PATH = Path(r"E:\DL\Projects\WinSTT\examples\faster-whisper\tests\data\physicsworks.wav")
audio, sr = sf.read(str(AUDIO_PATH), dtype="float32")
if audio.ndim > 1:
    audio = audio.mean(axis=1)
print(f"audio: {len(audio) / sr:.1f}s")

results: list[dict] = []


def bench_onnxasr(quant: str | None) -> None:
    import onnx_asr

    opts = rt.SessionOptions()
    if quant == "fp16":
        opts.graph_optimization_level = rt.GraphOptimizationLevel.ORT_ENABLE_EXTENDED

    t0 = time.perf_counter()
    try:
        m = onnx_asr.load_model(
            "onnx-community/whisper-tiny.en",
            quantization=quant,
            providers=PROVIDERS,
            sess_options=opts,
        )
    except Exception as e:
        results.append({"stack": f"onnx_asr-{quant or 'fp32'}", "error": str(e).splitlines()[0]})
        return
    load_s = time.perf_counter() - t0

    # warmup
    with contextlib.suppress(Exception):
        m.recognize(audio[: 16000 * 5], sample_rate=sr)

    # timed runs
    times = []
    for _ in range(2):
        t1 = time.perf_counter()
        text = m.recognize(audio, sample_rate=sr)
        times.append(time.perf_counter() - t1)

    best = min(times)
    results.append(
        {
            "stack": f"onnx_asr-{quant or 'fp32'}",
            "load_s": load_s,
            "infer_s_best": best,
            "infer_s_runs": times,
            "rtf_best": (len(audio) / sr) / best,
            "text_head": text[:80],
        }
    )
    print(json.dumps(results[-1], default=str))


def bench_sherpa_cuda() -> None:
    import sherpa_onnx

    model_dir = Path(r"C:\Users\MASTE\.cache\sherpa-onnx-whisper-tiny.en")
    t0 = time.perf_counter()
    try:
        r = sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=str(model_dir / "tiny.en-encoder.onnx"),
            decoder=str(model_dir / "tiny.en-decoder.onnx"),
            tokens=str(model_dir / "tiny.en-tokens.txt"),
            provider="cuda",
            num_threads=1,
            language="en",
            task="transcribe",
            tail_paddings=2000,
        )
    except Exception as e:
        results.append({"stack": "sherpa-cuda", "error": str(e)})
        return
    load_s = time.perf_counter() - t0

    # warmup
    s = r.create_stream()
    s.accept_waveform(sr, audio[: 16000 * 5])
    r.decode_stream(s)

    times = []
    for _ in range(2):
        s = r.create_stream()
        s.accept_waveform(sr, audio)
        t1 = time.perf_counter()
        r.decode_stream(s)
        times.append(time.perf_counter() - t1)
    best = min(times)
    results.append(
        {
            "stack": "sherpa-onnx-cuda",
            "load_s": load_s,
            "infer_s_best": best,
            "infer_s_runs": times,
            "rtf_best": (len(audio) / sr) / best,
            "text_head": s.result.text[:80],
            "note": "sherpa Whisper drops audio past first 30s — RTF compares per-decode wall time only",
        }
    )
    print(json.dumps(results[-1], default=str))


for q in [None, "fp16"]:
    print(f"\n--- onnx_asr CUDA quant={q} ---")
    bench_onnxasr(q)

print("\n--- sherpa-onnx CUDA ---")
bench_sherpa_cuda()

print("\n==== SUMMARY (CUDA) ====")
print(f"{'stack':30s} {'load':>8s} {'infer_best':>11s} {'rtf':>8s}")
for r in results:
    if "error" in r:
        print(f"{r['stack']:30s}  FAIL: {r['error'][:80]}")
    else:
        print(f"{r['stack']:30s} {r['load_s']:>7.2f}s {r['infer_s_best']:>10.2f}s {r['rtf_best']:>7.1f}x")
