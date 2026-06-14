#!/usr/bin/env python3
"""Spike: can a small multilingual masked-LM (encoder) act as the NON-LLM dictionary fallback?

Approach under test (deterministic, no generative LLM):
  1. PERMISSIVE phonetic candidate generation — propose (span -> dictionary term) whenever a 1-2 word
     span sounds like a term (soundex match or low edit distance). This deliberately also proposes
     wrong ones like "video"->"Vite" so the LM has to reject them.
  2. CONTEXT decision via masked-LM pseudo-log-likelihood: score the span tokens vs the term tokens
     in the SAME surrounding context (mask each, avg log-prob per token). Replace only if the term
     fits the context clearly better than the original (delta > margin). Scoring the ORIGINAL word's
     fit (not the rare brand's absolute prob) is what sidesteps the out-of-vocab problem.
  3. Replacement PAIRS are deterministic whole-word find->replace (unambiguous; no LM needed).

Picks the most accurate model whose per-utterance latency stays under the cap.

  python tools/bench/eval_encoder_dict.py
"""
import re
import time

import torch
from transformers import AutoModelForMaskedLM, AutoTokenizer

LATENCY_CAP_MS = 300.0
MODELS = ["jhu-clsp/mmBERT-small", "jhu-clsp/mmBERT-base", "FacebookAI/xlm-roberta-base"]
# Rank rule: replace the original span with its phonetic candidate when the original word is
# contextually UNEXPECTED — its mean token rank among the MLM's predictions for that slot exceeds
# RANK_K. Rank is scale-free (no per-language log-prob calibration) and never scores the OOV term.
RANK_KS = [5, 10, 20, 30, 50, 75, 100, 200, 400]

CASES = [
    dict(text="I watched a video this morning before the meeting.",
         vocab=["Vite"], pairs=[], contains=["video"], absent=["Vite"]),
    dict(text="I switched the project from webpack to veet for faster builds.",
         vocab=["Vite"], pairs=[], contains=["Vite"], absent=[]),
    dict(text="I ran the model locally with oh llama last night.",
         vocab=["ollama"], pairs=[], contains=["ollama"], absent=[]),
    dict(text="Will it transcribe the text cleanly?",
         vocab=["Vite", "ollama"], pairs=[], contains=["transcribe"], absent=["Vite", "ollama"]),
    dict(text="push the branch to github when you are done.",
         vocab=[], pairs=[("github", "GitHub")], contains=["GitHub"], absent=[]),
    # extra multilingual / harder probes (not in the original 5)
    dict(text="utiliser veet pour compiler le projet rapidement.",
         vocab=["Vite"], pairs=[], contains=["Vite"], absent=[]),
    dict(text="la video etait tres longue ce matin.",
         vocab=["Vite"], pairs=[], contains=["video"], absent=["Vite"]),
    # stress: accented French (real STT output), false-positive guards, exact match, German
    dict(text="la vidéo était très longue ce matin.",
         vocab=["Vite"], pairs=[], contains=["vidéo"], absent=["Vite"]),
    dict(text="the vet checked my dog yesterday.",
         vocab=["Vite"], pairs=[], contains=["vet"], absent=["Vite"]),
    dict(text="we deployed with vite and it was fast.",
         vocab=["Vite"], pairs=[], contains=["Vite"], absent=[]),
    dict(text="ich habe ein Video geschaut heute morgen.",
         vocab=["Vite"], pairs=[], contains=["Video"], absent=["Vite"]),
    dict(text="use veet to bundle the application.",
         vocab=["Vite"], pairs=[], contains=["Vite"], absent=[]),
]

WORD_RE = re.compile(r"[A-Za-z0-9À-ɏЀ-ӿ؀-ۿ]+")


def soundex(s: str) -> str:
    s = "".join(c for c in s.lower() if c.isalpha())
    if not s:
        return ""
    codes = {**dict.fromkeys("bfpv", "1"), **dict.fromkeys("cgjkqsxz", "2"),
             **dict.fromkeys("dt", "3"), "l": "4", **dict.fromkeys("mn", "5"), "r": "6"}
    out = s[0].upper()
    prev = codes.get(s[0], "")
    for ch in s[1:]:
        c = codes.get(ch, "")
        if c and c != prev:
            out += c
        if ch not in "hw":
            prev = c
    return (out + "000")[:4]


def lev(a: str, b: str) -> int:
    m, n = len(a), len(b)
    if not m:
        return n
    if not n:
        return m
    prev = list(range(n + 1))
    for i in range(1, m + 1):
        cur = [i] + [0] * n
        for j in range(1, n + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[n]


def phonetic_close(a: str, b: str) -> bool:
    a, b = a.lower(), b.lower()
    if a == b:
        return True
    if soundex(a) and soundex(a) == soundex(b):
        return True
    # Edit-only matches (different soundex) must be MUCH closer — 0.5 let garbage through
    # ("please"~"supabase", "mute"~"vite" both 0.50). Genuine corruptions are well under 0.34;
    # real phonetic collisions (video/veet/vat ~ Vite) come in via the soundex branch above.
    return lev(a, b) / max(len(a), len(b), 1) < 0.34


def gen_vocab_candidates(text, vocab):
    """Permissive: propose (n_words, start, end, span_text, term) for 1-2 word windows near a term.
    Longer spans first so "oh llama"->"ollama" beats the 1-word "llama"->"ollama"."""
    words = [(m.group(0), m.start(), m.end()) for m in WORD_RE.finditer(text)]
    cands = []
    for term in vocab:
        tnorm = "".join(c for c in term.lower() if c.isalnum())
        for n in (2, 1):
            for i in range(len(words) - n + 1):
                span = words[i:i + n]
                span_norm = "".join(w[0].lower() for w in span)
                if phonetic_close(span_norm, tnorm):
                    d = lev(span_norm, tnorm)
                    cands.append((n, span[0][1], span[-1][2],
                                  text[span[0][1]:span[-1][2]], term, d))
    return cands


@torch.no_grad()
def mean_rank(model, tok, text, char_start, char_end):
    """Mean rank of the ORIGINAL span tokens among the MLM's predictions for their (masked) slots.
    0 = the model's top choice. High = contextually unexpected. Scale-free; never scores the term."""
    enc = tok(text, return_tensors="pt", return_offsets_mapping=True)
    offsets = enc.pop("offset_mapping")[0].tolist()
    ids = enc["input_ids"][0]
    span = [i for i, (s, e) in enumerate(offsets)
            if not (s == 0 and e == 0) and s < char_end and e > char_start]
    if not span:
        return None
    mask_id = tok.mask_token_id
    batch = ids.unsqueeze(0).repeat(len(span), 1).clone()
    for r, ti in enumerate(span):
        batch[r, ti] = mask_id
    attn = enc["attention_mask"].repeat(len(span), 1)
    logits = model(input_ids=batch, attention_mask=attn).logits
    total = 0.0
    for r, ti in enumerate(span):
        row = logits[r, ti]
        total += (row > row[ids[ti]]).sum().item()  # how many tokens outrank the true one
    return total / len(span)


def apply_pairs(text, pairs):
    for find, repl in pairs:
        text = re.sub(rf"\b{re.escape(find)}\b", repl, text, flags=re.IGNORECASE)
    return text


def correct(model, tok, case, rank_k):
    """Rank rule: replace a phonetic-candidate span with its term when the ORIGINAL span is
    contextually unexpected — mean token rank > rank_k. Never scores the (OOV) term."""
    text = apply_pairs(case["text"], case["pairs"])
    cands = gen_vocab_candidates(text, case["vocab"])
    cands.sort(key=lambda c: (-c[0], c[5]))  # longer spans, then closest term
    used = []
    edits = []
    for _n, cs, ce, _span, term, _d in cands:
        if any(not (ce <= a or cs >= b) for a, b in used):
            continue
        used.append((cs, ce))
        r = mean_rank(model, tok, text, cs, ce)
        if r is not None and r > rank_k:  # original is unexpected -> trust the phonetic candidate
            edits.append((cs, ce, term))
    for cs, ce, term in sorted(edits, reverse=True):
        text = text[:cs] + term + text[ce:]
    return text


def passes(out, case):
    low = out.lower()
    return (all(s.lower() in low for s in case["contains"])
            and all(s.lower() not in low for s in case["absent"]))


def main():
    print(f"transformers torch ok | cap {LATENCY_CAP_MS:.0f}ms | {len(CASES)} cases\n" + "=" * 74)
    results = []
    for mid in MODELS:
        print(f"\n### {mid}")
        try:
            tok = AutoTokenizer.from_pretrained(mid)
            model = AutoModelForMaskedLM.from_pretrained(mid).eval()
        except Exception as e:  # noqa: BLE001
            print(f"  LOAD FAILED: {type(e).__name__}: {str(e)[:160]}")
            continue
        if tok.mask_token_id is None:
            print("  no mask token — not an MLM, skipping")
            continue
        # warm up (first pass pays graph init)
        mean_rank(model, tok, "warm up the model now.", 0, 4)
        # pick best rank threshold
        best = None
        for k in RANK_KS:
            t0 = time.perf_counter()
            outs = [correct(model, tok, c, k) for c in CASES]
            dt = (time.perf_counter() - t0) / len(CASES) * 1000
            acc = sum(passes(o, c) for o, c in zip(outs, CASES))
            if best is None or acc > best[0]:
                best = (acc, k, dt, outs)
        acc, margin, dt, outs = best
        ok_lat = dt <= LATENCY_CAP_MS
        print(f"  best: {acc}/{len(CASES)} @ rankK {margin}  |  {dt:.0f} ms/utterance  "
              f"[{'UNDER cap' if ok_lat else 'OVER cap'}]")
        for o, c in zip(outs, CASES):
            print(f"    [{'PASS' if passes(o, c) else 'FAIL'}] {o}")
        results.append((mid, acc, margin, dt, ok_lat))

    print("\n" + "=" * 74 + "\nSUMMARY (most accurate under cap wins):")
    elig = [r for r in results if r[4]]
    elig.sort(key=lambda r: (-r[1], r[3]))
    for mid, acc, margin, dt, ok in sorted(results, key=lambda r: (-r[1], r[3])):
        tag = "WINNER" if elig and elig[0][0] == mid else ("under" if ok else "OVER-CAP")
        print(f"  {mid:32s} {acc}/{len(CASES)}  rankK {margin}  {dt:.0f}ms  [{tag}]")


if __name__ == "__main__":
    main()
