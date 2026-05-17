"""Measure exact parameter counts for every catalog model.

Run from ``server/``: ``uv run --no-sync python scripts/measure_model_params.py``

For each model, count graph.initializer dim-products on the cached ONNX
graphs to get an exact parameter count. Where the default fp32 graph isn't
cached, count from a quantized sibling (same architecture, slightly inflated
by QDQ overhead — flagged ``approximate=True``). Where nothing is cached,
fall back to a published authoritative count with the source URL.

Writes ``scripts/_model_param_counts.json``: per-model
``{"params": int, "source": "measured"|"published", "approximate": bool}``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TypedDict

import onnx

CACHE_ROOT = Path("C:/Users/MASTE/.cache/huggingface/hub")
OUTPUT_PATH = Path(__file__).parent / "_model_param_counts.json"

# onnx-asr resolver bare-name -> HF repo mapping (from examples/onnx-asr/.../resolver.py).
RESOLVER_REPOS: dict[str, str] = {
    "gigaam-v2-ctc": "istupakov/gigaam-v2-onnx",
    "gigaam-v2-rnnt": "istupakov/gigaam-v2-onnx",
    "gigaam-v3-ctc": "istupakov/gigaam-v3-onnx",
    "gigaam-v3-rnnt": "istupakov/gigaam-v3-onnx",
    "gigaam-v3-e2e-ctc": "istupakov/gigaam-v3-onnx",
    "gigaam-v3-e2e-rnnt": "istupakov/gigaam-v3-onnx",
    "nemo-fastconformer-ru-ctc": "istupakov/stt_ru_fastconformer_hybrid_large_pc_onnx",
    "nemo-fastconformer-ru-rnnt": "istupakov/stt_ru_fastconformer_hybrid_large_pc_onnx",
    "nemo-parakeet-ctc-0.6b": "istupakov/parakeet-ctc-0.6b-onnx",
    "nemo-parakeet-rnnt-0.6b": "istupakov/parakeet-rnnt-0.6b-onnx",
    "nemo-parakeet-tdt-0.6b-v2": "istupakov/parakeet-tdt-0.6b-v2-onnx",
    "nemo-parakeet-tdt-0.6b-v3": "istupakov/parakeet-tdt-0.6b-v3-onnx",
    "nemo-canary-1b-v2": "istupakov/canary-1b-v2-onnx",
    "whisper-base": "istupakov/whisper-base-onnx",
}


class Measurement(TypedDict):
    params: int
    source: str  # "measured" | "published"
    approximate: bool
    note: str


_QDQ_NAME_TOKENS = ("_scale", "_zero_point", "/scale", "/zero_point", "scale_", "zero_point_")


def _is_qdq_overhead(name: str) -> bool:
    """Whether ``name`` is a QDQ scale/zero-point tensor (not a real parameter)."""
    return any(tok in name for tok in _QDQ_NAME_TOKENS)


def _count_params(path: Path, *, exclude_qdq: bool = False) -> int:
    model = onnx.load(str(path), load_external_data=True)
    total = 0
    for init in model.graph.initializer:
        if exclude_qdq and _is_qdq_overhead(init.name):
            continue
        n = 1
        for d in init.dims:
            n *= d
        total += n
    return total


def _snap_dir(repo: str) -> Path | None:
    safe = "models--" + repo.replace("/", "--")
    snap_root = CACHE_ROOT / safe / "snapshots"
    if not snap_root.exists():
        return None
    revisions = [d for d in snap_root.iterdir() if d.is_dir()]
    if not revisions:
        return None
    return max(revisions, key=lambda d: d.stat().st_mtime)


def _pick_default_first(paths: list[Path]) -> Path | None:
    if not paths:
        return None
    # Prefer the non-quantized variant; fall back to any quantized one.
    for p in paths:
        if not any(q in p.name for q in ("_int8", "_fp16", "_uint8", "_q4", "_bnb4", "_quantized", ".int8")):
            return p
    return paths[0]


def _is_quantized(path: Path) -> bool:
    return any(q in path.name for q in ("_int8", "_fp16", "_uint8", "_q4", "_bnb4", "_quantized", ".int8"))


def _measure_files(snap: Path, file_globs: list[str]) -> tuple[int, bool] | None:
    """Sum params across each glob. Returns (params, used_quantized_fallback) or None if any glob misses.

    For quantized fallback graphs (int8 / fp16 / …) the count excludes QDQ scale and zero-point
    initializers so the result matches the original fp32 parameter count.
    """
    total = 0
    any_quantized = False
    for glob in file_globs:
        matches = list(snap.rglob(glob))
        # Also try the quantized siblings of the glob if no exact match is found.
        if not matches:
            stem = glob.rsplit(".onnx", 1)[0]
            for q in ("_int8", "_fp16", ".int8", ".fp16"):
                matches = list(snap.rglob(f"{stem}{q}.onnx"))
                if matches:
                    break
        chosen = _pick_default_first(matches)
        if chosen is None:
            return None
        is_q = _is_quantized(chosen)
        if is_q:
            any_quantized = True
        total += _count_params(chosen, exclude_qdq=is_q)
    return total, any_quantized


# Per model_id: list of file-globs to sum. Different families have different shapes.
WHISPER_HF_FILES = ["encoder_model.onnx", "decoder_model_merged.onnx"]
NEMO_CONFORMER_CTC_FILES = ["encoder-model.onnx", "model.onnx"]  # CTC head + encoder
NEMO_CONFORMER_RNNT_FILES = ["encoder-model.onnx", "decoder_joint-model.onnx"]
NEMO_CONFORMER_TDT_FILES = ["encoder-model.onnx", "decoder_joint-model.onnx"]
NEMO_CONFORMER_AED_FILES = ["encoder-model.onnx", "decoder-model.onnx"]
GIGAAM_V2_CTC_FILES = ["v2_ctc.onnx"]
GIGAAM_V2_RNNT_FILES = ["v2_rnnt_encoder.onnx", "v2_rnnt_decoder.onnx", "v2_rnnt_joint.onnx"]
GIGAAM_V3_CTC_FILES = ["v3_ctc.onnx"]
GIGAAM_V3_RNNT_FILES = ["v3_rnnt_encoder.onnx", "v3_rnnt_decoder.onnx", "v3_rnnt_joint.onnx"]
GIGAAM_V3_E2E_CTC_FILES = ["v3_e2e_ctc.onnx"]
GIGAAM_V3_E2E_RNNT_FILES = ["v3_e2e_rnnt_encoder.onnx", "v3_e2e_rnnt_decoder.onnx", "v3_e2e_rnnt_joint.onnx"]
VOSK_FILES = ["encoder.onnx", "decoder.onnx", "joiner.onnx"]
TONE_FILES = ["model.onnx"]
WHISPER_ORT_FILES = ["whisper-*_beamsearch.onnx"]

# Published authoritative counts for models whose default fp32 isn't cached.
# Sources cited per entry — never invent numbers.
PUBLISHED: dict[str, tuple[int, str]] = {
    # OpenAI Whisper — Radford et al, "Robust Speech Recognition via Large-Scale Weak Supervision",
    # Table 1 (https://arxiv.org/abs/2212.04356) + model card on HF.
    "medium": (769_000_000, "OpenAI Whisper paper Table 1"),
    "medium.en": (769_000_000, "OpenAI Whisper paper Table 1"),
    "small.en": (244_000_000, "OpenAI Whisper paper Table 1"),
    "base.en": (74_000_000, "OpenAI Whisper paper Table 1"),
    "large-v3": (1_550_000_000, "OpenAI Whisper model card (huggingface.co/openai/whisper-large-v3)"),
    # NeMo Parakeet 0.6B family — NVIDIA NeMo model cards.
    "nemo-parakeet-ctc-0.6b": (600_000_000, "NVIDIA NeMo parakeet_ctc_0.6b card"),
    "nemo-parakeet-rnnt-0.6b": (600_000_000, "NVIDIA NeMo parakeet_rnnt_0.6b card"),
    "nemo-parakeet-tdt-0.6b-v2": (600_000_000, "NVIDIA NeMo parakeet_tdt_0.6b_v2 card"),
    "nemo-canary-1b-v2": (978_000_000, "NVIDIA NeMo canary-1b-v2 card (978M)"),
    # GigaAM v3 family — Sber Salute model cards.
    "gigaam-v3-ctc": (243_000_000, "Sber GigaAM-v3 model card"),
    "gigaam-v3-rnnt": (243_000_000, "Sber GigaAM-v3 model card"),
    "gigaam-v3-e2e-ctc": (243_000_000, "Sber GigaAM-v3 E2E model card"),
    "gigaam-v3-e2e-rnnt": (243_000_000, "Sber GigaAM-v3 E2E model card"),
}


def _files_for(model_id: str) -> list[str] | None:
    if model_id in {
        "tiny",
        "tiny.en",
        "base",
        "base.en",
        "small",
        "small.en",
        "medium",
        "medium.en",
        "large-v3",
        "large-v3-turbo",
    }:
        return WHISPER_HF_FILES
    if model_id.startswith("lite-whisper-"):
        return WHISPER_HF_FILES
    if model_id == "nemo-parakeet-ctc-0.6b":
        return NEMO_CONFORMER_CTC_FILES
    if model_id == "nemo-parakeet-rnnt-0.6b":
        return NEMO_CONFORMER_RNNT_FILES
    if model_id in ("nemo-parakeet-tdt-0.6b-v2", "nemo-parakeet-tdt-0.6b-v3"):
        return NEMO_CONFORMER_TDT_FILES
    if model_id == "nemo-canary-1b-v2":
        return NEMO_CONFORMER_AED_FILES
    if model_id == "nemo-fastconformer-ru-ctc":
        return ["model.onnx"]  # hybrid CTC head packaged as monolithic graph
    if model_id == "nemo-fastconformer-ru-rnnt":
        return ["encoder-model.onnx", "decoder_joint-model.onnx"]
    if model_id == "gigaam-v2-ctc":
        return GIGAAM_V2_CTC_FILES
    if model_id == "gigaam-v2-rnnt":
        return GIGAAM_V2_RNNT_FILES
    if model_id == "gigaam-v3-ctc":
        return GIGAAM_V3_CTC_FILES
    if model_id == "gigaam-v3-rnnt":
        return GIGAAM_V3_RNNT_FILES
    if model_id == "gigaam-v3-e2e-ctc":
        return GIGAAM_V3_E2E_CTC_FILES
    if model_id == "gigaam-v3-e2e-rnnt":
        return GIGAAM_V3_E2E_RNNT_FILES
    if model_id.startswith("alphacep/"):
        return VOSK_FILES
    if model_id == "t-tech/t-one":
        return TONE_FILES
    if model_id == "whisper-base":
        return WHISPER_ORT_FILES
    return None


def _repo_for(model_id: str, onnx_name: str) -> str:
    """Map a catalog entry to the actual HF repo that owns its ONNX files."""
    return RESOLVER_REPOS.get(onnx_name, onnx_name)


def main() -> None:
    # Late import so this script doesn't pull the whole server at module-import time.
    from src.recorder.domain.model_registry import ModelCatalog

    catalog = ModelCatalog()
    results: dict[str, Measurement] = {}

    for m in catalog.list_all():
        repo = _repo_for(m.id, m.onnx_model_name or "")
        if not repo:
            print(f"  {m.id}: SKIP (no onnx_model_name)")
            continue
        snap = _snap_dir(repo)
        files = _files_for(m.id)
        if snap and files:
            res = _measure_files(snap, files)
            if res is not None:
                params, approximate = res
                note = (
                    "from quantized graph (slightly inflated by QDQ overhead)"
                    if approximate
                    else "from default fp32 graph"
                )
                results[m.id] = Measurement(params=params, source="measured", approximate=approximate, note=note)
                print(f"  {m.id:40s}  measured={params / 1e6:7.1f}M  ({'approx' if approximate else 'exact'})")
                continue
        # Cache miss — fall back to published value.
        pub = PUBLISHED.get(m.id)
        if pub is not None:
            params, citation = pub
            results[m.id] = Measurement(params=params, source="published", approximate=False, note=citation)
            print(f"  {m.id:40s}  published={params / 1e6:7.1f}M  ({citation})")
            continue
        print(f"  {m.id:40s}  MISSING — no cache, no published value")

    OUTPUT_PATH.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\nWrote {len(results)} measurements to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
