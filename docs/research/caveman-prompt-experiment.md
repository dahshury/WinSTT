# Caveman prompt compression experiment

Generated: 2026-07-14T23:41:00.160Z
Model: `gemma4:e4b` via local Ollama; temperature 0; JSON schema output; 1 paired trial(s) per case.
Coverage: 12 modifier profiles, 57 paired cases. Current and Caveman order was counterbalanced; warm-up excluded.

## Overall

| Metric | Current | Caveman ultra | Change |
| --- | ---: | ---: | ---: |
| Prompt characters | 15225 | 3484 | -77.1% |
| Ollama prompt tokens | 3221 | 722 | -77.6% |
| Prompt evaluation | 351 ms | 139 ms | -60.4% |
| Generation | 1391 ms | 1567 ms | 12.7% |
| Total model time | 1841 ms | 1709 ms | -7.2% |
| End-to-end wall time | 4696 ms | 3725 ms | -20.7% |
| Guard pass | 98.4% | 98.4% | 0.0 points |
| Capability checks | 100.0% | 100.0% | 0.0 points |

## By modifier

| Modifier | Prompt tokens | Model time | Quality | Guard | Capability |
| --- | ---: | ---: | ---: | ---: | ---: |
| neutral | 2726 / 514 (-81%) | 883 / 396 ms (-55%) | not judged | 92% / 92% | 100% / 100% |
| formal | 3097 / 728 (-76%) | 2477 / 2142 ms (-14%) | not judged | 100% / 100% | 100% / 100% |
| friendly | 3103 / 727 (-77%) | 2108 / 2012 ms (-5%) | not judged | 100% / 100% | n/a / n/a |
| friendly-concise | 3188 / 755 (-76%) | 2003 / 1868 ms (-7%) | not judged | 100% / 100% | 100% / 100% |
| technical | 3111 / 724 (-77%) | 2083 / 2138 ms (3%) | not judged | 100% / 100% | 100% / 100% |
| concise | 3109 / 735 (-76%) | 1895 / 2134 ms (13%) | not judged | 100% / 100% | n/a / n/a |
| summarize | 3112 / 732 (-76%) | 1685 / 1885 ms (12%) | not judged | 100% / 100% | n/a / n/a |
| reorder | 3205 / 747 (-77%) | 2192 / 1918 ms (-13%) | not judged | 100% / 100% | n/a / n/a |
| restructure | 3656 / 793 (-78%) | 2070 / 1859 ms (-10%) | not judged | 100% / 100% | 100% / 100% |
| rewordForClarity | 3248 / 760 (-77%) | 1554 / 1846 ms (19%) | not judged | 100% / 100% | n/a / n/a |
| translate | 3393 / 774 (-77%) | 2363 / 1860 ms (-21%) | not judged | 100% / 100% | n/a / n/a |
| default-stack | 3708 / 674 (-82%) | 781 / 455 ms (-42%) | not judged | 89% / 89% | 100% / 100% |

## Method and limits

The experiment reuses WinSTT's existing corpus, capability checks, output normalizer, deterministic guards, semantic/surface metrics, and judge rubric. Ollama's `prompt_eval_count`, `prompt_eval_duration`, and `eval_duration` provide token and model-time measurements. Prompt variants run as adjacent pairs with alternating order.

This broad pass disabled judging so it could cover the full matrix. See `caveman-prompt-quality-sample.md` for the separate frozen Gemma-judged validation.

Raw records: `E:/DL/Projects/WinSTT/tools/out/caveman-prompt-experiment.json`.
