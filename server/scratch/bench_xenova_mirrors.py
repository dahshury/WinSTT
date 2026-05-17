"""Verify the catalog's Xenova mirror entries for medium.en / large-v3 load
end-to-end via OnnxAsrTranscriber. medium was already verified."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import soundfile as sf

sys.path.insert(0, r"E:\DL\Projects\WinSTT\server")

from src.recorder.domain.model_registry import ModelCatalog
from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

AUDIO = Path(r"E:\DL\Projects\WinSTT\examples\faster-whisper\tests\data\physicsworks.wav")
audio, sr = sf.read(str(AUDIO), dtype="float32")
if audio.ndim > 1:
    audio = audio.mean(axis=1)
clip = audio[: 16_000 * 10]
print(f"audio: {len(clip) / sr:.1f}s")

catalog = ModelCatalog()
for model_id in ("medium.en", "large-v3"):
    info = catalog.get(model_id)
    assert info is not None
    repo = info.onnx_model_name
    quants = info.available_quantizations
    print(f"\n=== {model_id} -> {repo} (quants={quants}) ===")
    # Resolve via catalog: use the canonical repo + only the quants the
    # catalog actually offers. Test each.
    for quant in quants:
        label = quant or "fp32"
        print(f"  -- {label} --")
        t0 = time.perf_counter()
        try:
            t = OnnxAsrTranscriber(
                model_name=repo,
                quantization=quant or None,
                providers=["CPUExecutionProvider"],
                segment_with_vad=False,
            )
            load_s = time.perf_counter() - t0
            print(f"    load: {load_s:.1f}s")
        except Exception as e:
            print(f"    LOAD FAIL: {str(e).splitlines()[0][:160]}")
            continue
        t1 = time.perf_counter()
        try:
            res = t.transcribe(clip, language="")
            print(f"    infer: {time.perf_counter() - t1:.1f}s   text[:100]: {res.text[:100]!r}")
        except Exception as e:
            print(f"    INFER FAIL: {str(e).splitlines()[0][:160]}")
        try:
            t.shutdown()
        except Exception:
            pass
