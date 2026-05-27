"""Deep CUDA EP option sweep — beyond intra_op_num_threads.

CUDA EP accepts a rich set of provider-options that materially affect
performance on small autoregressive workloads:

* ``cudnn_conv_algo_search`` — HEURISTIC vs EXHAUSTIVE
* ``do_copy_in_default_stream`` — stream synchronization
* ``arena_extend_strategy`` — kNextPowerOfTwo vs kSameAsRequested
* ``cudnn_conv_use_max_workspace`` — workspace ceiling
* ``enable_cuda_graph`` — capture+replay graph (potentially huge for fixed-shape ops)
* ``tunable_op_enable`` / ``tunable_op_tuning_enable`` — kernel auto-tuning

Also tests ``session.intra_op.allow_spinning`` config entry which controls
thread spin-vs-sleep behavior — relevant when intra=2 and threads are
mostly idle waiting on GPU.

Every config is checked for byte-identical transcript output. Drift = reject.
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


def make_audio(duration_s: float = 6.0, sample_rate: int = 16_000) -> np.ndarray:
    wav = ROOT.parent / "examples" / "diart" / "tests" / "data" / "audio" / "sample.wav"
    if wav.exists():
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
        target_n = int(duration_s * sample_rate)
        if len(audio) > target_n:
            audio = audio[:target_n]
        elif len(audio) < target_n:
            audio = np.concatenate([audio, np.zeros(target_n - len(audio), dtype=np.float32)])
        return audio
    rng = np.random.default_rng(0xC0FFEE)
    t = np.arange(int(duration_s * sample_rate), dtype=np.float32) / sample_rate
    a = 0.3 * np.sin(2 * np.pi * 440 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.5 * t))
    return a + 0.02 * rng.standard_normal(t.shape).astype(np.float32)


def make_sess_opts(
    *,
    intra: int = 2,
    inter: int = 0,
    mem_pattern: bool = True,
    cpu_arena: bool = True,
    config_entries: dict[str, str] | None = None,
    graph_level: int = rt.GraphOptimizationLevel.ORT_ENABLE_ALL,  # type: ignore[attr-defined]
) -> rt.SessionOptions:
    opts = rt.SessionOptions()
    opts.intra_op_num_threads = intra
    opts.inter_op_num_threads = inter
    opts.enable_mem_pattern = mem_pattern
    opts.enable_cpu_mem_arena = cpu_arena
    opts.graph_optimization_level = graph_level
    if config_entries:
        for k, v in config_entries.items():
            opts.add_session_config_entry(k, v)
    return opts


def cuda_providers(opts: dict[str, str] | None = None) -> list[object]:
    cuda_opt = dict(opts) if opts else {}
    cuda_opt.setdefault("device_id", "0")
    return [("CUDAExecutionProvider", cuda_opt), "CPUExecutionProvider"]


def run_one(
    model_name: str,
    audio: np.ndarray,
    sess_opts: rt.SessionOptions | None,
    cuda_opts: dict[str, str] | None,
    iters: int,
) -> tuple[list[float], str]:
    import onnx_asr

    orig = onnx_asr.load_model

    def patched(name: str, **kwargs: object) -> object:
        if sess_opts is not None:
            kwargs["sess_options"] = sess_opts
        if cuda_opts is not None:
            kwargs["providers"] = cuda_providers(cuda_opts)
        return orig(name, **kwargs)

    onnx_asr.load_model = patched  # type: ignore[assignment]
    try:
        tx = OnnxAsrTranscriber(
            model_name=model_name,
            quantization=None,
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
            segment_with_vad=False,
            normalize_audio=True,
        )
        for _ in range(3):  # warmup
            tx.transcribe(audio)
        samples: list[float] = []
        first_text: str | None = None
        for _ in range(iters):
            t0 = time.perf_counter()
            r = tx.transcribe(audio)
            samples.append(time.perf_counter() - t0)
            if first_text is None:
                first_text = r.text
        tx.shutdown()
        return samples, first_text or ""
    finally:
        onnx_asr.load_model = orig  # type: ignore[assignment]


CONFIGS: list[tuple[str, rt.SessionOptions | None, dict[str, str] | None]] = [
    # Baseline (no overrides — use ORT defaults completely)
    ("baseline (defaults)", None, None),
    # Our tuned default (intra=2, default CUDA)
    ("intra=2 only", make_sess_opts(intra=2), None),
    # cuDNN search variations
    ("intra=2 + cudnn=HEURISTIC", make_sess_opts(intra=2), {"cudnn_conv_algo_search": "HEURISTIC"}),
    ("intra=2 + cudnn=EXHAUSTIVE", make_sess_opts(intra=2), {"cudnn_conv_algo_search": "EXHAUSTIVE"}),
    ("intra=2 + cudnn=DEFAULT", make_sess_opts(intra=2), {"cudnn_conv_algo_search": "DEFAULT"}),
    # Stream copy
    ("intra=2 + do_copy_default_stream=true", make_sess_opts(intra=2), {"do_copy_in_default_stream": "1"}),
    ("intra=2 + do_copy_default_stream=false", make_sess_opts(intra=2), {"do_copy_in_default_stream": "0"}),
    # Arena strategy
    ("intra=2 + arena=kSameAsRequested", make_sess_opts(intra=2), {"arena_extend_strategy": "kSameAsRequested"}),
    ("intra=2 + arena=kNextPowerOfTwo", make_sess_opts(intra=2), {"arena_extend_strategy": "kNextPowerOfTwo"}),
    # cuDNN workspace
    ("intra=2 + max_workspace=1", make_sess_opts(intra=2), {"cudnn_conv_use_max_workspace": "1"}),
    ("intra=2 + max_workspace=0", make_sess_opts(intra=2), {"cudnn_conv_use_max_workspace": "0"}),
    # Spin-wait control via session config entry
    (
        "intra=2 + allow_spinning=0",
        make_sess_opts(intra=2, config_entries={"session.intra_op.allow_spinning": "0"}),
        None,
    ),
    (
        "intra=2 + allow_spinning=1",
        make_sess_opts(intra=2, config_entries={"session.intra_op.allow_spinning": "1"}),
        None,
    ),
    # CUDA graph mode (replay) — may not work with dynamic shapes
    ("intra=2 + cuda_graph", make_sess_opts(intra=2), {"enable_cuda_graph": "1"}),
    # Combo: cuDNN HEURISTIC + no spin + heuristic search
    (
        "combo: intra=2 + cudnn=HEURISTIC + spin=0 + arena=kSameAsRequested",
        make_sess_opts(intra=2, config_entries={"session.intra_op.allow_spinning": "0"}),
        {"cudnn_conv_algo_search": "HEURISTIC", "arena_extend_strategy": "kSameAsRequested"},
    ),
    # intra=1
    ("intra=1", make_sess_opts(intra=1), None),
    ("intra=4 (control)", make_sess_opts(intra=4), None),
    # disable mem_pattern (sometimes faster for variable-shape)
    ("intra=2 + no-mempattern", make_sess_opts(intra=2, mem_pattern=False), None),
]


def main() -> int:
    model = sys.argv[1] if len(sys.argv) > 1 else "istupakov/canary-180m-flash-onnx"
    iters = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    dur = float(sys.argv[3]) if len(sys.argv) > 3 else 6.0
    audio = make_audio(dur)

    print(f"\n=== CUDA-deep sweep: {model} (N={iters}, {dur:.1f}s audio) ===\n")

    rows: list[tuple[str, float, float, float, bool]] = []
    baseline_text: str | None = None
    for label, opts, cuda_opt in CONFIGS:
        try:
            samples, text = run_one(model, audio, opts, cuda_opt, iters)
        except Exception as e:  # noqa: BLE001
            print(f"  {label:<58}  FAILED: {type(e).__name__}: {str(e)[:80]}")
            continue
        med = statistics.median(samples) * 1000
        mn = min(samples) * 1000
        mx = max(samples) * 1000
        if baseline_text is None:
            baseline_text = text
        identical = text == baseline_text
        rows.append((label, med, mn, mx, identical))
        marker = "OK " if identical else "** DRIFT **"
        print(f"  {label:<58}  med={med:7.2f}  min={mn:7.2f}  max={mx:7.2f}  {marker}")

    if rows:
        print()
        base_med = rows[0][1]
        print(f"  {'config':<58}  {'med':>8}  {'vs base':>9}  drift?")
        rows_sorted = sorted(rows, key=lambda r: r[1])
        for label, med, _, _, identical in rows_sorted:
            delta = (med - base_med) / base_med * 100
            print(f"  {label:<58}  {med:7.2f}ms  {('+' if delta >= 0 else '') + f'{delta:6.1f}%':>9}  {'OK' if identical else '**DRIFT**'}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
