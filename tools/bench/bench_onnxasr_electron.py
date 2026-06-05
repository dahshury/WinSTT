"""Benchmark the ELECTRON STT path (onnx_asr, the exact engine the Electron app uses) on the
SAME JFK audio the Rust stt_spike decodes, so Rust-vs-Electron RTFs are comparable.

Usage:  python bench_onnxasr_electron.py <model_id> <cpu|dml> [quantization]
  e.g.  python bench_onnxasr_electron.py nemo-canary-1b-flash dml int8
Run with the Electron .venv python (has onnx_asr + onnxruntime-directml).
"""
import os, sys, time
from pathlib import Path
import numpy as np

if len(sys.argv) < 3:
    print("usage: bench_onnxasr_electron.py <model_id> <cpu|dml> [quant]")
    sys.exit(2)

MODEL = sys.argv[1]
PROVIDER = sys.argv[2].lower()
_q = sys.argv[3] if len(sys.argv) > 3 else None
QUANT = None if _q in (None, "", "none", "None") else _q
# Optional 4th arg: audio f32 path (short/medium/long). Default = JFK medium clip.
F32 = sys.argv[4] if len(sys.argv) > 4 else str(
    Path(__file__).resolve().parent / "audio" / "jfk_short_3s.f32"
)

providers = ["DmlExecutionProvider"] if PROVIDER == "dml" else ["CPUExecutionProvider"]

# Raw f32 mono @16k (same format stt_spike decodes).
audio = np.fromfile(F32, dtype=np.float32)
print(f"model={MODEL} provider={providers} quant={QUANT} samples={len(audio)} dur={len(audio)/16000:.2f}s")

import onnx_asr
t0 = time.perf_counter()
try:
    model = onnx_asr.load_model(MODEL, quantization=QUANT, providers=providers)
except TypeError:
    # older signature: positional quantization differs
    model = onnx_asr.load_model(MODEL, providers=providers)
load_ms = (time.perf_counter() - t0) * 1000.0
print(f"load={load_ms:.0f}ms")

def run():
    t = time.perf_counter()
    txt = model.recognize(audio)
    return (time.perf_counter() - t) * 1000.0, txt

cold_ms, txt = run()
dur = len(audio) / 16000.0
print(f"[cold] recognize={cold_ms:8.1f}ms  RTF={cold_ms/1000.0/dur:.3f}")
warm = []
for i in range(3):
    ms, _ = run()
    warm.append(ms)
    print(f"[warm{i}] recognize={ms:8.1f}ms  RTF={ms/1000.0/dur:.3f}")
wm = sorted(warm)[1]
print(f"WARM_MEDIAN={wm:.1f}ms")
print(f"TEXT: {txt!r}")
# Machine-parseable row for the comparison table builder.
print(
    f"RESULT impl=onnxasr-fork model={MODEL} provider={PROVIDER} "
    f"quant={_q or 'none'} audio={os.path.basename(F32)} dur={dur:.2f} "
    f"warm_ms={wm:.1f} rtf={wm/1000.0/dur:.4f}"
)
