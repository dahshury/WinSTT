"""Bench CTranslate2 faster-whisper (a fast CPU/CUDA whisper path)
on the SAME raw f32 clip our stt_spike decodes. CT2 has NO DirectML — it's CPU/CUDA only — so this
measures the CPU whisper ceiling. Greedy (beam_size=1) to match our greedy decode.

  python bench_ct2_whisper.py <repo_or_dir> <audio.f32> [compute_type] [device]
  e.g. python bench_ct2_whisper.py deepdml/faster-whisper-large-v3-turbo-ct2 jfk.f32 int8 cpu
"""
import sys, time
import numpy as np
from faster_whisper import WhisperModel

MODEL = sys.argv[1]
F32 = sys.argv[2]
COMPUTE = sys.argv[3] if len(sys.argv) > 3 else "int8"
DEVICE = sys.argv[4] if len(sys.argv) > 4 else "cpu"

audio = np.fromfile(F32, dtype=np.float32)
dur = len(audio) / 16000.0
print(f"model={MODEL} compute={COMPUTE} device={DEVICE} dur={dur:.2f}s")

import os
_threads = int(os.environ.get("CT2_THREADS", "16"))
model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE, cpu_threads=_threads)

def run():
    t = time.perf_counter()
    segs, _ = model.transcribe(audio, language="en", beam_size=1)  # greedy
    txt = "".join(s.text for s in segs)  # consume the lazy generator (forces decode)
    return (time.perf_counter() - t) * 1000.0, txt

cold, txt = run()
print(f"[cold] {cold:.1f}ms")
warms = []
for i in range(3):
    ms, _ = run()
    warms.append(ms)
    print(f"[warm{i}] {ms:.1f}ms")
wm = sorted(warms)[1]
print(f"TEXT: {txt[:70]!r}")
print(
    f"RESULT impl=ct2-faster-whisper model={MODEL.split('/')[-1]} provider={DEVICE} "
    f"quant={COMPUTE} dur={dur:.2f} warm_ms={wm:.1f} rtf={wm/1000.0/dur:.4f}"
)
