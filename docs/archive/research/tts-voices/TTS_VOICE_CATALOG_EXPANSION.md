# TTS Voice & Language Expansion — Deep Research

**Date:** 2026-06-03
**Question:** For each TTS model family we ship (Kokoro, Kitten, Piper, Supertonic, Chatterbox), what additional voices/languages exist online that we can add — especially for the families that ship few — and which work with our **espeak-ng-only** G2P (no misaki/jieba)?
**Method:** Authoritative enumeration via the HuggingFace API (actual repo file/voice listings + `voices.json` catalogs), not web claims. Every repo path below was verified to exist.

---

## Executive summary

The single highest-value expansion by a wide margin is **Piper**: `rhasspy/piper-voices` holds **161 voices across 49 languages** [1], every one a VITS model trained on **espeak-ng phonemes** — i.e. they work with our *existing* Piper engine and *existing* espeak-only G2P with **zero new inference code**, and we currently ship exactly **1 of 161**. Adding a curated "one good voice per language" set takes us from 1 English Piper voice to **~49-language coverage** — and unlike Kokoro, Piper's `zh_CN` works for us because it was trained on espeak `cmn` phonemes (not misaki).

Everything else is incremental: **Supertonic-2-ONNX** is a drop-in quality upgrade (identical 10 voices + identical 3-graph I/O) but still English-only [2]; **Kitten** has newer/bigger models (nano-0.2, mini-0.8) that are quality bumps with small English voice sets [3]; **Kokoro** we already ship complete (all 54 v1.0 voices) and its CJK is fundamentally blocked on misaki regardless of which export we use [4]; **Chatterbox** is cloning-only, so "voices" means bundled reference clips (low priority — user clips already work).

**Do first:** Piper multilingual (≈49 voices, ~1 day, biggest coverage win). **Do next (cheap):** Supertonic→v2 repo swap. **Optional:** Kitten model bump.

---

## 1. Piper — THE win (49 languages, 161 voices, espeak-native) ★★★★★

**Repo:** `rhasspy/piper-voices` (MIT). `voices.json` is the authoritative catalog: **161 voices, 49 language-country codes** [1]:

```
ar_JO bg_BG ca_ES cs_CZ cy_GB da_DK de_DE el_GR en_GB en_US es_AR es_ES es_MX
eu_ES fa_IR fi_FI fr_FR hi_IN hu_HU id_ID is_IS it_IT ka_GE kk_KZ ku_TR lb_LU
lv_LV ml_IN ne_NP nl_BE nl_NL no_NO pl_PL pt_BR pt_PT ro_RO ru_RU sk_SK sl_SI
sq_AL sr_RS sv_SE sw_CD te_IN tr_TR uk_UA ur_PK vi_VN zh_CN
```

**Why it works for us with NO new code:**
- Each Piper voice ships `<voice>.onnx` + `<voice>.onnx.json`; the JSON carries the `phoneme_id_map`, sample_rate, and the espeak voice id. Our Piper engine *already* reads exactly these (per-voice json + espeak phonemes). So any Piper voice is loadable today.
- File path pattern (verified) [1]: `‹lang›/‹lang_COUNTRY›/‹name›/‹quality›/‹lang_COUNTRY›-‹name›-‹quality›.onnx` (+ `.onnx.json`). e.g. `de/de_DE/thorsten/high/de_DE-thorsten-high.onnx`. Our download manifest can construct this for any voice — same per-voice on-demand pattern we just built for Kokoro.
- **espeak compatibility: all 49 languages work**, because Piper voices were *trained on* espeak-ng phonemes for their language. This includes `zh_CN` (espeak `cmn`) and `hi_IN`, `ru_RU`, `ar_JO`, etc. — i.e. Piper is how we get **working Chinese**, which Kokoro can't do without misaki. (Quality of espeak `cmn` is imperfect but functional — the model was trained to it, unlike Kokoro's failure mode.)

**Recommended curated set — best voice per language** (prefer high→medium); 49 entries, ~20-60 MB each on-demand [1]:

| code | voice | q | code | voice | q | code | voice | q |
|---|---|---|---|---|---|---|---|---|
| en_US | lessac-high | high | de_DE | thorsten-high | high | en_GB | cori-high | high |
| es_ES | davefx-medium | med | es_MX | claude-high | high | fr_FR | siwis/upmc-medium | med |
| it_IT | paola-medium | med | pt_BR | faber/cadu-medium | med | pt_PT | tugão-medium | med |
| ru_RU | denis/dmitri-medium | med | pl_PL | bass/gosia-high | high | nl_NL | alex-medium | med |
| uk_UA | mykyta-high | high | tr_TR | dfki-medium | med | sv_SE | alma-medium | med |
| cs_CZ | jirka-medium | med | el_GR | rapunzelina-medium | med | hu_HU | anna-medium | med |
| fi_FI | harri-medium | med | da_DK | talesyntese-medium | med | no_NO | nvcc-medium | med |
| ro_RO | mihai-medium | med | sk_SK | lili-medium | med | hi_IN | pratham-medium | med |
| ar_JO | kareem-medium | med | fa_IR | amir-medium | med | vi_VN | vais1000-medium | med |
| zh_CN | huayan/chaowen-medium | med | id_ID | news_tts-medium | med | ca_ES | upc_ona-medium | med |
| … | (49 total — full list in voices.json) | | | | | | | |

Notes: `de_DE` (10 voices), `en_US` (26), `en_GB` (11), `pl_PL`/`fa_IR`/`uk_UA`/`nl_NL`/`es_ES` (5-6 each) have rich sub-selections if we want multiple voices per language later. A few voices are multi-speaker (`fr_FR-mls` 125 speakers, `cy_GB-bu_tts` 7) — our engine already passes `sid` when `num_speakers>1`.

**Effort:** catalog entries (one per voice, or generate from `voices.json`) + extend the Piper download manifest to the per-voice path (we just built the on-demand pattern for Kokoro). No engine changes. **License:** MIT, free to ship.

---

## 2. Supertonic → Supertonic-2 (drop-in quality upgrade) ★★★☆☆

**Repo:** `onnx-community/Supertonic-TTS-2-ONNX` [2]. Verified to have the **identical 10 voices** (F1-F5, M1-M5 `.bin`) and **identical 3-graph layout** (`onnx/text_encoder.onnx`, `latent_denoiser.onnx`, `voice_decoder.onnx` + `voice_decoder.onnx_data`, `tokenizer.json`, `config.json`) as the `Supertonic-TTS-ONNX` we ship. So it's a near drop-in: change `hf_repo` (and verify the runtime I/O names + `num_inference_steps` semantics still match — they should, same architecture).
- **Still English-only, still 10 voices** — no language/voice expansion. Supertonic-3 exists (`Supertone/supertonic-3`, `TensorStack/Supertonic-onnx`, coreml/mlx variants) but a clean, verified 3-graph ONNX export equivalent to ours wasn't confirmed; treat v3 as future work.
- **espeak:** N/A — Supertonic uses its own hand-rolled char tokenizer (no espeak), English only.

**Effort:** trivial (repo swap + a spike re-verify). **Win:** quality only.

---

## 3. Kitten — newer/bigger models, small English sets ★★☆☆☆

`KittenML` ships several beyond our `kitten-tts-nano-0.1` [3]: **`kitten-tts-nano-0.2`** (newer nano), **`kitten-tts-mini-0.8`** (bigger, adds `voice_aliases`/`speed_priors`), `micro-0.8`, plus ONNX mirrors (`onnx-community/kitten-tts-nano-0.1-ONNX`, `xybrid-ai/KittenTTS-Nano-0.2-ONNX`). All share our exact file shape (`<model>.onnx` + `voices.npz` + `config.json`) → drop-in for our Kitten engine.
- These are **quality/model upgrades with small English voice sets** (nano-0.1 = 8 voices; the others are comparable-scale English). Not a language expansion.
- **espeak:** English only (`en-us`), works.

**Effort:** low (swap model + read its `voices.npz`/config). **Win:** modest quality; optional.

---

## 4. Kokoro — already complete; CJK blocked on G2P ★☆☆☆☆

We already ship **all 54 v1.0 voices** (verified earlier: our catalog == repo, no 404). Findings [4]:
- **`hexgrad/Kokoro-82M-v1.1-zh`** — a v1.1 with more Chinese voices, but Kokoro Chinese needs **misaki[zh]** (jieba/pinyin); with espeak it fails the same way v1.0 `zh` does. **Not usable for us** without a CJK G2P port.
- **`Godelaune/Kokoro-82M-ONNX-German-Martin`** — a community German voice add-on. German already works via espeak, but Kokoro v1.0 has no native German voice, so this is a *possible* single-voice add (verify the .bin is the same `[510,256]` layout). Low priority.
- Misc: `nvidia/kokoro-82M-onnx-opt` (perf-optimized graph), timestamped variants — engineering, not voices.

**Net:** no meaningful voice/language win for us beyond what we have; CJK is a G2P problem, not a catalog problem.

---

## 5. Chatterbox — cloning-only; "voices" = bundled clips ★★☆☆☆

`onnx-community/chatterbox-multilingual-ONNX` is zero-shot cloning (23 langs), no preset speakers — by design. To offer "ready-made voices" we'd **bundle reference WAV clips** (the engine already accepts a clip path; we ship one `default_voice.wav`). Options: curate a handful of CC0/permissive reference clips (e.g. from public-domain speech corpora — LibriVox/CommonVoice CC0 subsets) and ship them as named preset cloning voices. **Licensing is the gating factor** (clips must be redistributable). Lower priority since user-supplied cloning already works.
- **espeak:** N/A (Chatterbox has its own tokenizer); multilingual already.

---

## Prioritized recommendation

1. **Piper multilingual (DO FIRST)** — 49 languages from one repo, MIT, espeak-native, *no engine changes*, on-demand per-voice download (pattern already built). Biggest coverage win for least effort. This is also our only path to **working Chinese/Hindi/Arabic/etc.** given the espeak-only constraint.
2. **Supertonic → `Supertonic-TTS-2-ONNX`** — cheap drop-in quality upgrade (same 10 voices/I-O).
3. **Kitten → nano-0.2 or mini-0.8** — optional quality bump (small English set).
4. **Kokoro** — leave as-is (complete); optionally add the community German voice. CJK needs a misaki-equivalent G2P (separate, larger effort) — the real unlock for Kokoro ja/zh.
5. **Chatterbox** — optional: ship a few permissively-licensed reference clips as preset cloning voices.

**Cross-cutting:** the espeak-only constraint means **Piper is strategically more valuable than chasing Kokoro CJK** — Piper gives ~49 working languages today; Kokoro CJK gives 2 languages only after a substantial G2P port.

---

## Sources
[1] `rhasspy/piper-voices` — `voices.json` (161 voices, 49 lang codes) + verified file-path pattern `de/de_DE/thorsten/high/de_DE-thorsten-high.onnx(.json)`. HF API. MIT.
[2] `onnx-community/Supertonic-TTS-2-ONNX` — verified file listing: 10 voices F1-F5/M1-M5, 3-graph onnx identical to `Supertonic-TTS-ONNX`. HF API.
[3] `KittenML` org listing — `kitten-tts-{nano-0.1, nano-0.2, mini-0.8, micro-0.8, mini-0.1}`; configs share `voices`+`voices.npz`+`<model>.onnx`. ONNX mirrors: `onnx-community/kitten-tts-nano-0.1-ONNX`, `xybrid-ai/KittenTTS-Nano-0.2-ONNX`. HF API.
[4] Kokoro search: `hexgrad/Kokoro-82M-v1.1-zh`, `Godelaune/Kokoro-82M-ONNX-German-Martin`, `nvidia/kokoro-82M-onnx-opt`; our shipped set == `onnx-community/Kokoro-82M-v1.0-ONNX` (54 voices). HF API. Apache-2.0.
