#!/usr/bin/env python3
"""Retro-fit a `cross_bias` cross-attention mask input into ALREADY-SHIPPED Cohere decoders.

WHY
---
Exports whose cross-bucket pass was skipped (non-uniform cross layout — e.g. the Arabic
`Masterx/cohere-transcribe-arabic-07-2026-ONNX`) have NO way to mask padded encoder frames: the
decoder cross-attends trailing zeros (the DirectML encoder pad bucket, trailing silence) and
phrase-loops — re-emits one sentence verbatim until the token budget. The WinSTT engine computes a
real-audio-length `cross_bias` per utterance whenever the decoder declares that input; this tool
adds the input to decoders that shipped without it, so a full re-export is not needed.

WHAT
----
Proto-only edit (external weight data untouched — the `_data` sidecars keep resolving by relative
name): wrap every CROSS-attention Softmax in `Add(scores, cross_bias)` via
`cohere_decompose_attention.inject_cross_bias_adds` (see its docstring for the self/cross
discriminator, valid before AND after `staticize_kv`), then declare the dynamic
`cross_bias (1,1,1,enc_seq)` graph input + `winstt_cross_bias=dynamic` metadata.

VERIFY
------
Bit-exact A/B: both sessions get IDENTICAL (deterministic random) feeds, the patched one
additionally an ALL-ZERO cross_bias. `Add(x, 0)` is an IEEE identity, so every output must match to
max|diff| == 0.0 exactly — any nonzero diff means a non-attention Softmax was caught (abort). Layer
counts are asserted first: exactly `2*layers` Softmaxes, `layers` of them cross.

USAGE
-----
    python cohere_inject_cross_bias.py --dir <onnx_dir> [--layers 8] [--dry-run]

Patches every `decoder_model_merged*.onnx` in `--dir` IN PLACE (originals backed up as
`<name>.pre_cross_bias.bak`); files that already declare `cross_bias` are skipped.
"""
from __future__ import annotations

import argparse
import glob
import os
import shutil

import numpy as np
import onnx
from onnx import helper

from cohere_decompose_attention import inject_cross_bias_adds


ENC_LEN = 6  # encoder key length used for every dynamic cross tensor in the A/B feeds


def input_shape(i) -> list[int]:
    """Concrete feed shape for one declared input. Known symbols get semantically consistent
    values (total = past + seq so masks/concats line up); the per-input anonymous symbols of the
    auto-hoisted cross tensors get their KNOWN head layout — `cross_attn.N.encoder.value` is the
    canonical (1, 8, S, 128) V, `cross_attn.hoisted.N` the `[0,2,3,1]`-transposed (1, 8, 128, S)
    key of the Arabic torch export. Values themselves need no attention semantics — both sessions
    receive the SAME arrays, so any runnable garbage proves the identity."""
    if ".encoder.value" in i.name and i.name.startswith("cross_attn."):
        return [1, 8, ENC_LEN, 128]
    if i.name.startswith("cross_attn.hoisted."):
        return [1, 8, 128, ENC_LEN]
    sym = {
        "batch_size": 1,
        "sequence_length": 2,
        "total_sequence_length": 2,  # = past_decoder (0) + sequence (2)
        "past_decoder_sequence_length": 0,
        "past_encoder_sequence_length": 0,
        "encoder_sequence_length": ENC_LEN,
    }
    return [d if isinstance(d, int) else sym.get(str(d), ENC_LEN) for d in i.shape]


def build_feeds(sess, rng) -> dict:
    feeds = {}
    for i in sess.get_inputs():
        shape = input_shape(i)
        if "float16" in i.type:
            feeds[i.name] = (rng.randn(*shape) * 0.1).astype(np.float16)
        elif "float" in i.type:
            feeds[i.name] = (rng.randn(*shape) * 0.1).astype(np.float32)
        elif "int64" in i.type:
            # num_logits_to_keep must stay <= sequence_length; 1 is valid for every int input here.
            feeds[i.name] = np.ones(shape, dtype=np.int64)
        elif "int32" in i.type:
            feeds[i.name] = np.ones(shape, dtype=np.int32)
        elif "bool" in i.type:
            feeds[i.name] = np.ones(shape, dtype=bool)
        else:
            raise SystemExit(f"unhandled input dtype {i.type} for {i.name}")
    return feeds


def verify_identity(orig_path: str, new_path: str) -> None:
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    so.log_severity_level = 3  # the hoisted decoders keep declared-but-unused weights — mute the spam
    s0 = ort.InferenceSession(orig_path, so, providers=["CPUExecutionProvider"])
    s1 = ort.InferenceSession(new_path, so, providers=["CPUExecutionProvider"])
    feeds = build_feeds(s0, np.random.RandomState(0))
    cb = next(i for i in s1.get_inputs() if i.name == "cross_bias")
    # Dynamic last dim -> must match the fed encoder key length (the score tensor's last axis).
    cb_len = cb.shape[3] if isinstance(cb.shape[3], int) else ENC_LEN
    cb_dt = np.float16 if "float16" in cb.type else np.float32
    feeds1 = dict(feeds)
    feeds1["cross_bias"] = np.zeros((1, 1, 1, cb_len), dtype=cb_dt)
    out0 = dict(zip([o.name for o in s0.get_outputs()], s0.run(None, feeds)))
    out1 = dict(zip([o.name for o in s1.get_outputs()], s1.run(None, feeds1)))
    assert out0.keys() == out1.keys(), "output sets differ"
    worst = 0.0
    for name, v0 in out0.items():
        d = float(np.abs(v0.astype(np.float32) - out1[name].astype(np.float32)).max()) if v0.size else 0.0
        worst = max(worst, d)
    print(f"  zero-bias identity: max|diff|={worst:.6g} over {len(out0)} outputs")
    assert worst == 0.0, "zero cross_bias changed an output — a non-attention Softmax was patched"

    # Effectiveness: a real mask (-inf over the tail keys) must CHANGE the logits — proves the Add
    # actually lands in the live cross-attention path rather than a dead subgraph.
    neg = np.float16(-65504.0) if cb_dt == np.float16 else np.float32(-3.4028235e38)
    masked_bias = np.zeros((1, 1, 1, cb_len), dtype=cb_dt)
    masked_bias[..., cb_len // 2:] = neg
    feeds2 = dict(feeds1)
    feeds2["cross_bias"] = masked_bias
    out2 = s1.run(["logits"], feeds2)[0]
    d_eff = float(np.abs(out1["logits"].astype(np.float32) - out2.astype(np.float32)).max())
    print(f"  masked-bias effectiveness: logits max|diff|={d_eff:.6g}")
    assert d_eff > 0.0, "masking the tail keys did not change the logits — the bias Add is dead"


def patch_decoder(path: str, layers: int, dry_run: bool) -> None:
    dec = onnx.load(path, load_external_data=False)
    g = dec.graph
    if any(i.name == "cross_bias" for i in g.input):
        print(f"{os.path.basename(path)}: already has cross_bias — skipped")
        return
    n_softmax = sum(1 for n in g.node if n.op_type == "Softmax")
    if n_softmax != 2 * layers:
        raise SystemExit(
            f"{os.path.basename(path)}: expected {2 * layers} Softmax nodes ({layers} self + "
            f"{layers} cross), found {n_softmax} — refusing to patch an unexpected layout"
        )
    masked = inject_cross_bias_adds(g)
    if masked != layers:
        raise SystemExit(
            f"{os.path.basename(path)}: injected {masked} cross biases, expected {layers} — "
            "the self/cross Softmax discriminator does not fit this graph"
        )
    past0 = next(i for i in g.input if i.name.startswith("past_key_values.") and ".decoder." in i.name)
    elem = past0.type.tensor_type.elem_type
    g.input.append(helper.make_tensor_value_info("cross_bias", elem, [1, 1, 1, "enc_seq"]))
    del g.value_info[:]
    if not any(e.key == "winstt_cross_bias" for e in dec.metadata_props):
        e = dec.metadata_props.add()
        e.key, e.value = "winstt_cross_bias", "dynamic"

    # Save NEXT TO the original (same dir) so relative external-data refs keep resolving, verify
    # bit-identity, then swap in place with a backup of the pristine proto.
    tmp = f"{path}.cross_bias_tmp"
    onnx.save(dec, tmp)
    onnx.checker.check_model(tmp, full_check=False)
    verify_identity(path, tmp)
    if dry_run:
        os.remove(tmp)
        print(f"{os.path.basename(path)}: OK (dry-run — not replaced), cross biases={masked}")
        return
    bak = f"{path}.pre_cross_bias.bak"
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
    os.replace(tmp, path)
    print(f"{os.path.basename(path)}: PATCHED, cross biases={masked} (backup: {os.path.basename(bak)})")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", required=True, help="directory containing decoder_model_merged*.onnx")
    ap.add_argument("--layers", type=int, default=8, help="decoder layer count (default 8)")
    ap.add_argument("--dry-run", action="store_true", help="verify only, do not replace files")
    args = ap.parse_args()

    decs = [d for d in sorted(glob.glob(os.path.join(args.dir, "decoder_model_merged*.onnx")))
            if not d.endswith("_data")]
    if not decs:
        raise SystemExit(f"no decoder_model_merged*.onnx in {args.dir}")
    for d in decs:
        patch_decoder(d, args.layers, args.dry_run)


if __name__ == "__main__":
    main()
