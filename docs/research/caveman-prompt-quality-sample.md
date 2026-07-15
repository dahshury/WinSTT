# Caveman prompt compression experiment

Generated: 2026-07-14T23:50:36.944Z
Model: `gemma4:e4b` via local Ollama; temperature 0; JSON schema output; 1 paired trial(s) per case.
Coverage: 12 modifier profiles, 12 paired cases. Current and Caveman order was counterbalanced; warm-up excluded.

## Overall

| Metric | Current | Caveman ultra | Change |
| --- | ---: | ---: | ---: |
| Prompt characters | 15345 | 3640 | -76.3% |
| Ollama prompt tokens | 3242 | 752 | -76.8% |
| Prompt evaluation | 683 ms | 173 ms | -74.7% |
| Generation | 1841 ms | 1923 ms | 4.5% |
| Total model time | 2524 ms | 2096 ms | -17.0% |
| End-to-end wall time | 3299 ms | 2693 ms | -18.4% |
| Composite quality | 93.8 | 94.2 | 0.4 points |
| Style | 88.6 | 88.8 | 0.2 points |
| Accuracy | 98.9 | 99.6 | 0.7 points |
| Guard pass | 100.0% | 100.0% | 0.0 points |
| Capability checks | 0.0% | 0.0% | 0.0 points |

## By modifier

| Modifier | Prompt tokens | Model time | Quality | Guard | Capability |
| --- | ---: | ---: | ---: | ---: | ---: |
| neutral | 2896 / 684 (-76%) | 2720 / 2126 ms (-22%) | 97.8 / 97.0 (-0.8) | 100% / 100% | n/a / n/a |
| formal | 3091 / 722 (-77%) | 2513 / 2072 ms (-18%) | 96.3 / 97.5 (1.3) | 100% / 100% | n/a / n/a |
| friendly | 3091 / 715 (-77%) | 2391 / 1981 ms (-17%) | 97.0 / 97.5 (0.5) | 100% / 100% | n/a / n/a |
| friendly-concise | 3182 / 761 (-76%) | 2202 / 1356 ms (-38%) | 97.5 / 97.0 (-0.5) | 100% / 100% | n/a / n/a |
| technical | 3111 / 748 (-76%) | 2141 / 1830 ms (-15%) | 97.5 / 97.5 (0.0) | 100% / 100% | n/a / n/a |
| concise | 3097 / 723 (-77%) | 2199 / 2404 ms (9%) | 97.5 / 97.5 (0.0) | 100% / 100% | n/a / n/a |
| summarize | 3100 / 720 (-77%) | 2080 / 1955 ms (-6%) | 97.0 / 97.5 (0.5) | 100% / 100% | n/a / n/a |
| reorder | 3193 / 735 (-77%) | 2585 / 2279 ms (-12%) | 97.0 / 97.5 (0.5) | 100% / 100% | n/a / n/a |
| restructure | 3650 / 811 (-78%) | 2614 / 2086 ms (-20%) | 63.8 / 60.0 (-3.8) | 100% / 100% | n/a / n/a |
| rewordForClarity | 3236 / 748 (-77%) | 2456 / 2221 ms (-10%) | 97.5 / 97.5 (0.0) | 100% / 100% | n/a / n/a |
| translate | 3381 / 782 (-77%) | 3546 / 2467 ms (-30%) | 98.8 / 98.8 (0.0) | 100% / 100% | n/a / n/a |
| default-stack | 3880 / 870 (-78%) | 2839 / 2372 ms (-16%) | 87.5 / 95.0 (7.5) | 100% / 100% | n/a / n/a |

## Method and limits

The experiment reuses WinSTT's existing corpus, capability checks, output normalizer, deterministic guards, semantic/surface metrics, and judge rubric. Ollama's `prompt_eval_count`, `prompt_eval_duration`, and `eval_duration` provide token and model-time measurements. Prompt variants run as adjacent pairs with alternating order.

Gemma judges Gemma here because the requested local installation has no independent judge model of comparable strength. This is useful for paired direction, not an absolute quality certificate. Production conversion should require no material deterministic capability regression and a targeted repeat on any weak modifiers.

Raw records: `tools/out/caveman-prompt-quality-sample.json`.
