# Post-processing prompt optimization handoff

## Newline / enumeration fix + OpenRouter harness (2026-06-10, later pass)

Problem: enumerated items ("1. … 2. … 3. …", bullets) were pasting on a single row instead of with real line breaks. Two independent causes, both fixed:

1. **Model emits the list inline.** Small/cheap models (gemma4:e2b, gemini-3.1-flash-lite) unreliably embed `\n` inside the JSON `text` value even when the prompt demands it — they often collapse a list onto one line. Fixed with a deterministic, universal LAYOUT normalizer `explode_inline_lists` (`src-tauri/src/winstt/llm/normalize.rs`): when a single line carries ≥2 inline markers (ascending `1. 2. 3.` / `1) 2)`, or ≥2 `* `/`- ` bullets) it breaks each item onto its own real line, with a blank line after a `:` lead-in. It ONLY acts on lines that already have ≥2 inline markers, so correct multi-line lists and non-list prose pass through untouched. Wired into `normalize_llm_text_output` (dictation path) AND the transform path in `commands/llm.rs`. Mirrored in the harness `normalize` (TS port `explodeInlineLists`) so `--review` shows what the app actually pastes. This is LAYOUT only — never changes wording/casing/meaning (unlike the earlier reverted semantic normalizer, which is still off-limits). Rust + TS unit tests cover it.
2. **`PasteMethod::Direct` dropped newlines.** The Windows Direct paste injects text via `KEYEVENTF_UNICODE`; a bare `\n` arrives as a WM_CHAR line-feed that most edit controls/browsers ignore. Fixed in `input.rs`: `paste_text_unicode` now splits on newlines (pure, tested `split_paste_ops`) and injects a real **Enter (VK_RETURN)** keystroke per line break, folding `\r\n`/`\r` to one. (The default Windows paste method is `CtrlV`/clipboard, which already preserved `\n`; this fixes the Direct + streaming paths.)

Harness now supports **OpenRouter** alongside Ollama: `PROVIDER=openrouter OPENROUTER_API_KEY=… [OPENROUTER_MODEL=google/gemini-3.1-flash-lite] bun tools/llm-postprocess-regression.ts --review`. It uses `/api/v1/chat/completions` with `response_format: json_schema`, and `extractText` tolerates fenced/plain responses so one stray reply doesn't abort the run.

gemini-3.1-flash-lite results: every enumeration now renders with real newlines (the exploder guarantees it on both models). gemini tends to OVER-structure (turns some casual mid-sentence phrases / grouped questions into lists); a prompt tightening to curb this was tried and REVERTED because it regressed gemma's listing of "especially"/inventory cases without fixing gemini's worst cases — the exploder is the model-agnostic fix, and over-structuring degrades to clean readable output. Only a minimal, safe clause was kept ("keep questions as prose, even several in a row").

## Current state (2026-06-10)

The prompts, tones, and modifiers were rewritten from scratch to be fully general. Every case-specific rule that earlier iterations had copied from individual regression dictations ("then first problem", `select auto`, "TokenLens", "table columns tab", "for less", product-name lists, compound-word lists, contrast-sentence phrases, …) was deleted and replaced by the general principle it instantiated, plus at most one short synthetic example. The composed system prompt shrank from ~13k to ~8k chars. Tests now guard *against* overfit (a denylist of previously-leaked case phrases) instead of asserting it.

## Architecture findings that drove the design (verified by A/B spikes on gemma4:e2b)

1. **Preservation wording must mean "don't delete", never "don't edit".** Phrasing like "preserve wording and order" makes the small model return input nearly verbatim (no punctuation fixes at all). Current phrasing: preservation never means leaving errors unfixed.
2. **The base keeps prose as prose; all list-making lives in `restructure`.** The compose layer explicitly states active operations are mandatory and override the keep-prose-as-prose default — without that sentence the small model never restructures.
3. **Position beats wording.** The same bullet-conversion example that is ignored in the system prompt is reliably applied when placed as a compact demo near the end of the USER prompt. The runtime user prompt (`active_modifier_user_prompt` in prompts.rs) therefore appends three synthetic pattern demos when Restructure is active: action chain → bullets, label-value mapping → bullets, spoken ordinal steps drifting into a problem report → numbered list + prose. Named-section composition (tested) was WORSE than the dash-bullet composition; do not switch.
4. **A completeness clause in the final check ("no sentence, item, or action from the input is missing") fixed dropped list items.**

## gemma4:e2b behavior after the rewrite (semantic parity or better vs the old overfit prompts)

Works reliably: announced-count enumerations → numbered lists; ordinal test steps on own lines with the trailing problem report split out as prose; "You should A, B, C" action chains → bullets (all items kept); label/value/error quoting; trailing-fragment preservation; unchanged output for already-clean input; numbers/percent/math conversion.

Known model-ceiling misses (also failed with the old overfit prompts): inline label-value mappings ("blue for X, yellow for Y") and dense unpunctuated inventories usually stay as (clean) prose instead of bullets; quoted visible labels sometimes keep lowercase ("drag" not "Drag"); the "two ways. Either…or…" case is flaky run-to-run; occasional wrong-word repairs are skipped (adopt→adapt). These degrade gracefully to clean prose — do NOT chase them with case-specific rules.

## Main files

- `src/shared/lib/preset-prompts.ts` + `src/shared/lib/preset-prompts.test.ts`: Tauri prompt definitions/compose + generalization-guard tests.
- `src-tauri/src/winstt/llm/prompts.rs`: Rust runtime mirror (system prompts AND the runtime user prompts, including the pattern demos and the restructure-gated final check).
- `examples/winstt-electron/frontend/src/shared/lib/preset-prompts.ts` (+ test): Electron reference copy, synced.
- `tools/llm-postprocess-regression.ts`: semantic-review harness; its user prompt mirrors `active_modifier_user_prompt` — keep them in sync.

## How to iterate

- `bun tools/llm-postprocess-regression.ts --review` (full) or `--review --ids=a,b,c` (subset); judge semantically, not by string equality.
- `bun test ./src/shared/lib/preset-prompts.test.ts` and the Electron twin after prompt edits; `bun run typecheck`.
- Rust: `cmd //c "tools\windows\cargo-env.bat check --no-default-features"`.
- When a regression case fails: generalize the failure into a principle or a synthetic demo; never quote the case's own words in a prompt. If a rule helps only one case, it does not belong.

## Constraints to preserve

- No git stash. Do not commit or push unless asked.
- Prompts stay ultra-general; the regression cases are semantic vibes, not exact strings.
- Small-model first: fewer, more salient rules beat many micro-rules; demos go in the user prompt, not the system prompt.

## Unrelated repo note (2026-06-10)

`src-tauri/src/winstt/commands/runtime.rs` was found committed as all NUL bytes (corrupted in commit f3d6cd91) and was restored from bdb0390a. The WIP between those commits is lost; `quant_download_size_bytes` in catalog_data.rs is now dead code (clippy -D warnings will flag it). A follow-up task chip was filed.
