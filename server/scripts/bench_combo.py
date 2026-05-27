"""Combined-knob sweep across multiple models + EPs.

Tests promising knob combinations from earlier CUDA sweep:
- do_copy_in_default_stream (true/false)
- arena_extend_strategy (kNextPowerOfTwo / kSameAsRequested)
- cudnn_conv_use_max_workspace (1/0)
- inter_op_num_threads (0/1)
- enable_mem_reuse via config entry
- session.use_env_allocators (1/0)

Validates byte-identical transcripts across configs.
Run with: `uv run python scripts/bench_combo.py <model> <iters> <duration> [--gpu]`
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


def make_opts(
    *,
    intra: int = 2,
    inter: int = 0,
    mem_pattern: bool = True,
    cpu_arena: bool = True,
    config_entries: dict[str, str] | None = None,
) -> rt.SessionOptions:
    opts = rt.SessionOptions()
    opts.intra_op_num_threads = intra
    opts.inter_op_num_threads = inter
    opts.enable_mem_pattern = mem_pattern
    opts.enable_cpu_mem_arena = cpu_arena
    opts.graph_optimization_level = rt.GraphOptimizationLevel.ORT_ENABLE_ALL  # type: ignore[attr-defined]
    if config_entries:
        for k, v in config_entries.items():
            opts.add_session_config_entry(k, v)
    return opts


def run_one(
    model_name: str,
    audio: np.ndarray,
    sess_opts: rt.SessionOptions,
    cuda_opts: dict[str, str] | None,
    iters: int,
    use_gpu: bool,
) -> tuple[list[float], str]:
    import onnx_asr

    orig = onnx_asr.load_model

    def patched(name: str, **kwargs: object) -> object:
        kwargs["sess_options"] = sess_opts
        if cuda_opts is not None and use_gpu:
            providers: list[object] = [
                ("CUDAExecutionProvider", dict(cuda_opts, device_id="0")),
                "CPUExecutionProvider",
            ]
            kwargs["providers"] = providers
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


def gpu_configs(intra: int = 2) -> list[tuple[str, rt.SessionOptions, dict[str, str] | None]]:
    return [
        ("(baseline = wrapper default intra=2)", make_opts(intra=intra), None),
        ("+do_copy_in_default_stream=1", make_opts(intra=intra), {"do_copy_in_default_stream": "1"}),
        ("+arena=kNextPowerOfTwo", make_opts(intra=intra), {"arena_extend_strategy": "kNextPowerOfTwo"}),
        ("+max_workspace=1", make_opts(intra=intra), {"cudnn_conv_use_max_workspace": "1"}),
        (
            "ALL: do_copy + arena=NextP2 + max_workspace",
            make_opts(intra=intra),
            {
                "do_copy_in_default_stream": "1",
                "arena_extend_strategy": "kNextPowerOfTwo",
                "cudnn_conv_use_max_workspace": "1",
            },
        ),
        (
            "ALL + use_env_allocators",
            make_opts(intra=intra, config_entries={"session.use_env_allocators": "1"}),
            {
                "do_copy_in_default_stream": "1",
                "arena_extend_strategy": "kNextPowerOfTwo",
                "cudnn_conv_use_max_workspace": "1",
            },
        ),
        ("intra=1 + do_copy", make_opts(intra=1), {"do_copy_in_default_stream": "1"}),
        ("intra=3 + do_copy", make_opts(intra=3), {"do_copy_in_default_stream": "1"}),
    ]


def cpu_configs(intra: int = 8) -> list[tuple[str, rt.SessionOptions, dict[str, str] | None]]:
    return [
        ("(baseline = wrapper default intra=8)", make_opts(intra=intra), None),
        ("intra=6", make_opts(intra=6), None),
        ("intra=8 + inter=1", make_opts(intra=intra, inter=1), None),
        ("intra=8 + inter=2", make_opts(intra=intra, inter=2), None),
        ("intra=8 + spin=0", make_opts(intra=intra, config_entries={"session.intra_op.allow_spinning": "0"}), None),
        ("intra=8 + spin=1", make_opts(intra=intra, config_entries={"session.intra_op.allow_spinning": "1"}), None),
        ("intra=8 + env_alloc", make_opts(intra=intra, config_entries={"session.use_env_allocators": "1"}), None),
        ("intra=8 + no-arena", make_opts(intra=intra, cpu_arena=False), None),
        (
            "intra=8 + spin=1 + env_alloc",
            make_opts(
                intra=intra,
                config_entries={
                    "session.intra_op.allow_spinning": "1",
                    "session.use_env_allocators": "1",
                },
            ),
            None,
        ),
    ]


def main() -> int:
    model = sys.argv[1] if len(sys.argv) > 1 else "istupakov/canary-180m-flash-onnx"
    iters = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    dur = float(sys.argv[3]) if len(sys.argv) > 3 else 6.0
    use_gpu = "--gpu" in sys.argv
    audio = make_audio(dur)

    ep_label = "CUDA" if use_gpu else "CPU"
    print(f"\n=== Combo sweep: {model} ({iters} iters, {dur:.1f}s, {ep_label}) ===\n")

    configs = gpu_configs() if use_gpu else cpu_configs()
    rows: list[tuple[str, float, float, float, bool]] = []
    baseline_text: str | None = None
    for label, opts, cuda_opt in configs:
        try:
            samples, text = run_one(model, audio, opts, cuda_opt, iters, use_gpu=use_gpu)
        except Exception as e:
            print(f"  {label:<55}  FAILED: {type(e).__name__}: {str(e)[:60]}")
            continue
        med = statistics.median(samples) * 1000
        mn = min(samples) * 1000
        mx = max(samples) * 1000
        if baseline_text is None:
            baseline_text = text
        identical = text == baseline_text
        rows.append((label, med, mn, mx, identical))
        marker = "OK " if identical else "** DRIFT **"
        print(f"  {label:<55}  med={med:7.2f}  min={mn:7.2f}  max={mx:7.2f}  {marker}")

    if rows:
        print()
        base_med = rows[0][1]
        print(f"  {'config':<55}  {'med':>8}  {'vs base':>9}  drift?")
        rows_sorted = sorted(rows, key=lambda r: r[1])
        for label, med, _, _, identical in rows_sorted:
            delta = (med - base_med) / base_med * 100
            delta_str = ("+" if delta >= 0 else "") + f"{delta:6.1f}%"
            drift = "OK" if identical else "**DRIFT**"
            print(f"  {label:<55}  {med:7.2f}ms  {delta_str:>9}  {drift}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
