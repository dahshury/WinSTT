#!/usr/bin/env python3
"""Validate the SHIPPABLE artifact: run the rank-rule dictionary fallback on the int8 ONNX export of
mmBERT-base via onnxruntime (the deployment runtime), and confirm it reproduces the PyTorch held-out
result (~90% recall, 0 false positives). This is what the Rust `ort` integration will mirror exactly.

  python tools/bench/eval_onnx_artifact.py [onnx_filename]   # default onnx/model_int8.onnx
"""
import os
import sys
import time

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from transformers import AutoTokenizer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eval_encoder_dict import apply_pairs, gen_vocab_candidates  # noqa: E402
from eval_encoder_dict_large import (DICT, NEG_COLLISION, RANK_KS,  # noqa: E402
                                     apply_k, build_cases, recall_fp)

REPO = os.environ.get("MMBERT_REPO", "onnx-community/mmBERT-base-ONNX")
ONNX_FILE = sys.argv[1] if len(sys.argv) > 1 else "onnx/model_int8.onnx"
CAP_MS = 300.0


def load():
    path = hf_hub_download(REPO, ONNX_FILE)
    # external-data sidecar, if any, is fetched lazily by name; this export is self-contained.
    tok = AutoTokenizer.from_pretrained(REPO)
    so = ort.SessionOptions()
    so.intra_op_num_threads = max(1, (os.cpu_count() or 4) // 2)
    sess = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
    in_names = [i.name for i in sess.get_inputs()]
    out0 = sess.get_outputs()[0].name
    print(f"  onnx inputs: {in_names} | output[0]: {out0} "
          f"shape {sess.get_outputs()[0].shape}")
    return sess, tok, in_names


def mean_rank_ort(sess, tok, in_names, text, cs, ce):
    enc = tok(text, return_offsets_mapping=True)
    offsets, ids, attn = enc["offset_mapping"], enc["input_ids"], enc["attention_mask"]
    span = [i for i, (s, e) in enumerate(offsets)
            if not (s == 0 and e == 0) and s < ce and e > cs]
    if not span:
        return None
    mask_id = tok.mask_token_id
    r = len(span)
    bids = np.tile(np.asarray(ids, dtype=np.int64), (r, 1))
    for j, ti in enumerate(span):
        bids[j, ti] = mask_id
    feeds = {"input_ids": bids,
             "attention_mask": np.tile(np.asarray(attn, dtype=np.int64), (r, 1))}
    if "token_type_ids" in in_names:
        feeds["token_type_ids"] = np.zeros_like(bids)
    feeds = {k: v for k, v in feeds.items() if k in in_names}
    logits = sess.run(None, feeds)[0]  # (R, L, V)
    total = 0
    for j, ti in enumerate(span):
        row = logits[j, ti]
        total += int((row > row[ids[ti]]).sum())
    return total / r


def candidate_ranks(sess, tok, in_names, text):
    base = apply_pairs(text, [])
    cands = gen_vocab_candidates(base, DICT)
    cands.sort(key=lambda c: (-c[0], c[5]))
    used, out = [], []
    for _n, cs, ce, _span, term, _d in cands:
        if any(not (ce <= a or cs >= b) for a, b in used):
            continue
        used.append((cs, ce))
        rk = mean_rank_ort(sess, tok, in_names, base, cs, ce)
        if rk is not None:
            out.append((cs, ce, term, rk))
    return base, out


def main():
    print(f"Artifact: {REPO}/{ONNX_FILE}")
    sess, tok, in_names = load()
    pos, neg = build_cases()
    mean_rank_ort(sess, tok, in_names, "warm up now.", 0, 4)
    t0 = time.perf_counter()
    pos_r = [(c, *candidate_ranks(sess, tok, in_names, c["text"])) for c in pos]
    neg_r = [(c, *candidate_ranks(sess, tok, in_names, c["text"])) for c in neg]
    dt = (time.perf_counter() - t0) / (len(pos) + len(neg)) * 1000
    print(f"  ~{dt:.0f} ms/utterance (ORT CPU)  [{'UNDER' if dt <= CAP_MS else 'OVER'} cap]")

    pos_dev, pos_test = pos_r[::2], pos_r[1::2]
    neg_dev, neg_test = neg_r[::2], neg_r[1::2]
    best = None
    for k in RANK_KS:
        rec, fp = recall_fp(pos_dev, neg_dev, k)
        score = (fp == 0, rec, -fp)
        if best is None or score > best[0]:
            best = (score, k)
    k = best[1]
    dr, dfp = recall_fp(pos_dev, neg_dev, k)
    tr, tfp = recall_fp(pos_test, neg_test, k)
    fr, ffp = recall_fp(pos_r, neg_r, k)
    print(f"  K* (dev) = {k}")
    print(f"    DEV : recall {dr:.0%}  false-pos {dfp}/{len(neg_dev)}")
    print(f"    TEST: recall {tr:.0%}  false-pos {tfp}/{len(neg_test)}   <- held-out")
    print(f"    ALL : recall {fr:.0%}  false-pos {ffp}/{len(neg_r)}")
    for (c, base, rk) in neg_test:
        out = apply_k(base, rk, k)
        if out != base:
            print(f"    [TEST-FP] {base}  ->  {out}")


if __name__ == "__main__":
    main()
