# LLM modifier benchmark

`tools/llm-modifier-benchmark.ts` grades how well a model performs the
post-processing **modifiers** (tone/register + operations) and abides by the
repository's prompts. It answers two questions the older
`llm-postprocess-regression.ts` scoreboard could not: *how much* a model changed
the text, and *how well* it achieved the requested style.

Run it:

```
bun run bench:modifiers --runners=gemma4:e4b,lfm2.5-thinking:1.2b-q8_0 \
  --modifiers=formal,friendly,concise,restructure,translate \
  --corpus-limit=2 --embed-model=nomic-embed-text --judge-model=gemma4:e4b
```

Outputs `tools/out/llm-modifier-benchmark.json` and a self-contained
`…benchmark.html` with bespoke-SVG charts (heatmap, style/accuracy/speed bars,
magnitude scatter).

## Why the design is layered (not just an LLM judge)

Grading a non-deterministic rewrite is a judgement task, but a pure LLM-judge
score is noisy and rewards confident garbage. So the judge is the **top** layer,
gated by cheaper deterministic layers underneath, cheapest-and-hardest-to-fake
first:

| Layer | What | Deterministic? |
| --- | --- | --- |
| **Guards** | non-empty, no reasoning/preamble leak, no injected markdown, length sanity, literal (URL/email/path/domain) preservation | yes |
| **Magnitude** | surface Δ (word-level Levenshtein) + semantic Δ (`1 − cos(embed(before), embed(after))`) → a 2-D "how much changed" signal | yes |
| **Adherence** | per-modifier capability checks (regex/substring) reused from the scoreboard | yes |
| **Style / quality** | LLM judge rubric: `style_match`, `meaning_preservation`, `fidelity`, `fluency`, `degree`, rationale-before-scores | no |

The composite = `0.5·style + 0.5·accuracy`, scaled by the guard pass-rate.
Speed is reported separately (it is an independent axis, not a quality score).

The 2-D magnitude is the diagnostic that separates good change from bad:

- high surface Δ + low semantic Δ → **clean restyle** (what a tone modifier should do)
- low both → **no-op** (model ignored the modifier)
- high semantic Δ → **meaning drift** (bad, except `translate`)

## Providers

Both the runner and the judge are provider-selectable and independent:

- `--runner-provider=ollama|openrouter` (default `ollama`)
- `--judge-provider=ollama|openrouter` (default = runner provider), `--no-judge`
- Cloud needs `OPENROUTER_API_KEY` (or `--openrouter-key=`).

**Use a strong, independent cloud judge for calibrated numbers.** A small local
judge is fine for wiring the pipeline but is over-generous and cannot judge a
model larger than itself; the report prints a warning when the judge model is
also under test (self-preference bias). Calibrate any judge by hand-labelling
~30–50 outputs and keeping only the axes where it agrees with you.

## Faithfulness notes

- Runner output is passed through the same layout normalizer the app uses
  (`explode_inline_lists`) and the same `<think>…</think>` stripper
  (`answer.rs` → `stripInlineThinking`), so scores reflect what the app pastes.
- Semantic Δ needs an embedding model. Ollama must expose embeddings
  (`ollama pull nomic-embed-text`); without one, semantic Δ degrades to null and
  the scatter is omitted (surface Δ still reported). `--no-embed` disables it.
- The runner is called sequentially so speed numbers (tokens/sec from Ollama
  `eval_count`/`eval_duration`, or OpenRouter `usage`) stay comparable.

## Flags

`--runners=a,b` · `--modifiers=formal,…|all` · `--corpus-limit=N` ·
`--trials=N` · `--no-capability` · `--no-judge` · `--no-embed` ·
`--judge-model=` · `--embed-model=` · `--out=dir`.

Modifier ids are the capability-gap profile ids in
`tools/lib/postprocess/corpus.ts` (`neutral`, `formal`, `friendly`,
`friendly-concise`, `technical`, `concise`, `summarize`, `reorder`,
`restructure`, `rewordForClarity`, `translate`, `default-stack`).

## Shared library

`tools/lib/postprocess/` holds the pieces (corpus, prompts, normalize, clients,
metrics, judge, report, types). The prompt/normalizer copies mirror the Rust
runtime — keep them in sync with `src-tauri/src/winstt/llm/`.
