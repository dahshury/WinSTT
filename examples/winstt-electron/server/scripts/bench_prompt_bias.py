"""A/B benchmark for the `initial_prompt_text` decoder-bias path.

Runs each candidate model twice against the SAME audio clip:
  1. No prompt (baseline)
  2. With a realistic prior-text prompt (simulating the UIA snapshot
     the frontend pushes when `general.contextAwareness` is on)

Prints both transcripts side by side per model so an operator can
eyeball whether the prompt is helping, hurting, or no-oping.

Why eyeball and not WER? Most of the benchmark value here is
qualitative: does the model spell technical terms correctly when
primed, does it stay on-task, does it hallucinate a continuation of
the prompt? A small WER delta on a single clip is noise; whether
"Schrödinger" comes out as "shredding her" vs the right name is the
signal we care about.

Models grouped by feasibility (see also memory note on the
`<|startofcontext|>` slot):
  * Whisper          — already supported, baseline + sanity check
  * Canary AED       — newly supported, target of this PR
  * Cohere           — newly supported, target of this PR
  * Moonshine        — UNCERTAIN (no `<|prev|>` trained), prints
                       both runs but expect inert / degrading
  * SenseVoice       — NOT FEASIBLE (CTC), prints both runs to
                       confirm prompt is no-op

Skips any model not already in the Hugging Face cache, so a fresh
machine doesn't blow up the benchmark with multi-gigabyte downloads.
Run from `server/`:

    uv run python scripts/bench_prompt_bias.py [--clip-seconds N]
    uv run python scripts/bench_prompt_bias.py --only nemo-canary-180m-flash
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

# Windows defaults stdout to cp1252; transcripts and prompts both
# carry diacritics (Schrödinger, München, café). Force UTF-8 so
# `print(...)` doesn't crash mid-benchmark.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[union-attr]

# Ensure we run against the project's source tree, not a stale install.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Triggers the runtime monkey-patches so Canary/Cohere `_decoding` know
# how to read `_winstt_initial_prompt_ids`.
from src.recorder.infrastructure import onnx_decoder_patches  # noqa: E402

onnx_decoder_patches.apply_onnx_decoder_patches()

from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber  # noqa: E402

logger = logging.getLogger(__name__)

# ── Configuration ──────────────────────────────────────────────────────

# 16 kHz mono physics lecture from faster-whisper's test fixtures —
# contains domain vocabulary (quantum, Schrödinger, momentum, etc.)
# that's ideal for prompt-bias evaluation.
DEFAULT_WAV = Path("E:/DL/Projects/WinSTT/examples/faster-whisper/tests/data/physicsworks.wav")

# Realistic UIA-snapshot-shaped prior-text. Mirrors what
# `extractAsrPromptTail` would produce when the user is dictating into
# a physics-themed editor window: enough domain vocabulary to bias the
# decoder, short enough to fit comfortably in the 250-char tail cap.
DEFAULT_PROMPT = (
    "We were discussing Schrödinger's equation and how quantum wavefunctions "
    "collapse on measurement. The lecturer covered momentum, position, and "
    "Heisenberg uncertainty."
)


@dataclass(frozen=True)
class ModelSpec:
    """One row of the benchmark matrix."""

    catalog_id: str
    """HuggingFace repo id passed to onnx_asr.load_model."""
    family: str
    """Family name (whisper / canary / cohere / moonshine / sense_voice)."""
    feasibility: str
    """Expected effect of the prompt: SUPPORTED / UNCERTAIN / NO-OP."""
    quantization: str | None = None
    """Optional ONNX quantization suffix (?int8, ?fp16, ...). None = default."""


CANDIDATES: list[ModelSpec] = [
    # Whisper — baseline (we already shipped this path; confirms the
    # benchmark harness works end-to-end).
    ModelSpec(
        catalog_id="onnx-community/whisper-tiny",
        family="whisper",
        feasibility="SUPPORTED",
    ),
    ModelSpec(
        catalog_id="onnx-community/whisper-base",
        family="whisper",
        feasibility="SUPPORTED",
    ),
    # Canary AED — newly wired via `<|startofcontext|>` splice.
    # `nemo-canary-1b-v2` is a builtin short name; the 180M flash variant
    # needs its full istupakov HF path.
    ModelSpec(
        catalog_id="istupakov/canary-180m-flash-onnx",
        family="canary",
        feasibility="SUPPORTED",
    ),
    ModelSpec(
        catalog_id="nemo-canary-1b-v2",
        family="canary",
        feasibility="SUPPORTED",
    ),
    # Cohere — same `<|startofcontext|>` splice, different tokenizer.
    ModelSpec(
        catalog_id="cohere-transcribe",
        family="cohere",
        feasibility="SUPPORTED",
    ),
    # Moonshine — no `<|prev|>` token in vocab; ASR engine ignores the
    # `_winstt_initial_prompt_ids` attr because we never wire it. This
    # row should print identical "with"/"without" outputs.
    ModelSpec(
        catalog_id="moonshine-tiny",
        family="moonshine",
        feasibility="NO-OP",
    ),
    ModelSpec(
        catalog_id="moonshine-base",
        family="moonshine",
        feasibility="NO-OP",
    ),
]


# ── Helpers ────────────────────────────────────────────────────────────


def load_clip(wav_path: Path, clip_seconds: float | None) -> np.ndarray[Any, Any]:
    """Read a mono 16 kHz clip; optionally truncate to the first N seconds."""
    audio, sr = sf.read(wav_path, dtype="float32")
    if sr != 16_000:
        msg = f"expected 16 kHz audio, got {sr} Hz"
        raise SystemExit(msg)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if clip_seconds is not None:
        n = int(clip_seconds * sr)
        audio = audio[:n]
    return audio


def is_cached(catalog_id: str) -> bool:
    """Best-effort check that the model is available offline.

    Two paths:
      * Full repo id ("org/name") → check ``models--{org}--{name}``.
      * Bare short name ("moonshine-tiny", "nemo-canary-180m-flash") →
        onnx_asr resolves these to a model-specific repo internally;
        we can't reliably predict the cache dir, so we conservatively
        return True and let ``onnx_asr.load_model`` surface any
        network-required failures inside the per-model exception handler.
    """
    if "/" not in catalog_id:
        return True  # bare short name — let load_model decide
    try:
        from huggingface_hub import constants
    except ImportError:
        return False
    cache_root = Path(constants.HF_HUB_CACHE)
    org, _, name = catalog_id.partition("/")
    if not name:
        return False
    candidate = cache_root / f"models--{org}--{name}"
    return candidate.exists()


def run_one(
    spec: ModelSpec,
    audio: np.ndarray[Any, Any],
    prompt_text: str,
) -> None:
    """Load `spec`, transcribe `audio` twice, print before/after."""
    print()
    print("-" * 78)
    print(f"[{spec.family.upper()}] {spec.catalog_id}    feasibility={spec.feasibility}")
    print("-" * 78)

    if not is_cached(spec.catalog_id):
        print(f"  SKIP (not in HF cache — pre-fetch with onnx_asr.load_model({spec.catalog_id!r}))")
        return

    t0 = time.time()
    try:
        transcriber = OnnxAsrTranscriber(
            model_name=spec.catalog_id,
            quantization=spec.quantization,
            # CPU EP keeps the benchmark portable; CUDA / DirectML are
            # orthogonal to the prompt-bias signal we're measuring. The
            # constructor defaults to whatever resolve_accelerator picks,
            # which on this machine is CUDA — explicit override below.
            providers=["CPUExecutionProvider"],
        )
    except Exception as exc:
        print(f"  LOAD FAILED: {exc}")
        return
    print(f"  loaded in {time.time() - t0:.1f}s")

    # Run 1 — no prompt.
    t0 = time.time()
    try:
        res_baseline = transcriber.transcribe(audio, "en", use_prompt=False)
    except Exception as exc:
        print(f"  ❌  baseline transcribe failed: {exc}")
        transcriber.shutdown()
        return
    elapsed_baseline = time.time() - t0

    # Run 2 — with prior-text prompt. use_prompt=True forces the install
    # dispatcher to run; `initial_prompt_text` takes precedence over the
    # (None) custom_words fallback.
    t0 = time.time()
    try:
        res_primed = transcriber.transcribe(
            audio,
            "en",
            use_prompt=True,
            custom_words=None,
            initial_prompt_text=prompt_text,
        )
    except Exception as exc:
        print(f"  ❌  primed transcribe failed: {exc}")
        transcriber.shutdown()
        return
    elapsed_primed = time.time() - t0

    print(f"  baseline ({elapsed_baseline:.2f}s):")
    print(f"    {res_baseline.text!r}")
    print(f"  primed   ({elapsed_primed:.2f}s):")
    print(f"    {res_primed.text!r}")

    if res_baseline.text == res_primed.text:
        print("  => IDENTICAL (prompt was no-op for this engine — expected for CTC / vocab-less families)")
    else:
        print("  => DIFFERENT (prompt influenced the decoder)")

    transcriber.shutdown()


# ── CLI ────────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--wav",
        type=Path,
        default=DEFAULT_WAV,
        help=f"16 kHz mono WAV to transcribe (default: {DEFAULT_WAV.name})",
    )
    parser.add_argument(
        "--clip-seconds",
        type=float,
        default=15.0,
        help="Truncate the WAV to N seconds (default: 15.0). Pass 0 for full clip.",
    )
    parser.add_argument(
        "--prompt",
        type=str,
        default=DEFAULT_PROMPT,
        help="Prior-text prompt fed into the decoder.",
    )
    parser.add_argument(
        "--only",
        type=str,
        default=None,
        help="Substring filter on catalog_id; only matching models are benchmarked.",
    )
    args = parser.parse_args()

    if not args.wav.exists():
        print(f"WAV not found: {args.wav}", file=sys.stderr)
        return 2

    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")

    clip_seconds = None if args.clip_seconds == 0 else args.clip_seconds
    audio = load_clip(args.wav, clip_seconds)
    duration = audio.size / 16_000
    print(f"clip: {args.wav.name} duration={duration:.1f}s")
    print(f"prompt: {args.prompt!r}")

    specs = CANDIDATES
    if args.only:
        specs = [s for s in specs if args.only in s.catalog_id]
        if not specs:
            print(f"no models match --only={args.only}", file=sys.stderr)
            return 2

    for spec in specs:
        run_one(spec, audio, args.prompt)

    print()
    print("done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
