"""Benchmark Whisper tiny.en across stacks and quantizations.

Stacks
------
* onnx_asr (status quo): native ORT over onnx-community merged decoder
* optimum.ORTModelForSpeechSeq2Seq: HF wrapper, also onnx-community files
* sherpa-onnx: k2-fsa's standalone runtime + their own ONNX exports

Each stack is timed for (a) cold load (b) inference on the 203s
physicsworks.wav clip, on CPU first (GPU later if time permits). The
text outputs are dumped so we can spot divergences vs the fp32
baseline.
"""

from __future__ import annotations

import json
import time
import traceback
from pathlib import Path

import numpy as np
import soundfile as sf

AUDIO_PATH = Path(r"E:\DL\Projects\WinSTT\examples\faster-whisper\tests\data\physicsworks.wav")
PROVIDER = "CPUExecutionProvider"


def load_audio() -> tuple[np.ndarray, int]:
    audio, sr = sf.read(str(AUDIO_PATH), dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        import scipy.signal

        audio = scipy.signal.resample(audio, int(len(audio) * 16000 / sr)).astype(np.float32)
        sr = 16000
    return audio, sr


def fmt_dur(s: float) -> str:
    return f"{s:.2f}s"


# --- onnx_asr ---
def run_onnxasr(audio: np.ndarray, sr: int, quant: str | None) -> dict:
    import onnx_asr
    import onnxruntime as rt

    opts = rt.SessionOptions()
    # fp16 encoder needs LAYOUT-level optimizer disabled (see earlier analysis)
    if quant == "fp16":
        opts.graph_optimization_level = rt.GraphOptimizationLevel.ORT_ENABLE_EXTENDED

    t0 = time.perf_counter()
    kwargs: dict = {"providers": [PROVIDER], "sess_options": opts}
    if quant:
        kwargs["quantization"] = quant
    try:
        model = onnx_asr.load_model("onnx-community/whisper-tiny.en", **kwargs)
        load_s = time.perf_counter() - t0
    except Exception as e:
        return {
            "stack": "onnx_asr",
            "quant": quant or "fp32",
            "error": f"load: {type(e).__name__}: {str(e).splitlines()[0]}",
        }

    t1 = time.perf_counter()
    try:
        text = model.recognize(audio, sample_rate=sr)
        infer_s = time.perf_counter() - t1
    except Exception as e:
        return {
            "stack": "onnx_asr",
            "quant": quant or "fp32",
            "load_s": load_s,
            "error": f"infer: {type(e).__name__}: {str(e).splitlines()[0]}",
        }

    return {
        "stack": "onnx_asr",
        "quant": quant or "fp32",
        "load_s": load_s,
        "infer_s": infer_s,
        "audio_s": len(audio) / sr,
        "rtf": (len(audio) / sr) / infer_s,
        "text": text,
    }


# --- optimum ---
def run_optimum(audio: np.ndarray, sr: int, *, use_merged: bool, dtype: str = "fp32") -> dict:
    from optimum.onnxruntime import ORTModelForSpeechSeq2Seq
    from transformers import AutoProcessor

    label = f"optimum-{'merged' if use_merged else 'split'}-{dtype}"
    t0 = time.perf_counter()
    try:
        # `file_name` selects fp16 vs fp32 encoder; `decoder_file_name` and
        # `decoder_with_past_file_name` select the decoder pair when not merged.
        # For merged, use `decoder_file_name`="decoder_model_merged.onnx".
        kwargs: dict = {
            "provider": PROVIDER.replace("ExecutionProvider", "").lower() + "_provider_options",  # not actually used
            "use_io_binding": False,
        }
        # ORTModelForSpeechSeq2Seq picks providers via `provider="CPUExecutionProvider"`
        kwargs = {"provider": PROVIDER}
        if dtype == "fp16":
            kwargs["file_name"] = "encoder_model_fp16.onnx"
            if use_merged:
                kwargs["decoder_file_name"] = "decoder_model_merged_fp16.onnx"
            else:
                # whisper-tiny.en doesn't ship split decoders; will error
                kwargs["decoder_file_name"] = "decoder_model_fp16.onnx"
                kwargs["decoder_with_past_file_name"] = "decoder_with_past_model_fp16.onnx"
        else:
            if use_merged:
                kwargs["decoder_file_name"] = "decoder_model_merged.onnx"

        model = ORTModelForSpeechSeq2Seq.from_pretrained(
            "onnx-community/whisper-tiny.en",
            **kwargs,
            use_cache=use_merged,
            use_merged=use_merged,
        )
        processor = AutoProcessor.from_pretrained("onnx-community/whisper-tiny.en")
        load_s = time.perf_counter() - t0
    except Exception as e:
        return {"stack": label, "error": f"load: {type(e).__name__}: {str(e).splitlines()[0]}"}

    t1 = time.perf_counter()
    try:
        # Whisper expects chunked input — but for tiny model on a 203s clip,
        # use long-form generate with chunk_length_s
        inputs = processor(audio, sampling_rate=sr, return_tensors="pt")
        gen = model.generate(
            inputs.input_features,
            max_new_tokens=256,
        )
        text = processor.batch_decode(gen, skip_special_tokens=True)[0]
        infer_s = time.perf_counter() - t1
    except Exception as e:
        return {
            "stack": label,
            "load_s": load_s,
            "error": f"infer: {type(e).__name__}: {str(e).splitlines()[0]}\n{traceback.format_exc()[-500:]}",
        }

    return {
        "stack": label,
        "load_s": load_s,
        "infer_s": infer_s,
        "audio_s": len(audio) / sr,
        "rtf": (len(audio) / sr) / infer_s,
        "text": text,
    }


# --- sherpa-onnx ---
def run_sherpa(audio: np.ndarray, sr: int, model_dir: Path) -> dict:
    import sherpa_onnx

    t0 = time.perf_counter()
    try:
        recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=str(model_dir / "tiny.en-encoder.onnx"),
            decoder=str(model_dir / "tiny.en-decoder.onnx"),
            tokens=str(model_dir / "tiny.en-tokens.txt"),
            provider="cpu",
            num_threads=4,
            language="en",
            task="transcribe",
            tail_paddings=2000,
        )
        load_s = time.perf_counter() - t0
    except Exception as e:
        return {"stack": "sherpa-onnx", "error": f"load: {type(e).__name__}: {e}"}

    t1 = time.perf_counter()
    try:
        stream = recognizer.create_stream()
        stream.accept_waveform(sr, audio)
        recognizer.decode_stream(stream)
        text = stream.result.text
        infer_s = time.perf_counter() - t1
    except Exception as e:
        return {"stack": "sherpa-onnx", "load_s": load_s, "error": f"infer: {type(e).__name__}: {e}"}

    return {
        "stack": "sherpa-onnx",
        "load_s": load_s,
        "infer_s": infer_s,
        "audio_s": len(audio) / sr,
        "rtf": (len(audio) / sr) / infer_s,
        "text": text,
    }


def main() -> None:
    audio, sr = load_audio()
    print(f"audio: {len(audio) / sr:.1f}s @ {sr}Hz", flush=True)

    results: list[dict] = []

    # ---- onnx_asr (our current stack) ----
    for q in [None, "fp16", "int8", "uint8"]:
        print(f"\n--- onnx_asr quant={q} ---", flush=True)
        r = run_onnxasr(audio, sr, q)
        results.append(r)
        print(json.dumps({k: v for k, v in r.items() if k != "text"}, default=str), flush=True)
        if "text" in r:
            print(f"  text[:120]: {r['text'][:120]!r}", flush=True)

    # ---- optimum ----
    for use_merged, dtype in [(True, "fp32"), (False, "fp32"), (True, "fp16")]:
        print(f"\n--- optimum merged={use_merged} dtype={dtype} ---", flush=True)
        r = run_optimum(audio, sr, use_merged=use_merged, dtype=dtype)
        results.append(r)
        print(json.dumps({k: v for k, v in r.items() if k != "text"}, default=str), flush=True)
        if "text" in r:
            print(f"  text[:120]: {r['text'][:120]!r}", flush=True)

    # ---- sherpa-onnx ----
    sherpa_dir = Path(r"C:\Users\MASTE\.cache\sherpa-onnx-whisper-tiny.en")
    if sherpa_dir.exists():
        print("\n--- sherpa-onnx ---", flush=True)
        r = run_sherpa(audio, sr, sherpa_dir)
        results.append(r)
        print(json.dumps({k: v for k, v in r.items() if k != "text"}, default=str), flush=True)
        if "text" in r:
            print(f"  text[:120]: {r['text'][:120]!r}", flush=True)
    else:
        print(f"\n[skip] sherpa model not at {sherpa_dir}", flush=True)

    # Summary table
    print("\n\n==== SUMMARY ====", flush=True)
    print(f"{'stack':40s} {'load':>8s} {'infer':>8s} {'rtf':>8s}  {'status'}", flush=True)
    for r in results:
        status = "OK" if "text" in r else r.get("error", "?")[:80]
        print(
            f"{r.get('stack', '?'):40s} "
            f"{fmt_dur(r['load_s']) if 'load_s' in r else '-':>8s} "
            f"{fmt_dur(r['infer_s']) if 'infer_s' in r else '-':>8s} "
            f"{r.get('rtf', 0):>7.1f}x  "
            f"{status}",
            flush=True,
        )

    Path("E:/DL/Projects/WinSTT/server/scratch/bench_results.json").write_text(
        json.dumps(results, indent=2, default=str)
    )


if __name__ == "__main__":
    main()
