#!/usr/bin/env python3
"""Export Audio8-ASR-Infinite to the WinSTT ONNX bundle.

    python audio8_infinite_export.py --ckpt <hf snapshot dir> --out <bundle dir> --precision int4 int8 fp16 [fp32]
                     [--decoder-shards 3]   # fp32 only: split the 12 GB decoder for low-RAM parity

Writes (per precision P; fp32 uses no suffix):
    audio_encoder{_P}.onnx + .onnx.data      mel + conv + 32-layer tower + projector (one step)
    decoder{_P}.onnx + .onnx.data             36-layer LM step + tied LM head + semantic-VAD heads
plus the precision-independent host tables:
    embed_tokens.bf16       raw little-endian bf16 [151936, 2048] token embedding (exact checkpoint bits)
    ada_scale.f32           raw f32 [len(combos), 36, 2048] per-layer (1 + AdaRMSNorm(t_cond))
    runtime.json            geometry, streaming clock, special ids, rolling policy, ada combo index
"""
from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

import numpy as np

import audio8_infinite_ref as a8i
import audio8_infinite_graph as a8i_onnx


def write_tables(W, dims: a8i.Dims, cfg: dict, out: Path):
    arr, tag = W.raw("language_model.model.embed_tokens.weight")
    assert tag == "bf16" and arr.shape == (dims.vocab, dims.t_hidden), (tag, arr.shape)
    with open(out / "embed_tokens.bf16", "wb") as f:
        for s in range(0, arr.shape[0], 8192):
            f.write(np.ascontiguousarray(arr[s: s + 8192]).astype("<u2").tobytes())
    combos = []
    tables = []
    for fl, delays in sorted(a8i.DELAYS_BY_FL.items()):
        for ms, tokens in sorted(delays.items()):
            combos.append({"frame_len": fl, "delay_ms": ms, "delay_tokens": tokens})
            tables.append(a8i.modulation(W, dims, tokens, fl))
    np.stack(tables).astype("<f4").tofile(out / "ada_scale.f32")
    runtime = {
        "format": "winstt-audio8-infinite-v1",
        "source_model": "Edge0/Audio8-ASR-Infinite",
        "source_revision": "7476824bc222e4ad509d286e8cae8b8d3f371129",
        "sample_rate": a8i.SR,
        "samples_per_frame_len_unit": 320,
        "look_back_samples": a8i.LOOK_BACK,
        "look_ahead_samples": a8i.LOOK_AHEAD,
        "right_pad_text_tokens": a8i.RIGHT_PAD_TEXT_TOKENS,
        "left_pad_tokens_by_frame_len": {str(k): v for k, v in a8i.LEFT_PAD_BY_FL.items()},
        "default_frame_len": 4,
        "default_delay_ms": 480,
        "encoder": {"layers": dims.a_layers, "heads": dims.a_heads, "head_dim": dims.a_head_dim,
                    "hidden": dims.a_hidden, "sliding_window": dims.a_window, "rope_theta": dims.a_theta},
        "decoder": {"layers": dims.t_layers, "heads": dims.t_heads, "kv_heads": dims.t_kv,
                    "head_dim": dims.t_head_dim, "hidden": dims.t_hidden, "rope_theta": dims.t_theta,
                    "vocab": dims.vocab},
        "rolling": {"context_tokens": a8i.ROLL_CONTEXT, "trim_tokens": a8i.ROLL_TRIM,
                    "stable_prefix_tokens": a8i.ROLL_STABLE},
        "tokens": {"bos": a8i.BOS, "eos": a8i.EOS, "pad": a8i.PAD, "streaming_pad": a8i.STREAM_PAD,
                   "streaming_word": a8i.STREAM_WORD, "language_zh": a8i.LANG_ZH, "language_en": a8i.LANG_EN},
        "semantic_vad": {"horizons_seconds": list(cfg.get("semantic_vad_horizons_seconds") or a8i.VAD_HORIZONS),
                         "num_classes": dims.vad_classes, "end_of_turn_class": 0,
                         "default_eot_horizon_seconds": 2.0},
        "embed_tokens": {"file": "embed_tokens.bf16", "dtype": "bf16", "shape": [dims.vocab, dims.t_hidden]},
        "ada_scale": {"file": "ada_scale.f32", "dtype": "f32", "shape": [len(combos), dims.t_layers, dims.t_hidden],
                      "combos": combos},
    }
    (out / "runtime.json").write_text(json.dumps(runtime, indent=2) + "\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--precision", nargs="+", default=["int4", "int8", "fp16"])
    ap.add_argument("--parts", nargs="+", default=["encoder", "decoder", "tables"])
    ap.add_argument("--decoder-shards", type=int, default=1)
    ap.add_argument("--block", type=int, default=32)
    args = ap.parse_args()
    ckpt, out = Path(args.ckpt), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    cfg = json.loads((ckpt / "config.json").read_text())
    dims = a8i.Dims.from_config(cfg)
    W = a8i.load_weights(ckpt)
    if "tables" in args.parts:
        t = time.time()
        write_tables(W, dims, cfg, out)
        for name in ("tokenizer.json", "tokenizer_config.json"):
            shutil.copy2(ckpt / name, out / name)
        print(f"tables {time.time() - t:.0f}s", flush=True)
    for prec in args.precision:
        sfx = "" if prec == "fp32" else f"_{prec}"
        if "encoder" in args.parts:
            t = time.time()
            n = a8i_onnx.build_encoder(W, dims, prec, out / f"audio_encoder{sfx}.onnx", block=args.block)
            print(f"audio_encoder{sfx}: {n} linears, {time.time() - t:.0f}s", flush=True)
        if "decoder" in args.parts:
            shards = args.decoder_shards if prec == "fp32" else 1
            bounds = np.linspace(0, dims.t_layers, shards + 1).astype(int)
            for s in range(shards):
                t = time.time()
                name = f"decoder{sfx}.onnx" if shards == 1 else f"decoder{sfx}.part{s}.onnx"
                n = a8i_onnx.build_decoder(W, dims, prec, out / name, block=args.block,
                                           layers=(int(bounds[s]), int(bounds[s + 1])), head=(s == shards - 1))
                print(f"{name}: {n} linears, {time.time() - t:.0f}s", flush=True)


if __name__ == "__main__":
    main()
