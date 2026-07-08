# Model Modifier Benchmark (standalone tool)

An interactive, browser-based tool to benchmark how well LLMs perform the
post-processing **modifiers** (tones + operations). It **reuses the app's own
components** (the Ollama/OpenRouter model pickers, the reasoning-effort switcher,
the password field, the Sparkline chart) and the app's prompt composition, but
is a **separate dev tool — it is not shipped with the app binary**.

## Run it

```
bun run bench:tool          # → http://localhost:5273
```

Then, in the page:

1. Pick **runner models** (Ollama and/or OpenRouter) — the same pickers the app
   uses — and click **Add runner**.
2. Choose **thinking effort**, a **judge** model, an **embedding** model (for the
   semantic-Δ scatter), the **modifiers**, corpus size and trials.
3. For cloud models, paste an **OpenRouter API key** (stored only in your
   browser's localStorage; it's the same `llm.openrouterApiKey` the app uses).
4. **Run benchmark**. Results stream in live across the view tabs.

## What it measures (layered — judge on top of deterministic checks)

- **Guards** (deterministic): no reasoning/preamble leak, no injected markdown,
  length sanity, literal (URL/email/path) preservation.
- **Magnitude** (deterministic, 2-D): surface Δ (word-level edit distance) and
  semantic Δ (`1 − cos` of embeddings). Clean restyle = high surface / low
  semantic; no-op = low both; meaning drift = high semantic.
- **Adherence** (deterministic): per-modifier capability checks.
- **Style / accuracy** (LLM judge): a rubric — style_match, meaning, fidelity,
  fluency, degree — gated by the guards.
- **Speed**: tokens/sec + latency, from actual run timing.

Views: Overview (composite heatmap), Style / Accuracy / Speed (grouped bars),
Magnitude (scatter), Rubric (radar of the 5 judge axes), Samples (raw outputs),
History (cross-run trend + list).

## Persistence

Every run is appended to `tools/out/benchmark-runs.json` via a small
Vite dev-server middleware (`GET/POST/DELETE /api/benchmark-runs`). The History
tab reads it back, so results accumulate across sessions. That directory is
git-ignored.

## How it reuses the app without Tauri

- `@` resolves to `../../src`; `@tauri-apps/api/*` is aliased to `tauri-stub.ts`
  so app components that transitively import Tauri still mount in a plain browser.
- The runner talks to Ollama/OpenRouter directly over `fetch` (both are on the
  app's CSP allow-list, and this tool has no CSP anyway). It reuses
  `buildSystemPrompt` and the shared engine in `tools/lib/postprocess/*`
  (metrics, judge, prompts, normalize incl. the `<think>` stripper, corpus).
- Semantic Δ needs an Ollama embedding model — `ollama pull nomic-embed-text`.

## Faithfulness note

Because it runs outside Tauri it composes the **user** prompt with the TS mirror
(`buildUserPromptForPresets`), not the Rust `active_modifier_user_prompt`. The
system prompt, layout normalizer and thinking-stripper are the shared/mirrored
implementations, so output tracks the app closely but is not byte-identical to
the shipped Rust pipeline. Use a strong, independent **cloud judge** for
calibrated style numbers; a small local judge is over-generous.
