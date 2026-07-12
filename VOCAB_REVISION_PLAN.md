# Vocabulary / Dictionary Correction — Revision Plan

**Date:** 2026-07-11 · **Status:** Phase 0 + Phase 1 IMPLEMENTED · **Scope:** Vocabulary tab, `encoder_dict`, post-processing pipeline, LLM prompt injection

---

## Implementation status (2026-07-11)

**Shipped:** all of Phase 0 (0.1–0.6) and Phase 1's core (retrieval index + verifier + rewiring + eval harness). Deferred: Phase 0.7 (typo-warning badge), Phase 2 (decode-time hotword boosting), Phase 3 (SpellMapper), the physical relocation of the metaphone module, and the confusion-table expansion.

**Load-bearing course-correction — the PLL-margin idea was measured and rejected.** Phase 1.3 planned a `meanLogP(term) − meanLogP(original) > τ` margin rule. On the real int8 model (`src-tauri/examples/dict_eval.rs`) it gave **0% recall at every τ**: dictionary terms are rare brand tokens, so a spliced-in "Vite" ranks ~118699 while the mishearing "veet" (common subwords) ranks ~4697 — the term always scores *worse*, so any term-vs-original comparison rejects every real fix. The OOV-robust signal is the **original's rank alone**. The shipped decision is therefore the **one-sided `rank(original) > K`** rule (K=600), which measured **100% recall / 0 false positives** at K∈{300,600,900,1500}, ~42 ms/utterance. The large-dictionary robustness the plan targeted comes entirely from the **bounded top-K retrieval** (index.rs), not the decision rule. The comparison survives only as env `WINSTT_DICT_COMPARE=1`. Env tunables: `WINSTT_DICT_RANK_K`, `WINSTT_DICT_DEBUG=1`.

Gates: cargo check/clippy `-D warnings` (isolated target — the user's live `tauri dev` locks the normal one), cargo fmt, tsc, biome, i18n parity (0 missing/0 stale), 1245 lib tests + 154 FE tests green. (One pre-existing lib failure, `catalog_data::…streaming_latency…`, is the user's unrelated uncommitted NVIDIA-catalog work.)

---

## 1. Background & diagnosis

The Vocabulary dictionary supports two entry kinds (`src/shared/config/settings-schema/core.ts:118-144`):

- **Vocab term** (`replacement` absent) — a proper noun / jargon word to bias *toward* ("Vite", "Kubernetes").
- **Replacement pair** (`replacement` present) — deterministic "always rewrite X → Y".

Two correction paths exist and are mutually exclusive (`src-tauri/src/actions/post_process.rs`):

- **LLM path** (when `llm.dictation.enabled`): dictionary injected into the system prompt; LLM is sole authority.
- **Encoder path** (when LLM off + `general.encoderDictionaryEnabled`): deterministic replacement pairs, then mmBERT-base int8 (~310 MB) masked-LM correction (`src-tauri/src/winstt/encoder_dict/`).

### Why the encoder path misfires (structural, not tuning)

1. **Loose prefilter, independent tests.** Every 1–2-word window is compared against *every* term (`phonetics.rs::candidates`, edit-ratio < 0.34 OR Soundex). Each survivor gets an **independent** accept test. With N surviving candidates per utterance, false-swap probability compounds ≈ linearly with dictionary size.
2. **Uncalibrated one-sided decision rule.** `mean_rank(original) > 600` (`engine.rs:23,82-85`) asks only *"is the original word surprising?"* — never *"does the term fit better?"*. Consequences:
   - **False swap:** any surprising-but-correct word phonetically near a term gets swapped.
   - **Missed swap:** a mishearing that is itself a fluent common word ranks fine (< 600) and never swaps.
3. **Candidate shadowing.** Longest-span/closest-edit sort + overlap-skip (`engine.rs:78`) lets a closer-but-wrong term shadow the right one; there is no joint argmax over competing terms.

The 2020–2026 literature (NVIDIA SpellMapper [arXiv:2306.02317], Microsoft CSC [arXiv:2203.00888] — shipped in Azure ASR customization, BR-ASR [arXiv:2505.19179]) converges on **retrieve-then-verify**: a high-recall phonetic index returns a fixed top-K (~10) regardless of dictionary size, and a verifier makes a *margin-based* decision (candidate vs original), with a no-swap prior. Recall@10 ≈ 90% is achievable with pure n-gram retrieval; BR-ASR holds at 200k entries.

**Verdict:** keep the dictionary, keep the on-device masked-LM. Replace the prefilter with a retrieval index and the rank rule with a PLL-margin rule. Do not adopt a large LLM; do not revert to string matching (decided 2026-06-14: no string/phonetic rule can accept "veet"→Vite and reject "video"→Vite — only context can).

---

## 2. Phase 0 — Correctness & plumbing fixes (independent of the rebuild)

Each item is shippable on its own. Order within the phase is by user pain.

### 0.1 Decouple deterministic replacement pairs from the encoder toggle
- **Problem:** `post_process.rs:538` gates the whole non-LLM block (deterministic pairs **and** encoder) on `encoder_dictionary_enabled`. Pairs need no model; turning the encoder off silently kills them.
- **Fix:** split the block. Run `apply_replacement_pairs_counted()` whenever `!winstt_dictation_llm && recording_mode != Listen`, regardless of the encoder flag. Keep the encoder call behind `encoder_dictionary_enabled`.
- **Files:** `src-tauri/src/actions/post_process.rs` (restructure step 6a/6d gating).
- **Accept:** with encoder toggle OFF and LLM OFF, a pair `foo → bar` still rewrites; `dictionary_fixes` counts it. Unit test in `post_process.rs` tests module.

### 0.2 Replacement-pair authoring UI in the Vocabulary tab
- **Problem:** `DictionaryTable.tsx:15` has `EDITABLE_COLUMNS = ["term"]`; the schema/bindings support `replacement` but no UI can set it. Pairs only enter via settings import or LLM auto-add.
- **Fix:** add an editable **Replacement** column (empty = vocab term; filled = pair). Update `newDictionaryEntry()`, the add-row flow in `DictionarySettingsPanel.tsx`, and dedupe (`dictionary-terms.ts`) to treat `(term, replacement)` as the identity, not `term` alone.
- **UI notes:** DiceUI grid conventions (see `project_datagrid_diceui_replacement`); empty-cell placeholder styled muted; the kind is derivable so **no extra toggle/column for "type"** (settings stay flat).
- **i18n:** new keys (`dictionary.replacementColumn`, placeholder, help text) × 20 locales; run the i18n parity check.
- **Files:** `src/widgets/dictionary-settings/ui/DictionaryTable.tsx`, `DictionarySettingsPanel.tsx`, `src/widgets/dictionary-settings/lib/dictionary-terms.ts`, `messages/*.json`.
- **Accept:** author `gonna → going to` in the tab; dictate; rewrite fires on the non-LLM path (after 0.1). FE tests for the table edit + dedupe.

### 0.3 Post-LLM deterministic replacement safety net (fix the stale contract)
- **Problem:** `core.ts:126-130` documents that pairs are applied *after* the LLM pass; `llm.rs:370-377` explicitly does the opposite ("LLM is the SOLE authority") and returns `dictionary_fixes: 0` unconditionally. A model that ignores a pair silently drops it, uncounted.
- **Fix:** after a successful LLM pass, run `apply_replacement_pairs_counted()` on the LLM output (case-insensitive whole-word, exactly as the schema comment promises) and fold the count into `dictionary_fixes`. Keep pairs in the prompt too (helps the model phrase around them), but the post-pass is the guarantee.
- **Files:** `src-tauri/src/actions/post_process.rs` (LLM branch), `src-tauri/src/winstt/commands/llm.rs` (remove the hardcoded 0 + stale comment).
- **Accept:** LLM ON, pair `X → Y`, model instructed prompt removed in a test double → output still has Y; History AI-Impact counts it.

### 0.4 Case restoration for encoder substitutions
- **Problem:** `engine.rs:91-95` splices the term verbatim; matching is case-insensitive but output casing ignores sentence position (a swap at sentence start keeps the term's canonical casing — fine for brands, wrong for common-word terms; and an ALL-CAPS source span becomes mixed case).
- **Fix:** small `restore_case(source_span, term)` helper: if source is ALL-CAPS → uppercase term; if source is Title-case at sentence start and term is all-lowercase → capitalize; otherwise keep the term's canonical casing (brands like "DirectML" must never be down-cased).
- **Files:** `src-tauri/src/winstt/encoder_dict/engine.rs` + unit tests.
- **Accept:** table-driven tests: `VEET → VITE`? No — canonical "Vite" wins for mixed-case brands; `veet` at sentence start → `Vite` (already capital); lowercase term `kubernetes` at sentence start → `Kubernetes`.

### 0.5 Remove the orphaned `wordCorrectionThreshold` setting
- **Problem:** persisted + round-tripped (`general.ts:347`, `settings_schema.rs:898`) but consumed by **nothing** — the corrector it configured was deleted in the 2026-06-14 rework.
- **Fix:** delete from zod schema, Rust schema, defaults, any SettingField row, and its i18n keys. Zod `.catch`/serde-default make removal migration-safe under the single settings store.
- **Files:** `src/shared/config/settings-schema/general.ts`, `src-tauri/src/winstt/settings_schema.rs`, `src-tauri/src/settings/defaults.rs`, settings UI row if rendered, `messages/*.json`, `spec/fixtures/winstt-settings.default.json`.
- **Accept:** old settings file with the field loads cleanly; tsc + cargo green; fixture updated.

### 0.6 Cap and structure the LLM prompt dictionary injection
- **Problem:** `prompts.rs:346-348` emits one line per entry, unbounded — a large dictionary bloats tokens and degrades small local models (gemma-class).
- **Fix:** cap injected vocab terms (default **50**, constant in `prompts.rs`) with deterministic priority: (1) terms phonetically retrieved against the *current transcript* once Phase 1's index exists (best), until then (2) most-recently-added first. Replacement pairs stay uncapped (they're guaranteed by 0.3's post-pass anyway, and are usually few). Log a debug line when truncating.
- **Files:** `src-tauri/src/winstt/llm/prompts.rs` (`build_dictionary_block`), `commands/llm.rs::build_vocab`.
- **Accept:** unit test — 500-term dictionary yields ≤ 50 `- term` lines; pairs intact.

### 0.7 Dictionary hygiene (small, optional)
- The user's own dictionary contained the typo term "Parkeet". The corrector faithfully propagates dictionary typos. Add a soft warning badge in the table when a term is 1 edit away from a much more frequent English word *and* from another entry — advisory only, dismissible, no blocking. (Low priority; skip if noisy.)

**Phase 0 gates:** `cargo check && cargo clippy --all-targets -- -D warnings` (via `cmd //c` env recipe), `bun tsc`, Biome, FE tests, i18n parity ×20, fixture sync.

---

## 3. Phase 1 — Retrieve-then-verify rebuild (the core fix)

Goal: correction quality **flat** with dictionary size; both failure modes fixed by a margin rule; Arabic path actually functional. Reuses the existing mmBERT engine, download manager, toggle, and card UI unchanged.

### 1.1 New module: `encoder_dict/index.rs` — phonetic inverted index
Built once per dictionary change (and per context-terms snapshot union), not per utterance.

Per term, index:
1. **Character n-grams** (n = 2..4) of the normalized term — script-agnostic (works for Arabic where Soundex returns nothing today).
2. **Double Metaphone codes** — **reuse the existing faithful port** at `src-tauri/src/winstt/snippets/phonetic.rs` instead of `encoder_dict/phonetics.rs`'s crude ASCII Soundex. Promote the metaphone code to a shared module (`src-tauri/src/winstt/phonetics/` used by both snippets and encoder_dict) — this also retires the "two parallel phonetic stacks" smell.
3. **Confusion-variant n-grams**: a small hand-maintained per-language table of ASR-plausible substitutions (`v↔f`, `ee↔i`, `c↔k`, `ph↔f`; Arabic: `ط↔ت`, `ذ↔ز`, `ق↔ك`, hamza variants) applied to the term to generate additional n-gram keys — the cheap approximation of SpellMapper's mined 1.9M misspelled-n-gram mappings.

Data structure: `HashMap<NGram, SmallVec<TermId>>` + per-term metadata (token count, metaphone, normalized form). Size: a few MB at thousands of terms. Rebuild trigger: settings-change hot-swap hook (same mechanism as other hot-swap keys) + on the context-terms union in `post_process.rs`.

### 1.2 Retrieval (replaces `phonetics.rs::candidates`)
Per utterance:
1. Slide 1–3-word windows (raise the current 1–2 cap; 3-word terms are currently unreachable) over the transcript; collect window n-grams.
2. Score terms by n-gram overlap: `hits / (term_ngrams + window_ngrams − hits)` (Jaccard-ish), boosted on metaphone equality.
3. Take global **top-K = 10** `(window, term)` pairs, then apply a *tight* phonetic gate (weighted edit distance on metaphone/char level) to typically leave 0–3 verifier calls.

Properties: O(utterance length), independent of dictionary size; recall target ≥ 90% @ 10 (SpellMapper achieves this with the same method).

### 1.3 Verification (replaces the rank rule in `engine.rs`)
For each surviving `(span, term)`:
- **PLL(original):** existing machinery — mask each original-span token, sum `log P(token | context)` (change from rank to log-prob; the logits are already computed, `engine.rs:148-151`).
- **PLL(candidate):** splice the term into the text, tokenize, mask each term token, sum log-probs. One batched forward per candidate (rows = span tokens), same as today's cost shape but bounded by K, not by dictionary size.
- **Decide:** swap iff

  `PLL(term) − PLL(original) > τ_margin`  **AND**  `phonetic_distance(span, term) < τ_phon`

  with `τ_margin > 0` (the no-swap prior — Microsoft CSC's "biasing degree" control).
- **Joint resolution:** for overlapping spans, pick the single best margin (argmax), not first-come — fixes shadowing (bug 8).
- Keep the existing 2 s correction timeout, 500 ms engine-lock timeout, idle-unload, and fail-soft no-op when the model is absent (`mod.rs:30-31,281`).

**Why this fixes both failure modes:** a fluent-but-wrong original loses when the term scores *higher* (missed-swap fix); a surprising-but-correct original survives because no term scores higher by the margin (false-swap fix).

### 1.4 Calibration & evaluation (before wiring in)
- Extend the existing harnesses `tools/bench/eval_encoder_dict.py` / `eval_encoder_dict_large.py` / `eval_onnx_artifact.py`:
  - **Large-dictionary stress set:** 500–1000 distractor terms (package names, brands) + the existing adversarial pairs (video≠Vite, please≠Supabase, mute≠Vite).
  - Sweep `τ_margin × τ_phon` → pick the knee: **0 false positives** at ≥ 85% recall with 500 distractor terms (the old bar, now at 50× the dictionary size).
  - Arabic mini-set (10–20 term/mishearing pairs) to validate the script-agnostic path.
- Latency budget: ≤ 50 ms p50 / ≤ 150 ms p95 per utterance on CPU with 1000 terms (index lookup is sub-ms; verifier ≤ ~3 forward passes).
- Ship the chosen constants as named consts with the eval evidence cited in a comment (same convention as `DEFAULT_RANK_K` had).

### 1.5 Optional model downsize: mmBERT-small
- `jhu-clsp/mmBERT-small` (≈140M params, ~140 MB int8, same tokenizer family) — previously rejected because it was foolable under the *old* rank rule; re-evaluate under the margin rule where the verifier only sees well-retrieved candidates. If it matches base on the stress set → make it the default download (310 MB → 140 MB user win); keep base as an opt-in "higher accuracy" variant resolved by the same downloader (`encoder_dict/download.rs` already handles arbitrary file lists).
- Decision is data-driven by 1.4; if small regresses, stay on base — the architecture fix is the point, not the model swap.

### 1.6 Arabic support specifics
- Retrieval: char n-grams already script-agnostic; add the Arabic confusion table (1.1) and skip metaphone for non-Latin (edit distance on normalized forms instead).
- Verifier: mmBERT is multilingual (1833 languages) — works as-is.
- Defer full G2P (espeak-ng FFI) — heavier native dependency; only revisit if the Arabic eval set underperforms.

### 1.7 Cleanup within the phase
- Delete the Soundex implementation and `EDIT_RATIO_MAX` from `encoder_dict/phonetics.rs` (superseded); keep the file as the retrieval-gate helpers or fold into `index.rs`.
- `DEFAULT_RANK_K` and the rank plumbing go away; update the `mod.rs` doc-comment (it cites the 85%/0FP result of the *old* design).
- Feed the retrieval index to 0.6's prompt cap (inject only terms retrieved against the transcript when the LLM path is active — makes the LLM path scale with dictionary size too).

**Phase 1 gates:** everything in Phase 0's list + the new Python eval green at chosen thresholds + a manual smoke: LLM OFF, encoder ON, dictionary of ~50 real terms + your 9, dictate the known-bad utterances.

---

## 4. Phase 2 (deferred) — Decode-time hotword boosting, transducer families only

Prevent the error instead of repairing it. **Honest cost note:** WinSTT's transducer decode is greedy per-frame (`stt/families/transducer.rs::decode_frame_nemo/_kaldi`); hotword boosting requires **modified beam search** — sherpa-onnx proved the recipe on Parakeet TDT (PR k2-fsa/sherpa-onnx#3077, merged 2026-02) with an Aho-Corasick `ContextGraph` adding/retracting boosts along matching prefixes.

- Scope: Parakeet/Nemotron (RNNT/TDT) only. No practical decode-time equivalent for Whisper/Cohere/Canary (AED) — Whisper prompt biasing is known-poisonous here (`project_context_prompt_poisons_whisper`); post-hoc (Phase 1) remains their only path.
- Work: (a) implement modified_beam_search for the transducer step loop (beam 4), (b) port `ContextGraph` semantics (boost score per token, retract on match death, per-term score syntax), (c) build the context graph from dictionary terms tokenized with the model's BPE vocab, (d) bench: beam is 2–5× slower than greedy — gate behind a setting (default off, or auto-on only when the dictionary is non-empty and the machine is fast).
- **Do this only after Phase 1 ships and if term-recall on transducer models is still unsatisfying** — Phase 1 alone may be enough, and beam-search cost applies to every utterance.

## 5. Phase 3 (later, optional) — SpellMapper for English
- `bene-ges/spellmapper_asr_customization_en` (TinyBERT 6L, 67M ≈ 70 MB int8; CC-BY-4.0): retrieval + correction in one non-autoregressive pass; ONNX export is routine (vanilla BERT token-classification) but not published. English-only; known precision weakness (77–87%) → would still sit behind Phase 1's phonetic gate.
- Adopt only if Phase 1's English precision/recall plateaus below target. An Arabic twin = synthetic-data retraining project (TTS→ASR→alignment pipeline per arXiv:2309.17267) — out of scope until demand exists.

---

## 6. Suggested execution order

| Step | Item | Size | Ship independently |
|---|---|---|---|
| 1 | 0.1 decouple pairs from encoder toggle | XS | yes |
| 2 | 0.3 post-LLM safety net + honest fix count | S | yes |
| 3 | 0.2 replacement column UI (+i18n ×20) | M | yes |
| 4 | 0.4 case restoration | S | yes |
| 5 | 0.5 remove orphaned setting | XS | yes |
| 6 | 0.6 prompt cap (interim recency version) | S | yes |
| 7 | 1.1–1.4 index + retrieval + margin verifier + eval | L | the core release |
| 8 | 1.5 mmBERT-small evaluation | S | data-driven |
| 9 | 1.6/1.7 Arabic table + cleanup + prompt-cap upgrade | S | with step 7 |
| 10 | Phase 2 beam-search boosting | XL | only if needed |

## 7. Risks & mitigations
- **Threshold calibration on synthetic data doesn't transfer to real dictation** → include a set of the user's real utterances in the eval; keep `τ_margin` overridable via env var (`WINSTT_DICT_MARGIN`) for field tuning before exposing any setting.
- **PLL cost for multi-token terms** (e.g., "Kubernetes" = several tokens) → rows scale with token count, bounded by K=10 candidates; measured in 1.4 before ship; 2 s timeout stays as the backstop.
- **Index staleness** on dictionary edit mid-session → rebuild on the settings hot-swap hook (hot-swap keys pattern, not startup-only).
- **mmBERT-small regression** → decision gated on the stress eval; base remains available.
- **Rust test env** — native-DLL-loading tests can't run under `cargo test` (known gotcha); algorithm validation lives in the Python harnesses + in-app smoke, as before.
