# Post-processing prompt optimization handoff

## Current objective

Tune WinSTT LLM post-processing so dictated developer/task text is cleaned into concise written form with reliable punctuation, numbers/math, UI label quoting, and structure. The user wants all tone and modifier prompts to remain ultra-general. Do not add case-specific exact-output rules.

## Important user preference

The regression cases are semantic review targets, not exact string comparisons. Model output can vary across models. Judge whether the output achieves the intended transformation vibe: cleaned dictation, correct punctuation, useful lists where warranted, preserved speaker intent, and no over-summarization.

## Main files

- `src/shared/lib/preset-prompts.ts`: primary frontend prompt definitions and `buildSystemPrompt`.
- `examples/winstt-electron/frontend/src/shared/lib/preset-prompts.ts`: Electron reference copy of the prompt definitions.
- `src-tauri/src/winstt/llm/prompts.rs`: Rust runtime prompt definitions and runtime user prompts.
- `src-tauri/src/winstt/llm/ollama_request.rs`: Ollama request options. `num_ctx` was raised to 16384 earlier.
- `src-tauri/src/winstt/commands/llm.rs`: runtime command path. It currently only trims trailing spaces from LLM output before replacement pairs.
- `src-tauri/src/winstt/commands/transforms.rs`: transform command path. It currently only trims trailing spaces from LLM output before replacement pairs/output.
- `tools/llm-postprocess-regression.ts`: local Gemma/Ollama semantic review harness with all examples from the conversation.
- `src/shared/lib/preset-prompts.test.ts`: prompt shape/generalization tests for the Tauri app.
- `examples/winstt-electron/frontend/src/shared/lib/preset-prompts.test.ts`: reference prompt tests.

## What was done before this handoff

- Added universal base cleanup guidance for numbers, percentages, and math expressions.
- Strengthened `restructure` for counted alternatives, scenario lists, inventories, action chains, mappings, and rule chains.
- Strengthened `rewordForClarity` for obvious ASR/wrong-word corrections such as `adopt to` -> `adapt to`, quote handling, compounds, and preserving incomplete trailing fragments.
- Changed high `concise` to preserve structure and wording rather than summarizing or flattening lists.
- Added a semantic-review mode to `tools/llm-postprocess-regression.ts` via `--review`.
- Synced prompt changes across Tauri frontend, Electron reference frontend, and Rust prompt source.
- Kept tests that guard against exact-output overfit.

## What was tried and reversed

A deterministic normalizer was briefly added for mechanical output fixes, then reversed at the user request. If deterministic cleanup is revisited, keep it genuinely universal and remove corresponding instructions from the prompt at the same time. The reversed idea included common numeric replacements, label quoting, and punctuation tweaks. It should not be reintroduced as a broad case-specific map.

## Current model behavior notes

Using `OLLAMA_MODEL=gemma4:e2b` with `tools/llm-postprocess-regression.ts --review`, some cases still miss target transformations:

- Counted alternatives: sometimes makes a list but item boundaries are imperfect.
- Problem-report split: `Third ... then first problem ...` often stays inside item 3.
- UI labels: `says drag` or `called auto` may be quoted but lowercased or left bare.
- Feature-definition preservation: sentences before `I want` can still be dropped.
- Mapping bullets: color/status mappings often remain inline.
- Some punctuation repairs are inconsistent: semicolon vs period, embedded wh-question splits, and contrast sentence cleanup.

## Recommended next path

1. Keep prompt rules general. Do not mention specific app examples like recording colors, fallback model, or exact phrases as special cases.
2. Consider deterministic post-LLM cleanup only for rules that can be implemented safely without semantic judgment. Good candidates are trailing whitespace cleanup, explicit `says/called/named/labeled` label quoting, simple spoken math/percentage conversion with exact phrase matches, and final punctuation for simple imperatives.
3. Keep semantic structure in the model prompt unless a transformation can be proven pattern-safe.
4. Use `bun tools/llm-postprocess-regression.ts --review --ids=<case ids>` for fast semantic samples before full review.
5. Run prompt tests after prompt edits:
   - `bun test ./src/shared/lib/preset-prompts.test.ts`
   - `bun test ./examples/winstt-electron/frontend/src/shared/lib/preset-prompts.test.ts`

## Constraints to preserve

- Do not use git stash.
- Do not commit or push unless the user asks.
- Keep prompts ultra-general and avoid exact-output overfit.
- The user's examples are regression guides, not strings to match exactly.
