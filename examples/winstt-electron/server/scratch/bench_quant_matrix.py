"""Empirical matrix: every Whisper repo x every quant.

For each (model, quant), tries to load with the same logic
OnnxAsrTranscriber uses (sess_options + reactive fp16 decoder patch),
then transcribes a short clip. Categorises the outcome:

- OK         : loaded, output similar to fp32 baseline (>= 0.85 ratio)
- DIVERGENT  : loaded but output differs wildly (token loop, garbage)
- LOAD_FAIL  : ORT rejected the model after our retry+patch
- RESOLVE    : the file doesn't exist in the repo

Output drives per-model quant policy.
"""

from __future__ import annotations

import contextlib
import ctypes
import gc
import json
import os
import sys
import time
from difflib import SequenceMatcher
from pathlib import Path

import soundfile as sf


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
sys.path.insert(0, r"<repo>\server")

from src.recorder.infrastructure.onnxasr_transcriber import (  # noqa: E402  # import after CUDA DLL injection and sys.path setup
    OnnxAsrTranscriber,
)

AUDIO_PATH = Path(r"<repo>\examples\faster-whisper\tests\data\physicsworks.wav")
audio, sr = sf.read(str(AUDIO_PATH), dtype="float32")
if audio.ndim > 1:
    audio = audio.mean(axis=1)
audio = audio[: 16_000 * 15]  # 15s clip — plenty of words for similarity scoring
print(f"audio: {len(audio) / sr:.1f}s")

# All Whisper-family entries from the catalog. Skip 'whisper-base' (the ORT-
# fused single-file variant) since it doesn't use the merged-decoder pipeline.
REPOS = {
    # multilingual
    "tiny": "onnx-community/whisper-tiny",
    "base": "onnx-community/whisper-base",
    "small": "onnx-community/whisper-small",
    "medium": "onnx-community/whisper-medium",
    "large-v3": "onnx-community/whisper-large-v3",
    "large-v3-turbo": "onnx-community/whisper-large-v3-turbo",
    # english-only
    "tiny.en": "onnx-community/whisper-tiny.en",
    "base.en": "onnx-community/whisper-base.en",
    "small.en": "onnx-community/whisper-small.en",
    "medium.en": "onnx-community/whisper-medium.en",
    # lite (memory says only default works — verify)
    "lite-whisper-large-v3-turbo": "onnx-community/lite-whisper-large-v3-turbo-ONNX",
    "lite-whisper-large-v3-turbo-acc": "onnx-community/lite-whisper-large-v3-turbo-acc-ONNX",
    "lite-whisper-large-v3-turbo-fast": "onnx-community/lite-whisper-large-v3-turbo-fast-ONNX",
}
QUANTS = [None, "fp16", "int8", "uint8", "q4", "q4f16", "bnb4"]


def bench_one(model_id: str, repo: str, quant: str | None, baseline: str) -> dict:
    label = f"{model_id}@{quant or 'fp32'}"
    print(f"  {label:48s}", end=" ", flush=True)
    t0 = time.perf_counter()
    try:
        t = OnnxAsrTranscriber(
            model_name=repo,
            quantization=quant,
            providers=["CPUExecutionProvider"],
            segment_with_vad=False,  # bounded-short caller — skip VAD load
        )
    except Exception as e:
        err = str(e).splitlines()[0]
        msg = err[:90]
        kind = "RESOLVE" if "not found in path" in err else "LOAD_FAIL"
        print(f"{kind}  {msg}", flush=True)
        return {"label": label, "quant": quant or "fp32", "status": kind, "err": err[:300]}
    load_s = time.perf_counter() - t0

    try:
        t1 = time.perf_counter()
        res = t.transcribe(audio, language="en")
        infer_s = time.perf_counter() - t1
    except Exception as e:
        print(f"INFER_FAIL  {str(e).splitlines()[0][:90]}", flush=True)
        with contextlib.suppress(Exception):
            t.shutdown()
        return {"label": label, "quant": quant or "fp32", "status": "INFER_FAIL", "err": str(e)[:300], "load_s": load_s}

    text = res.text.strip()
    similarity = SequenceMatcher(None, baseline.lower(), text.lower()).ratio() if baseline else 0.0
    if not text:
        status = "EMPTY"
    elif similarity >= 0.85:
        status = "OK"
    elif similarity >= 0.5:
        status = "DEGRADED"
    else:
        status = "DIVERGENT"

    print(f"{status:10s} sim={similarity:.2f}  load={load_s:.1f}s infer={infer_s:.1f}s  text={text[:60]!r}", flush=True)
    with contextlib.suppress(Exception):
        t.shutdown()
    gc.collect()
    return {
        "label": label,
        "quant": quant or "fp32",
        "status": status,
        "similarity": round(similarity, 3),
        "load_s": round(load_s, 2),
        "infer_s": round(infer_s, 2),
        "text": text,
    }


results: dict[str, dict[str, dict]] = {}
for model_id, repo in REPOS.items():
    print(f"\n=== {model_id}  ({repo}) ===")
    # Baseline = fp32 (None quant). Establish first.
    fp32 = bench_one(model_id, repo, None, baseline="")
    baseline_text = fp32.get("text", "")
    results[model_id] = {"fp32": fp32}
    for q in QUANTS[1:]:
        r = bench_one(model_id, repo, q, baseline=baseline_text)
        results[model_id][q] = r

Path("<repo>/server/scratch/bench_quant_matrix.json").write_text(
    json.dumps(results, indent=2, default=str)
)

# Final matrix
print("\n\n==== MATRIX (status per model x quant) ====")
header_quants = ["fp32", "fp16", "int8", "uint8", "q4", "q4f16", "bnb4"]
print(f"{'model':36s} " + " ".join(f"{q:11s}" for q in header_quants))
for model_id in REPOS:
    row = [model_id]
    for q in header_quants:
        r = results[model_id].get(q, {})
        row.append(r.get("status", "?")[:11])
    print(f"{row[0]:36s} " + " ".join(f"{c:11s}" for c in row[1:]))

# Derived per-model recommendations
print("\n\n==== RECOMMENDED available_quantizations PER MODEL ====")
recs: dict[str, list[str]] = {}
for model_id, by_quant in results.items():
    good = []
    for q in header_quants:
        st = by_quant.get(q, {}).get("status", "?")
        if st == "OK":
            good.append("" if q == "fp32" else q)
    recs[model_id] = good
    print(f"{model_id:36s} -> {good}")

Path("<repo>/server/scratch/quant_recommendations.json").write_text(json.dumps(recs, indent=2))
