# Caveman prompt compression for WinSTT

## Decision

Yes: Caveman-style prompt compression can reduce WinSTT's prompt size dramatically and reduce Gemma 4 E4B inference time without a measured aggregate quality loss.

It does **not** reduce total run time by the same percentage as prompt size. In the broad paired matrix, prompt tokens fell **77.6%**, but total model time fell **7.2%** because compressed prompts produced **14.2% more output tokens**. In the smaller judged validation sample, total model time fell **17.0%** and end-to-end wall time fell **18.4%** while aggregate quality was effectively tied/slightly higher.

The original recommendation was a guarded/model-specific rollout because the sample was small. The user subsequently chose full production rollout. WinSTT now uses the compact v2 contract for every model tier, with a separate `Concise → Caveman` output level.

## What was integrated

The upstream Caveman skill from `juliusbrussee/caveman` was copied into WinSTT at `.agents/skills/caveman/` with its MIT license. Source revision: `0d95a81d35a9f2d123a5e9430d1cfc43d55f1bb0` (2026-07-15 checkout).

The copied skill is unchanged except for a final newline. The validated v2 prompt is now the production implementation in `src/shared/lib/preset-prompts.ts` and `src-tauri/src/winstt/llm/prompts.rs`; the experiment wrapper delegates to those production builders.

## Experimental design

- Model: local Ollama `gemma4:e4b`, already installed; 16,384 context, temperature 0, thinking disabled, JSON-schema output.
- Variants: current WinSTT composed system + user prompt versus a Caveman-ultra semantic rewrite of the complete cleanup/tone/modifier contract.
- Order: adjacent current/compressed pairs with alternating order; one warm-up call excluded.
- Broad matrix: 57 paired cells (114 successful outputs), covering all 12 profiles, three historical corpus items per profile, generic cleanup capabilities under neutral, and modifier-specific capability cases under their declared profiles.
- Judged validation: one shared historical corpus item under all 12 profiles (12 pairs), scored blind to prompt variant with the existing WinSTT judge rubric.
- Reused infrastructure: existing corpus, capability checks, output normalizer, guard checks, prompt tests, judge rubric, and Ollama internal token/timing fields.
- Metrics: `prompt_eval_count`, `prompt_eval_duration`, `eval_count`, `eval_duration`, wall time, deterministic guard pass, capability adherence, and judge style/meaning/fidelity/fluency/degree.
- Semantic embeddings were omitted because the installed `gemma4:e4b` returns HTTP 501 for Ollama `/api/embed`, and the prior experiment's `nomic-embed-text` model is no longer installed. Surface and deterministic metrics remained available.

## Results

### Broad capability and timing matrix

| Metric | Current | Caveman v2 | Change |
| --- | ---: | ---: | ---: |
| Prompt characters | 15,225 | 3,484 | **−77.1%** |
| Ollama prompt tokens | 3,221 | 722 | **−77.6%** |
| Prompt evaluation | 351 ms | 139 ms | **−60.4%** |
| Generated tokens | 157 | 179 | **+14.2%** |
| Generation time | 1,391 ms | 1,567 ms | **+12.7%** |
| Total model time | 1,841 ms | 1,709 ms | **−7.2%** |
| End-to-end wall time | 4,696 ms | 3,725 ms | **−20.7%** |
| Deterministic guard pass | 98.4% | 98.4% | tied |
| Applicable capability checks | 100% | 100% | tied |
| Request errors | 0/57 | 0/57 | tied |

The four guard failures were identical in both variants: the bare-email test correctly returned only `support@example.com`, but the generic length-sanity guard marked the intentional 0.20 output/input ratio as too short. This is a known guard false positive, not a prompt regression.

### Frozen judged validation

| Metric | Current | Caveman v2 | Change |
| --- | ---: | ---: | ---: |
| Prompt tokens | 3,242 | 752 | **−76.8%** |
| Prompt evaluation | 683 ms | 173 ms | **−74.7%** |
| Generated tokens | 180 | 193 | +7.7% |
| Generation time | 1,841 ms | 1,923 ms | +4.5% |
| Total model time | 2,524 ms | 2,096 ms | **−17.0%** |
| End-to-end wall time | 3,299 ms | 2,693 ms | **−18.4%** |
| Style | 88.6 | 88.8 | +0.2 points |
| Accuracy | 98.9 | 99.6 | +0.7 points |
| Composite quality | 93.8 | 94.2 | +0.4 points |
| Guard pass | 100% | 100% | tied |

### Judged result by profile

The first quality value is current; the second is Caveman v2. Model-time change is Caveman relative to current.

| Profile | Quality | Difference | Model time |
| --- | ---: | ---: | ---: |
| neutral | 97.8 / 97.0 | −0.8 | −21.8% |
| formal | 96.3 / 97.5 | +1.3 | −17.5% |
| friendly | 97.0 / 97.5 | +0.5 | −17.1% |
| friendly-concise | 97.5 / 97.0 | −0.5 | −38.4% |
| technical | 97.5 / 97.5 | tied | −14.5% |
| concise | 97.5 / 97.5 | tied | **+9.3%** |
| summarize | 97.0 / 97.5 | +0.5 | −6.0% |
| reorder | 97.0 / 97.5 | +0.5 | −11.8% |
| restructure | 63.8 / 60.0 | −3.8 | −20.2% |
| reword for clarity | 97.5 / 97.5 | tied | −9.5% |
| translate | 98.8 / 98.8 | tied | −30.4% |
| default stack | 87.5 / 95.0 | +7.5 | −16.4% |

## Optimization history

The first ultra-compressed smoke prompt cut neutral prompt tokens from about 2,720 to 441 but missed UI-label quoting, literal CLI flags, adjacent field corrections, and compact `vN` labels. Four tiny synthetic demonstrations near the input restored all neutral capability checks while keeping the prompt near 500 tokens.

The first judged all-profile pass then exposed a critical translation failure: Caveman output remained English and scored 50 versus 99 current. It also under-applied technical and friendly-concise style. Moving only the decisive active-operation reminders immediately before the input fixed translation to 99, restored friendly-concise, tied technical, and improved the default stack. This agrees with the prior WinSTT handoff finding that instruction position and compact demonstrations matter more than adding system-prompt prose for small local models.

`restructure` remains a shared Gemma ceiling on the historical “two ways” case: current scored 63.8 and Caveman 60.0, while both variants passed the dedicated announced-enumeration capability case. The earlier handoff already identified this case as flaky and warned against case-specific prompt growth.

## Production rollout

1. All system, user, context, vocabulary, snippet, translation, tone, and modifier prompts now use compact v2 wording in both TypeScript and Rust.
2. `Concise` exposes a fourth `Caveman` level. It compresses output prose, permits clear fragments, and preserves technical literals byte-for-byte after spoken-form conversion. `Summarize` and custom modifiers remain limited to Light/Medium/High.
3. A live production-builder smoke test on `gemma4:e4b` reduced output from 44 tokens at Concise High to 33 tokens at Caveman (−25%). The first draft exposed an unsafe Windows-path substitution; a hard literal guard fixed it, and the repeated output preserved `C:\temp\logs` and `--force` exactly.
4. The broad timing/quality results above remain the rollout evidence. The new Caveman output level is deliberately stronger than the Caveman prompt-input format and should be monitored separately for overly terse or ambiguous output.

## Artifacts

- Broad raw matrix: `tools/out/caveman-prompt-experiment.json`
- Frozen judged sample: `tools/out/caveman-prompt-quality-sample.json`
- Generated broad report: `docs/research/caveman-prompt-experiment.md`
- Generated judged report: `docs/research/caveman-prompt-quality-sample.md`
- Experiment runner: `tools/caveman-prompt-experiment.ts`
- Compressed prompt builder: `tools/lib/postprocess/caveman-prompts.ts`
- Prompt invariants: `tools/lib/postprocess/caveman-prompts.test.ts`

## Limitations

- One frozen judged sample per profile is enough to detect large failures, not enough for a production confidence interval.
- Gemma judged Gemma because no independent local judge of comparable strength is installed. The judge was blind to variant identity, but self-preference/calibration bias remains possible.
- Ollama load and local machine contention add wall-time variance. Model-reported prompt/generation durations are more diagnostic than wall time; pair order was counterbalanced to reduce systematic bias.
- The experiment measures post-processing prompts only. It does not imply the same quality/latency curve for unrelated WinSTT LLM prompts or other models.
