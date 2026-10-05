#!/usr/bin/env python3
"""Parity + accuracy harness for the Audio8-ASR-Infinite ONNX bundle.

  onnx   --prec P --sets jfk jfk_long ...     free-running ORT streaming decode -> results/onnx_P.json
  torch  --draft P --sets jfk jfk_long ...    exact torch fp32 greedy (speculative: ORT tokens of
                                              precision P are only a DRAFT, every token is verified
                                              by a torch forward) -> results/torch.json (+ logits npz)
  shards --sets jfk jfk_long                  fp32 ONNX decoder shards, teacher-forced on the torch
                                              tokens, one shard resident at a time -> results/fp32.json
  report                                      parity / WER / CER table from results/*.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time
import unicodedata
from pathlib import Path

import numpy as np

import audio8_infinite_ref as a8i
import audio8_infinite_graph as a8i_onnx

ROOT = Path(__file__).parent
CKPT = Path(os.environ.get("A8I_CKPT", ROOT / "ckpt"))  # HF snapshot of Edge0/Audio8-ASR-Infinite
BUNDLE = Path(os.environ.get("A8I_BUNDLE", ROOT / "bundle"))  # audio8_infinite_export.py --out
RES = Path(os.environ.get("A8I_RESULTS", ROOT / "results"))
RES.mkdir(exist_ok=True)
BENCH = Path(__file__).resolve().parents[1] / "bench" / "audio"
DATA = Path(os.environ.get("A8I_DATA", ROOT / "data"))  # ls_clean/*.f32+.txt, fleurs_cmn_hans_cn/*.f32+.txt


def load_f32(p):
    return np.fromfile(p, dtype="<f4")


def audio_sets(names):
    """name -> list of (utt_id, wav, ref_text|None, lang_token)."""
    out = {}
    for n in names:
        if n == "jfk":
            import soundfile as sf

            x, sr = sf.read(BENCH / "jfk_16k_mono.wav", dtype="float32")
            out[n] = [("jfk", x, "And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.", a8i.LANG_EN)]
        elif n == "jfk_long":
            out[n] = [("jfk_long_66s", load_f32(BENCH / "jfk_long_66s.f32"), None, a8i.LANG_EN)]
        elif n == "long_varied":
            out[n] = [("long_varied", load_f32(BENCH / "long_varied.f32"), None, a8i.LANG_EN)]
        elif n in ("ls_clean", "fleurs_zh"):
            d = DATA / ("ls_clean" if n == "ls_clean" else "fleurs_cmn_hans_cn")
            lang = a8i.LANG_EN if n == "ls_clean" else a8i.LANG_ZH
            rows = []
            for f in sorted(d.glob("*.f32")):
                rows.append((f"{n}/{f.stem}", load_f32(f), f.with_suffix(".txt").read_text(encoding="utf-8").strip(), lang))
            out[n] = rows
        else:
            raise SystemExit(f"unknown set {n}")
    return out


# ---------------------------------------------------------------------------------- text metrics
def norm_en(s: str) -> str:
    s = s.lower().replace("’", "'")
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    return " ".join(s.split())


def norm_zh(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    s = "".join(ch for ch in s if not unicodedata.category(ch).startswith(("P", "Z", "S")) and not ch.isspace())
    return s.lower()


def wer(refs, hyps):
    import jiwer

    return jiwer.wer([norm_en(r) for r in refs], [norm_en(h) or "<empty>" for h in hyps])


def cer(refs, hyps):
    import jiwer

    return jiwer.cer([norm_zh(r) for r in refs], [norm_zh(h) or "-" for h in hyps])


# ---------------------------------------------------------------------------------- loaders
def weights_and_dims():
    cfg = json.loads((CKPT / "config.json").read_text())
    return a8i.load_weights(CKPT), a8i.Dims.from_config(cfg)


def tokenizer():
    from tokenizers import Tokenizer

    return Tokenizer.from_file(str(CKPT / "tokenizer.json"))


def ort_backend(prec, threads=None, enc_prec=None):
    sfx = "" if prec == "fp32" else f"_{prec}"
    esfx = sfx if enc_prec is None else ("" if enc_prec == "fp32" else f"_{enc_prec}")
    return a8i_onnx.OrtBackend(BUNDLE / f"audio_encoder{esfx}.onnx", [BUNDLE / f"decoder{sfx}.onnx"], threads=threads)


# ---------------------------------------------------------------------------------- commands
def cmd_onnx(args):
    W, dims = weights_and_dims()
    tok = tokenizer()
    be = ort_backend(args.prec, args.threads, args.enc_prec)
    tag = args.prec if args.enc_prec is None else f"{args.prec}_enc{args.enc_prec}"
    path = RES / f"onnx_{tag}.json"
    res = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    for set_name, rows in audio_sets(args.sets).items():
        for uid, wav, ref, lang in rows:
            if uid in res and not args.keep_logits:
                continue
            s = a8i.Session(be, W, dims, delay_tokens=6, frame_len=4, language=lang, rolling=True,
                            enc_batch=args.enc_batch, keep_logits=args.keep_logits)
            t = time.perf_counter()
            toks = s.run(wav)
            dt = time.perf_counter() - t
            text = a8i.visible_text(tok, toks)
            eot = [round(a8i.eot_probability(v), 4) for v in s.log.vad]
            res[uid] = {"tokens": toks, "text": text, "ref": ref, "seconds": len(wav) / 16000, "wall": dt,
                        "trims": s.trims, "eot": eot}
            if args.keep_logits:
                np.save(RES / f"logits_{tag}_{uid.replace('/', '_')}.npy", np.stack(s.log.logits).astype(np.float32))
            print(f"[{tag}] {uid} {len(wav) / 16000:.1f}s wall={dt:.1f}s rtf={dt / (len(wav) / 16000):.2f} "
                  f"trims={s.trims} :: {text[:120]}", flush=True)
            path.write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")


def cmd_torch(args):
    import torch

    torch.set_num_threads(args.threads or 16)
    W, dims = weights_and_dims()
    tok = tokenizer()
    ref = a8i.TorchRef(W, dims)
    draft_path = RES / f"onnx_{args.draft}.json"
    drafts = json.loads(draft_path.read_text(encoding="utf-8")) if draft_path.exists() else {}
    out_path = RES / "torch.json"
    res = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}
    for set_name, rows in audio_sets(args.sets).items():
        for uid, wav, reftext, lang in rows:
            if uid in res and not args.force:
                continue
            draft = drafts.get(uid, {}).get("tokens", [])
            t = time.perf_counter()
            with torch.no_grad():
                toks, logits, vad, passes = speculative_greedy(ref, W, dims, wav, lang, draft)
            dt = time.perf_counter() - t
            text = a8i.visible_text(tok, toks)
            res[uid] = {"tokens": toks, "text": text, "ref": reftext, "seconds": len(wav) / 16000,
                        "eot": [round(a8i.eot_probability(v), 4) for v in vad], "passes": passes, "wall": dt}
            np.save(RES / f"torchlogits_{uid.replace('/', '_')}.npy", np.stack(logits).astype(np.float32))
            print(f"[torch] {uid} steps={len(toks)} passes={passes} wall={dt:.0f}s :: {text[:120]}", flush=True)
            out_path.write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")


def speculative_greedy(ref, W, dims, wav, lang, draft):
    """Exact greedy decode with the torch reference; `draft` tokens only decide how many positions a
    single torch forward may verify at once (accepted prefix + the corrected token)."""
    s = a8i.Session(ref, W, dims, delay_tokens=6, frame_len=4, language=lang, rolling=True)
    stream = s.stream_of(wav)
    nwin = s.n_windows(len(stream))
    prompt = [a8i.BOS, lang] + [a8i.STREAM_PAD] * (s.prefill - 2)
    a, b = s.window_bounds(0)
    a0 = s.encode([stream[a:b]], s.prefill)
    audio = []
    k = 1
    while k < nwin:
        kk = list(range(k, min(nwin, k + 24)))
        audio.extend(list(s.encode([stream[s.window_bounds(j)[0]: s.window_bounds(j)[1]] for j in kk], 1)))
        k += len(kk)
    logits_all, vad_all = [], []

    def pick(lg):
        lg = np.asarray(lg, np.float32).reshape(-1).copy()
        lg[a8i.EOS] = -np.inf
        return int(lg.argmax())

    lg, vd = s.decode(a8i.embed_rows(W, prompt) + a0)
    out = [pick(lg)]
    logits_all.append(np.asarray(lg).reshape(-1))
    vad_all.append(np.asarray(vd).reshape(-1))
    passes = 1
    k = 1
    while k < nwin:
        s.maybe_trim(1)
        room = a8i.ROLL_CONTEXT - s.dlen
        m = min(room, nwin - k, 40)
        # inputs for steps k..k+m-1: the token emitted by step j-1 (accepted output, then draft)
        feed = [out[-1]] + [draft[j] if j < len(draft) else a8i.STREAM_PAD for j in range(k, k + m - 1)]
        d0 = s.dlen
        lg, vd = s.decode(a8i.embed_rows(W, feed) + np.stack(audio[k - 1: k - 1 + m]), all_logits=True)
        passes += 1
        lg, vd = np.asarray(lg)[0], np.asarray(vd)[0]
        accepted = m
        for j in range(m):
            t_ = pick(lg[j])
            out.append(t_)
            logits_all.append(lg[j])
            vad_all.append(vd[j].reshape(-1))
            if j + 1 < m and t_ != feed[j + 1]:
                accepted = j + 1
                break
        s.dlen = d0 + accepted
        k += accepted
    return out, logits_all, vad_all, passes


def cmd_shards(args):
    """fp32 ONNX decoder, one shard resident at a time, teacher-forced on torch greedy tokens."""
    import onnxruntime as ort

    W, dims = weights_and_dims()
    tref = json.loads((RES / "torch.json").read_text(encoding="utf-8"))
    enc = a8i_onnx.OrtBackend(BUNDLE / "audio_encoder.onnx", [])
    shards = sorted(BUNDLE.glob("decoder.part*.onnx"))
    out = {}
    for set_name, rows in audio_sets(args.sets).items():
        for uid, wav, _, lang in rows:
            toks = tref[uid]["tokens"]
            s = a8i.Session(enc, W, dims, delay_tokens=6, frame_len=4, language=lang, rolling=True)
            stream = s.stream_of(wav)
            nwin = s.n_windows(len(stream))
            a, b = s.window_bounds(0)
            a0 = s.encode([stream[a:b]], s.prefill)
            audio = []
            k = 1
            while k < nwin:
                kk = list(range(k, min(nwin, k + 24)))
                audio.extend(list(s.encode([stream[s.window_bounds(j)[0]: s.window_bounds(j)[1]] for j in kk], 1)))
                k += len(kk)
            prompt = [a8i.BOS, lang] + [a8i.STREAM_PAD] * (s.prefill - 2)
            inputs = [a8i.embed_rows(W, prompt) + a0] + [a8i.embed_rows(W, [toks[j - 1]]) + audio[j - 1][None] for j in range(1, nwin)]
            logits = None
            for sp in shards:
                be = a8i_onnx.OrtBackend(None, [sp])
                ds = a8i.Session(be, W, dims, delay_tokens=6, frame_len=4, language=lang, rolling=True, ada=s.ada)
                nxt, lgs = [], []
                for x in inputs:
                    ds.maybe_trim(x.shape[0])
                    n = x.shape[0]
                    pos = np.arange(ds.dlen, ds.dlen + n)
                    cos, sin = a8i.rope_cos_sin(pos, dims.t_head_dim, dims.t_theta)
                    bias = np.full((n, ds.L + n), a8i.NEG, np.float32)
                    bias[:, : ds.dlen] = 0.0
                    bias[:, ds.L:] = np.where(np.tril(np.ones((n, n), bool)), 0.0, a8i.NEG)
                    sess = be.decs[0]
                    names_in = {i.name for i in sess.get_inputs()}
                    layers = sorted(int(q.split("_")[-1]) for q in names_in if q.startswith("past_key_"))
                    feed = {("inputs_embeds" if "inputs_embeds" in names_in else "hidden"): x[None].astype(np.float32),
                            "ada_scale": ds.ada, "cos": cos, "sin": sin, "attn_bias": bias}
                    for i in layers:
                        feed[f"past_key_{i}"] = ds.dk[i]
                        feed[f"past_value_{i}"] = ds.dv[i]
                    names = [o.name for o in sess.get_outputs()]
                    r = dict(zip(names, sess.run(names, feed)))
                    for i in layers:
                        ds.dk[i][:, :, ds.dlen: ds.dlen + n] = r[f"key_{i}"]
                        ds.dv[i][:, :, ds.dlen: ds.dlen + n] = r[f"value_{i}"]
                    ds.dlen += n
                    if "hidden" in r:
                        nxt.append(r["hidden"][0])
                    else:
                        lgs.append(r["logits"].reshape(-1))
                del be
                inputs = nxt
                logits = lgs or logits
            tl = np.load(RES / f"torchlogits_{uid.replace('/', '_')}.npy")
            n = min(len(tl), len(logits))
            diffs = [float(np.abs(tl[i] - logits[i]).max()) for i in range(n)]
            am = []
            for i in range(n):
                q = logits[i].copy()
                q[a8i.EOS] = -np.inf
                am.append(int(q.argmax()))
            out[uid] = {"steps": n, "max_abs_logit_diff": max(diffs), "mean_max_abs_logit_diff": float(np.mean(diffs)),
                        "argmax_equal": am == toks[:n], "argmax_mismatches": int(sum(x != y for x, y in zip(am, toks)))}
            print("[fp32-shards]", uid, out[uid], flush=True)
            (RES / "fp32.json").write_text(json.dumps(out, indent=1), encoding="utf-8")


def cmd_report(args):
    torch_res = json.loads((RES / "torch.json").read_text(encoding="utf-8")) if (RES / "torch.json").exists() else {}
    rows = []
    for p in sorted(RES.glob("onnx_*.json")):
        tag = p.stem[5:]
        r = json.loads(p.read_text(encoding="utf-8"))
        line = {"prec": tag}
        for set_name, metric in (("ls_clean", wer), ("fleurs_zh", cer)):
            keys = [k for k in r if k.startswith(set_name + "/")]
            if keys:
                line[set_name] = round(100 * metric([r[k]["ref"] for k in keys], [r[k]["text"] for k in keys]), 2)
                line[set_name + "_n"] = len(keys)
                line[set_name + "_rtf"] = round(sum(r[k]["wall"] for k in keys) / sum(r[k]["seconds"] for k in keys), 3)
        for uid in ("jfk", "jfk_long_66s", "long_varied"):
            if uid in r:
                line[uid + "_rtf"] = round(r[uid]["wall"] / r[uid]["seconds"], 3)
                if uid in torch_res:
                    a, b = r[uid]["tokens"], torch_res[uid]["tokens"]
                    fd = next((i for i in range(min(len(a), len(b))) if a[i] != b[i]), None)
                    line[uid + "_tok_eq"] = (a == b)
                    line[uid + "_first_div"] = fd
                    line[uid + "_agree"] = round(float(np.mean([x == y for x, y in zip(a, b)])), 4)
        # token identity vs torch across all utterances that have a torch run
        common = [k for k in r if k in torch_res]
        if common:
            line["tok_identical_utts"] = f"{sum(r[k]['tokens'] == torch_res[k]['tokens'] for k in common)}/{len(common)}"
        rows.append(line)
    for line in rows:
        print(json.dumps(line, ensure_ascii=False))
    if torch_res:
        for set_name, metric in (("ls_clean", wer), ("fleurs_zh", cer)):
            keys = [k for k in torch_res if k.startswith(set_name + "/")]
            if keys:
                print("torch", set_name, round(100 * metric([torch_res[k]["ref"] for k in keys], [torch_res[k]["text"] for k in keys]), 2), len(keys))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("onnx")
    a.add_argument("--prec", required=True)
    a.add_argument("--enc-prec", default=None)
    a.add_argument("--sets", nargs="+", required=True)
    a.add_argument("--threads", type=int, default=None)
    a.add_argument("--enc-batch", type=int, default=16)
    a.add_argument("--keep-logits", action="store_true")
    a.set_defaults(fn=cmd_onnx)
    b = sub.add_parser("torch")
    b.add_argument("--draft", default="int8")
    b.add_argument("--sets", nargs="+", required=True)
    b.add_argument("--threads", type=int, default=None)
    b.add_argument("--force", action="store_true")
    b.set_defaults(fn=cmd_torch)
    c = sub.add_parser("shards")
    c.add_argument("--sets", nargs="+", required=True)
    c.set_defaults(fn=cmd_shards)
    d = sub.add_parser("report")
    d.set_defaults(fn=cmd_report)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
