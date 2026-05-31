"""Matrix benchmark — models x audio durations x EPs.

Maps the optimization curve across the realistic workload variety:
* Short audio (1-3 s) — realtime-tick path (live preview)
* Medium audio (5-10 s) — typical PTT utterance
* Long audio (20-29 s) — full-buffer transcribe

Compares: ORT defaults vs the wrapper's tuned thread+option config.

Run with: `uv run python scripts/bench_matrix.py [--gpu]`
"""

from __future__ import annotations

import statistics
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as rt

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber  # noqa: E402


def load_speech(target_duration_s: float, sample_rate: int = 16_000) -> np.ndarray:
    wav = ROOT.parent / "examples" / "diart" / "tests" / "data" / "audio" / "sample.wav"
    import wave

    with wave.open(str(wav), "rb") as w:
        rate = w.getframerate()
        nframes = w.getnframes()
        pcm = w.readframes(nframes)
        nch = w.getnchannels()
    audio_i16 = np.frombuffer(pcm, dtype=np.int16)
    if nch == 2:
        audio_i16 = audio_i16.reshape(-1, 2).mean(axis=1).astype(np.int16)
    audio = audio_i16.astype(np.float32) / 32768.0
    if rate != sample_rate:
        old_t = np.linspace(0, len(audio) / rate, len(audio), endpoint=False)
        new_n = int(len(audio) * sample_rate / rate)
        new_t = np.linspace(0, len(audio) / rate, new_n, endpoint=False)
        audio = np.interp(new_t, old_t, audio).astype(np.float32)
    target_n = int(target_duration_s * sample_rate)
    if len(audio) > target_n:
        return audio[:target_n]
    # Loop the sample to reach target duration
    n_loops = (target_n // len(audio)) + 1
    looped = np.tile(audio, n_loops)
    return looped[:target_n]


def baseline_opts() -> rt.SessionOptions:
    """ORT default — completely unmodified."""
    return rt.SessionOptions()


def tuned_opts(*, is_gpu: bool) -> rt.SessionOptions:
    """The wrapper's tuned defaults (intra=2 GPU / intra=8 CPU)."""
    opts = rt.SessionOptions()
    opts.intra_op_num_threads = 2 if is_gpu else 8
    return opts


def make_cuda_providers(*, do_copy: bool = False) -> list[object]:
    cuda_opts: dict[str, str] = {"device_id": "0"}
    if do_copy:
        cuda_opts["do_copy_in_default_stream"] = "1"
    return [("CUDAExecutionProvider", cuda_opts), "CPUExecutionProvider"]


def time_one(
    model_name: str,
    audio: np.ndarray,
    sess_opts: rt.SessionOptions | None,
    providers_override: list[object] | None,
    iters: int,
    use_gpu: bool,
) -> tuple[float, float, float, str]:
    import onnx_asr

    orig = onnx_asr.load_model

    def patched(name: str, **kwargs: object) -> object:
        if sess_opts is not None:
            kwargs["sess_options"] = sess_opts
        if providers_override is not None:
            kwargs["providers"] = providers_override
        return orig(name, **kwargs)

    onnx_asr.load_model = patched  # type: ignore[assignment]
    try:
        prov_list = ["CUDAExecutionProvider", "CPUExecutionProvider"] if use_gpu else ["CPUExecutionProvider"]
        tx = OnnxAsrTranscriber(
            model_name=model_name,
            quantization=None,
            providers=prov_list,
            segment_with_vad=False,
            normalize_audio=True,
        )
        for _ in range(3):
            tx.transcribe(audio)
        samples = []
        first_text: str | None = None
        for _ in range(iters):
            t0 = time.perf_counter()
            r = tx.transcribe(audio)
            samples.append(time.perf_counter() - t0)
            if first_text is None:
                first_text = r.text
        tx.shutdown()
        med = statistics.median(samples) * 1000
        mn = min(samples) * 1000
        mx = max(samples) * 1000
        return med, mn, mx, first_text or ""
    finally:
        onnx_asr.load_model = orig  # type: ignore[assignment]


MODELS = [
    "onnx-community/whisper-tiny",
    "onnx-community/whisper-base.en",
    "onnx-community/moonshine-tiny-ONNX",
    "onnx-community/moonshine-base-ONNX",
    "istupakov/canary-180m-flash-onnx",
]
DURATIONS = [1.0, 3.0, 6.0, 12.0, 20.0]


def main() -> int:
    use_gpu = "--gpu" in sys.argv
    iters = 10 if use_gpu else 8
    label = "CUDA" if use_gpu else "CPU"
    print(f"\n=== Matrix: models x duration ({label}, N={iters}) ===\n")
    print(f"  {'model':<46} {'audio':>7} {'baseline':>10} {'tuned':>10} {'+do_copy':>10} {'best':>8}  drift?")
    for model in MODELS:
        for dur in DURATIONS:
            audio = load_speech(dur)
            # Baseline = ORT pure defaults (no sess_opts, no providers override beyond list)
            try:
                base_med, _, _, base_text = time_one(model, audio, baseline_opts(), None, iters, use_gpu)
            except Exception as e:
                print(f"  {model:<46} {dur:>5.1f}s  BASELINE FAILED: {type(e).__name__}: {str(e)[:50]}")
                continue
            # Tuned = wrapper's intra-only tuning
            tuned_med, _, _, tuned_text = time_one(model, audio, tuned_opts(is_gpu=use_gpu), None, iters, use_gpu)
            # Tuned + do_copy_in_default_stream (CUDA only — otherwise same as tuned)
            if use_gpu:
                docopy_med, _, _, docopy_text = time_one(
                    model, audio, tuned_opts(is_gpu=True), make_cuda_providers(do_copy=True), iters, use_gpu
                )
            else:
                docopy_med = tuned_med
                docopy_text = tuned_text
            best = min(base_med, tuned_med, docopy_med)
            drift = (tuned_text != base_text) or (docopy_text != base_text)
            tuned_delta = (tuned_med - base_med) / base_med * 100
            docopy_delta = (docopy_med - base_med) / base_med * 100
            best_label = "base" if best == base_med else ("tuned" if best == tuned_med else "do_copy")
            print(
                f"  {model:<46} {dur:>5.1f}s  {base_med:7.2f}ms  "
                f"{tuned_med:7.2f}ms  {docopy_med:7.2f}ms  {best_label:>8}  "
                f"{'**DRIFT**' if drift else 'OK'}    "
                f"tuned={tuned_delta:+6.1f}%  +do_copy={docopy_delta:+6.1f}%"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
