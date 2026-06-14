#!/usr/bin/env python3
"""Larger precision/recall eval for the encoder dictionary fallback — does the rank rule GENERALIZE
beyond the 12 hand-picked cases, and what K avoids clobbering real words?

A false positive can only occur on a word that passes the phonetic prefilter, so the negatives are
COLLISION words (real words that sound like a dict term: video/vet/French "vite" ~ "Vite", etc.) in
natural sentences across languages. Positives are varied phonetic CORRUPTIONS of terms. The FULL
multi-term dictionary is loaded for every case (realistic). Ranks are precomputed once per candidate
so K can be swept cheaply.

  python tools/bench/eval_encoder_dict_large.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import torch  # noqa: E402
from transformers import AutoModelForMaskedLM, AutoTokenizer  # noqa: E402

from eval_encoder_dict import apply_pairs, gen_vocab_candidates, mean_rank  # noqa: E402

MODELS = ["jhu-clsp/mmBERT-small", "jhu-clsp/mmBERT-base"]
RANK_KS = [10, 20, 30, 50, 75, 100, 150, 200, 300, 400, 600]
CAP_MS = 300.0

DICT = ["Vite", "ollama", "kubernetes", "ChargeBee", "Supabase", "PyTorch",
        "Redis", "Grafana", "Figma", "Kafka", "Postgres", "Tailwind"]

CORRUPTIONS = {
    "Vite": ["veet", "veet", "vight"],
    "ollama": ["oh llama", "o llama", "olama"],
    "kubernetes": ["kubernetties", "cooper netties"],
    "ChargeBee": ["charge bee", "charge be"],
    "Supabase": ["supa base", "super base"],
    "PyTorch": ["pie torch", "pi torch"],
    "Redis": ["reddis", "red iss"],
    "Grafana": ["graph ana", "gra fana"],
    "Figma": ["fig ma", "fig mah"],
    "Postgres": ["post gres", "poss gres"],
    "Tailwind": ["tail wind", "tale wind"],
}
POS_TMPL = {
    "en": ["we migrated the project to {X} last month.",
           "the team deployed {X} in production yesterday.",
           "have you configured {X} for the new service?",
           "our build pipeline runs on {X} now."],
    "fr": ["nous avons migré le projet vers {X} le mois dernier.",
           "l'équipe utilise {X} en production maintenant."],
    "de": ["wir haben das Projekt letzten Monat auf {X} migriert.",
           "das Team nutzt {X} jetzt in der Produktion."],
    "es": ["migramos el proyecto a {X} el mes pasado.",
           "el equipo usa {X} en producción ahora."],
}

# Collision negatives: real words that sound like a term, used in their NATURAL (non-brand) sense.
# Includes ADVERSARIAL cases: the collision word sitting in a tech/software context that could
# tempt the model into swapping it for the dict term.
NEG_COLLISION = [
    "I watched a long video about cooking last night.",
    "the video call dropped twice this morning.",
    "she uploaded the video to the channel yesterday.",
    "please mute the video before the meeting starts.",
    "the new video codec ships in the next release.",          # adversarial: video in tech context
    "we render the video on the server with ffmpeg.",          # adversarial
    "the vet examined my cat very carefully.",
    "we took the dog to the vet this afternoon.",
    "my sister is studying to become a vet.",
    "the vet updated the software on the clinic computer.",     # adversarial: vet + tech
    "viens vite, on va être en retard pour le train.",
    "il faut courir vite pour attraper le bus.",
    "réponds vite à ce message s'il te plaît.",
    "tape vite la commande dans le terminal.",                 # adversarial: French vite + terminal
    "la vidéo était très longue ce matin.",
    "ich habe gestern ein langes Video gesehen.",
    "el vídeo de la conferencia ya está disponible.",
    "the plane landed early thanks to a strong tail wind.",     # tailwind collision
    "a tail wind pushed the cyclists down the hill.",
    "the wine vat in the cellar is almost full.",               # vat ~ Vite
    "please cast your vote before the deadline tonight.",       # vote ~ Vite
    "are you ready to ship the release today?",
    "the quarterly report is ready for review.",
    "I read a strange novel by Kafka last summer.",
    "the figure on page two is hard to read.",
    "he poured the milk into a tall glass.",
    "the postman delivered the parcel at noon.",
    "we deployed the fix and the latency dropped.",            # tech, no collision -> must stay
]
# Clean negatives: no collision word at all -> must never change.
NEG_CLEAN = [
    "the weather is really nice today.",
    "please send me the report by Friday afternoon.",
    "we scheduled the standup for nine in the morning.",
    "let's grab lunch after the demo.",
    "the train was delayed by twenty minutes.",
    "merci beaucoup pour ton aide hier soir.",
    "das Wetter ist heute wirklich schön.",
]


def build_cases():
    pos, neg = [], []
    for term, corrs in CORRUPTIONS.items():
        for lang, tmpls in POS_TMPL.items():
            for ti, tmpl in enumerate(tmpls):
                corr = corrs[ti % len(corrs)]
                pos.append(dict(text=tmpl.format(X=corr), term=term, corr=corr))
    for s in NEG_COLLISION + NEG_CLEAN:
        neg.append(dict(text=s))
    return pos, neg


def candidate_ranks(model, tok, text):
    """Return (base_text, [(cs, ce, term, rank), ...]) — ranks computed once for K sweeping."""
    base = apply_pairs(text, [])
    cands = gen_vocab_candidates(base, DICT)
    cands.sort(key=lambda c: (-c[0], c[5]))
    used, out = [], []
    for _n, cs, ce, _span, term, _d in cands:
        if any(not (ce <= a or cs >= b) for a, b in used):
            continue
        used.append((cs, ce))
        r = mean_rank(model, tok, base, cs, ce)
        if r is not None:
            out.append((cs, ce, term, r))
    return base, out


def apply_k(base, ranked, k):
    edits = [(cs, ce, term) for (cs, ce, term, r) in ranked if r > k]
    text = base
    for cs, ce, term in sorted(edits, reverse=True):
        text = text[:cs] + term + text[ce:]
    return text


def recall_fp(pos_r, neg_r, k):
    tp = sum(1 for (c, base, rk) in pos_r
             if c["term"].lower() in apply_k(base, rk, k).lower()
             and c["corr"].lower() not in apply_k(base, rk, k).lower())
    fp = sum(1 for (_c, base, rk) in neg_r if apply_k(base, rk, k) != base)
    return (tp / len(pos_r) if pos_r else 0.0), fp


def main():
    pos, neg = build_cases()
    # Deterministic held-out split (no RNG): even index -> dev, odd -> test.
    print(f"cap {CAP_MS:.0f}ms | positives {len(pos)} | negatives {len(neg)} "
          f"(collision {len(NEG_COLLISION)} + clean {len(NEG_CLEAN)})\n"
          f"Held-out: K chosen on DEV (even idx), reported on unseen TEST (odd idx).\n" + "=" * 76)
    for mid in MODELS:
        print(f"\n### {mid}")
        try:
            tok = AutoTokenizer.from_pretrained(mid)
            model = AutoModelForMaskedLM.from_pretrained(mid).eval()
        except Exception as e:  # noqa: BLE001
            print(f"  LOAD FAILED: {type(e).__name__}: {str(e)[:140]}")
            continue
        mean_rank(model, tok, "warm up now.", 0, 4)
        t0 = time.perf_counter()
        pos_r = [(c, *candidate_ranks(model, tok, c["text"])) for c in pos]
        neg_r = [(c, *candidate_ranks(model, tok, c["text"])) for c in neg]
        dt = (time.perf_counter() - t0) / (len(pos) + len(neg)) * 1000
        print(f"  ~{dt:.0f} ms/utterance (rank pass)  [{'UNDER' if dt <= CAP_MS else 'OVER'} cap]")

        pos_dev, pos_test = pos_r[::2], pos_r[1::2]
        neg_dev, neg_test = neg_r[::2], neg_r[1::2]
        # Choose K on DEV: zero false positives, then max recall.
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
        print(f"  K* (picked on dev) = {k}")
        print(f"    DEV : recall {dr:.0%}  false-pos {dfp}/{len(neg_dev)}")
        print(f"    TEST: recall {tr:.0%}  false-pos {tfp}/{len(neg_test)}   <- held-out")
        print(f"    ALL : recall {fr:.0%}  false-pos {ffp}/{len(neg_r)}")
        # Show any TEST false positives (the dangerous ones).
        for (c, base, rk) in neg_test:
            out = apply_k(base, rk, k)
            if out != base:
                print(f"    [TEST-FP] {base}  ->  {out}")


if __name__ == "__main__":
    main()
