"""Sweep ORT session-option configurations and compare per-call latency
WITHOUT changing model output. Each config is exercised on the same audio;
transcripts are diffed across configs to verify byte-identical output.

We do NOT change quantization, model, or precision. Only knobs that
modify host-side performance behavior (threading, memory arena, optimization
level) — all of which are documented as functionally transparent.
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
    """Load real speech if available; fall back to a synthetic tone.

    Real speech is required for the bit-identity DRIFT check to be
    meaningful — synthetic sines produce empty transcripts regardless
    of session-option choices, so "no drift" is not informative.
    """
    examples_dir = Path(__file__).resolve().parent.parent.parent / "examples"
    candidates = [
        examples_dir / "diart" / "tests" / "data" / "audio" / "sample.wav",
        (
            examples_dir
            / "openWakeWord"
            / "notebooks"
            / "training_tutorial_data"
            / "turn_on_the_office_lights_test_clip.wav"
        ),
    ]
    for wav_path in candidates:
        if wav_path.exists():
            import wave

            with wave.open(str(wav_path), "rb") as w:
                rate = w.getframerate()
                nframes = w.getnframes()
                sample_width = w.getsampwidth()
                pcm = w.readframes(nframes)
            if sample_width != 2:
                continue
            audio_i16 = np.frombuffer(pcm, dtype=np.int16)
            if w.getnchannels() == 2:
                audio_i16 = audio_i16.reshape(-1, 2).mean(axis=1).astype(np.int16)
            audio = audio_i16.astype(np.float32) / 32768.0
            # Resample by simple decimation/interp to 16 kHz if needed
            if rate != sample_rate:
                # Naive linear interp — for benchmark purposes only
                old_t = np.linspace(0, len(audio) / rate, len(audio), endpoint=False)
                new_n = int(len(audio) * sample_rate / rate)
                new_t = np.linspace(0, len(audio) / rate, new_n, endpoint=False)
                audio = np.interp(new_t, old_t, audio).astype(np.float32)
            # Truncate or pad to requested duration
            target_n = int(duration_s * sample_rate)
            if len(audio) > target_n:
                audio = audio[:target_n]
            elif len(audio) < target_n:
                audio = np.concatenate([audio, np.zeros(target_n - len(audio), dtype=np.float32)])
            print(f"  [audio] loaded real speech from {wav_path.name}")
            return audio
    # Fallback: synthetic sine
    print("  [audio] falling back to synthetic sine")
    rng = np.random.default_rng(0xC0FFEE)
    t = np.arange(int(duration_s * sample_rate), dtype=np.float32) / sample_rate
    audio = 0.3 * np.sin(2 * np.pi * 440 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.5 * t))
    audio += 0.02 * rng.standard_normal(t.shape).astype(np.float32)
    return audio.astype(np.float32, copy=False)


def make_sess_opts(
    *,
    graph_level: int = rt.GraphOptimizationLevel.ORT_ENABLE_ALL,  # type: ignore[attr-defined]
    intra_threads: int = 0,
    inter_threads: int = 0,
    mem_pattern: bool = True,
    cpu_arena: bool = True,
    execution_mode: int = rt.ExecutionMode.ORT_SEQUENTIAL,  # type: ignore[attr-defined]
) -> rt.SessionOptions:
    opts = rt.SessionOptions()
    opts.graph_optimization_level = graph_level
    opts.intra_op_num_threads = intra_threads
    opts.inter_op_num_threads = inter_threads
    opts.enable_mem_pattern = mem_pattern
    opts.enable_cpu_mem_arena = cpu_arena
    opts.execution_mode = execution_mode
    return opts


CONFIGS: list[tuple[str, rt.SessionOptions | None]] = [
    ("baseline (defaults)", None),
    ("intra=2", make_sess_opts(intra_threads=2)),
    ("intra=4", make_sess_opts(intra_threads=4)),
    ("intra=6", make_sess_opts(intra_threads=6)),
    ("intra=8", make_sess_opts(intra_threads=8)),
    ("intra=10", make_sess_opts(intra_threads=10)),
    ("intra=12", make_sess_opts(intra_threads=12)),
    ("intra=8, no-mempattern", make_sess_opts(intra_threads=8, mem_pattern=False)),
]


def run_one(
    model_name: str,
    audio: np.ndarray,
    label: str,
    opts: rt.SessionOptions | None,
    iters: int,
    *,
    use_gpu: bool = False,
) -> tuple[list[float], str]:
    # Patch the OnnxAsrTranscriber to pass sess_options through. Since the
    # current wrapper only sets sess_options for fp16, we monkey-patch the
    # underlying onnx_asr.load_model call site by temporarily injecting
    # via a private hook. Simpler: re-wrap via the wrapper but inject the
    # options into kwargs before load.
    import onnx_asr

    orig_load_model = onnx_asr.load_model

    def patched_load(name: str, **kwargs: object) -> object:
        if opts is not None:
            kwargs.setdefault("sess_options", opts)
        return orig_load_model(name, **kwargs)

    onnx_asr.load_model = patched_load  # type: ignore[assignment]
    try:
        provider_list = ["CUDAExecutionProvider", "CPUExecutionProvider"] if use_gpu else ["CPUExecutionProvider"]
        tx = OnnxAsrTranscriber(
            model_name=model_name,
            quantization=None,
            providers=provider_list,
            segment_with_vad=False,
            normalize_audio=True,
        )
        # Warm-up: 3 calls
        for _ in range(3):
            tx.transcribe(audio)
        samples: list[float] = []
        first_text: str | None = None
        for _ in range(iters):
            start = time.perf_counter()
            r = tx.transcribe(audio)
            samples.append(time.perf_counter() - start)
            if first_text is None:
                first_text = r.text
        tx.shutdown()
        return samples, first_text or ""
    finally:
        onnx_asr.load_model = orig_load_model  # type: ignore[assignment]


def main() -> int:
    model = sys.argv[1] if len(sys.argv) > 1 else "onnx-community/whisper-tiny"
    iters = int(sys.argv[2]) if len(sys.argv) > 2 else 15
    dur = float(sys.argv[3]) if len(sys.argv) > 3 else 6.0
    use_gpu = "--gpu" in sys.argv
    audio = make_audio(duration_s=dur)
    ep_label = "CUDA" if use_gpu else "CPU"
    print(f"\n=== Session-option sweep on {model} ({iters} iters, {dur:.1f}s audio, {ep_label}) ===\n")

    baseline_text: str | None = None
    results: list[tuple[str, float, float, float, str, bool]] = []
    for label, opts in CONFIGS:
        try:
            samples, text = run_one(model, audio, label, opts, iters, use_gpu=use_gpu)
        except Exception as e:
            print(f"  {label:<32}  FAILED: {e}", flush=True)
            continue
        med = statistics.median(samples) * 1000
        mn = min(samples) * 1000
        mx = max(samples) * 1000
        if baseline_text is None:
            baseline_text = text
        identical = text == baseline_text
        results.append((label, med, mn, mx, text, identical))
        marker = "OK " if identical else "** DRIFT **"
        print(f"  {label:<32}  med={med:7.2f}ms  min={mn:7.2f}  max={mx:7.2f}  {marker}")

    if results:
        print()
        baseline_med = results[0][1]
        print(f"  {'config':<32}  {'med (ms)':>10}  vs baseline")
        for label, med, _, _, _, identical in results:
            delta = (med - baseline_med) / baseline_med * 100
            sign = "+" if delta >= 0 else ""
            mark = "OK" if identical else "**"
            print(f"  {label:<32}  {med:10.2f}   {sign}{delta:6.1f}%   {mark}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
