"""Smoke-test every quantization variant of the lite-whisper turbo family.

Run from server/: ``uv run --no-sync python scripts/smoke_test_lite_whisper.py``

For each (repo, quant) pair: load via onnx-asr on CPU, transcribe a known
fixture clip, compare to a reference transcript (produced from a known-good
catalog model). Variants are flagged ``buggy`` when load fails, transcribe
raises, output is empty, or word-error-rate vs the reference exceeds the
``WER_THRESHOLD``. Results are appended to ``scripts/_lite_whisper_results.json``
so the run is resumable across crashes.

Output is structured: emojis are deliberately avoided (per repo style).
"""

from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path
from typing import TypedDict

import numpy as np
import onnx_asr
import soundfile as sf
from huggingface_hub import hf_hub_download

REPOS: list[str] = [
    "onnx-community/lite-whisper-large-v3-turbo-ONNX",
    "onnx-community/lite-whisper-large-v3-turbo-acc-ONNX",
    "onnx-community/lite-whisper-large-v3-turbo-fast-ONNX",
]
QUANTIZATIONS: list[str] = ["", "int8", "fp16", "uint8", "q4", "q4f16", "bnb4"]
REFERENCE_MODEL: str = "onnx-community/whisper-base"
REFERENCE_QUANT: str = ""
WER_THRESHOLD: float = 0.5  # > 50% word error => buggy
TRANSCRIBE_TIMEOUT_SEC: float = 600.0  # generous; CPU large-v3-turbo is slow

RESULTS_PATH = Path(__file__).parent / "_lite_whisper_results.json"


class VariantResult(TypedDict):
    repo: str
    quantization: str
    status: str  # "ok" | "buggy" | "load_failed" | "transcribe_failed"
    wer: float | None
    output: str
    load_seconds: float
    transcribe_seconds: float
    error: str | None


def _normalize(text: str) -> list[str]:
    """Lowercase + strip punctuation for fair WER comparison."""
    keep = []
    for ch in text.lower():
        if ch.isalnum() or ch.isspace():
            keep.append(ch)
    return "".join(keep).split()


def _wer(reference: str, hypothesis: str) -> float:
    """Standard Levenshtein word-error-rate. 0.0 = identical, 1.0 = fully wrong."""
    ref = _normalize(reference)
    hyp = _normalize(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    # DP edit distance over word sequences.
    n, m = len(ref), len(hyp)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            dp[i][j] = min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost,
            )
    return dp[n][m] / n


def _load_fixture() -> np.ndarray:
    """Download and load the MLK clip as 16 kHz mono float32."""
    path = hf_hub_download(
        repo_id="Narsil/asr_dummy",
        repo_type="dataset",
        filename="mlk.flac",
    )
    waveform, sr = sf.read(path, dtype="float32", always_2d=False)
    if waveform.ndim > 1:
        waveform = waveform.mean(axis=1)
    if sr != 16_000:
        # cheap polyphase resample via numpy linear interp — close enough for whisper
        ratio = 16_000 / sr
        new_len = round(len(waveform) * ratio)
        waveform = np.interp(
            np.linspace(0, len(waveform) - 1, new_len, dtype=np.float64),
            np.arange(len(waveform), dtype=np.float64),
            waveform,
        ).astype(np.float32)
    return waveform


def _force_cpu_providers() -> list[str]:
    """Pin to CPUExecutionProvider so int8-CUDA hallucination class isn't in scope."""
    return ["CPUExecutionProvider"]


def _load_results() -> dict[str, VariantResult]:
    if RESULTS_PATH.exists():
        return json.loads(RESULTS_PATH.read_text(encoding="utf-8"))
    return {}


def _save_results(results: dict[str, VariantResult]) -> None:
    RESULTS_PATH.write_text(json.dumps(results, indent=2), encoding="utf-8")


def _key(repo: str, quant: str) -> str:
    return f"{repo}::{quant or '(default)'}"


def _test_variant(
    repo: str,
    quant: str,
    waveform: np.ndarray,
    reference_text: str,
) -> VariantResult:
    print(f"  [{repo} :: {quant or '(default)'}] loading...", flush=True)
    t0 = time.monotonic()
    try:
        model = onnx_asr.load_model(
            repo,
            quantization=(quant or None),
            providers=_force_cpu_providers(),
        )
    except Exception as exc:
        return VariantResult(
            repo=repo,
            quantization=quant,
            status="load_failed",
            wer=None,
            output="",
            load_seconds=time.monotonic() - t0,
            transcribe_seconds=0.0,
            error=f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}",
        )
    load_seconds = time.monotonic() - t0
    print(f"    loaded in {load_seconds:.1f}s; transcribing...", flush=True)
    t1 = time.monotonic()
    try:
        output = model.recognize(waveform)
    except Exception as exc:
        return VariantResult(
            repo=repo,
            quantization=quant,
            status="transcribe_failed",
            wer=None,
            output="",
            load_seconds=load_seconds,
            transcribe_seconds=time.monotonic() - t1,
            error=f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}",
        )
    transcribe_seconds = time.monotonic() - t1
    output_str = output if isinstance(output, str) else str(output)
    wer = _wer(reference_text, output_str)
    status = "buggy" if (not output_str.strip() or wer > WER_THRESHOLD) else "ok"
    print(
        f"    transcribed in {transcribe_seconds:.1f}s; WER={wer:.3f} -> {status}",
        flush=True,
    )
    return VariantResult(
        repo=repo,
        quantization=quant,
        status=status,
        wer=wer,
        output=output_str,
        load_seconds=load_seconds,
        transcribe_seconds=transcribe_seconds,
        error=None,
    )


def main() -> int:
    print("Loading fixture (MLK clip)...", flush=True)
    waveform = _load_fixture()
    duration = len(waveform) / 16_000
    print(f"  fixture duration: {duration:.2f}s, samples: {len(waveform)}", flush=True)

    print(f"Building reference transcript with {REFERENCE_MODEL}...", flush=True)
    reference_model = onnx_asr.load_model(
        REFERENCE_MODEL,
        quantization=(REFERENCE_QUANT or None),
        providers=_force_cpu_providers(),
    )
    reference_text = reference_model.recognize(waveform)
    if not isinstance(reference_text, str):
        reference_text = str(reference_text)
    print(f"  reference: {reference_text!r}", flush=True)

    results = _load_results()
    results["__reference__"] = VariantResult(  # type: ignore[typeddict-item]
        repo=REFERENCE_MODEL,
        quantization=REFERENCE_QUANT,
        status="ok",
        wer=0.0,
        output=reference_text,
        load_seconds=0.0,
        transcribe_seconds=0.0,
        error=None,
    )
    _save_results(results)

    for repo in REPOS:
        for quant in QUANTIZATIONS:
            key = _key(repo, quant)
            if key in results:
                print(f"  [{key}] cached -> {results[key]['status']}", flush=True)
                continue
            result = _test_variant(repo, quant, waveform, reference_text)
            results[key] = result
            _save_results(results)

    print("\n=== Summary ===")
    for repo in REPOS:
        print(f"\n{repo}")
        for quant in QUANTIZATIONS:
            r = results.get(_key(repo, quant))
            if r is None:
                print(f"  {quant or '(default)':12s} -- not run --")
                continue
            wer_str = f"WER={r['wer']:.3f}" if r["wer"] is not None else "WER=N/A"
            print(f"  {quant or '(default)':12s}  {r['status']:18s}  {wer_str}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
