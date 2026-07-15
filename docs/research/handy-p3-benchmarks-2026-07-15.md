# Handy comparison P3 measurement closure

Date: 2026-07-15 (Africa/Cairo)  
Machine: Windows x64, Node v22.20.0

This closes the Handy comparison's “benchmark, do not blindly adopt” recommendations with
reproducible, local-only harnesses. No production audio feed, download default, runtime delivery,
or feature split was changed without evidence.

## Native startup warmup A/B

Harness: `tools/perf/benchmark-native-startup.ps1`

The runner alternates `WINSTT_STT_WARMUP_POLICY=eager` and `renderer-ready`, discards configured
warmup runs, and reads WinSTT's native absolute startup markers:

- main renderer painted;
- main renderer bootstrap ready;
- STT boot/warmup complete;
- reveal dispatched (first usable).

It requires a current portable package with a returning-user `Data` profile and selected local
model. It rejects onboarding launches because those deliberately skip STT warmup. The final run
used the freshly built and audited portable package, alternated five pairs, discarded pair zero as
warmup, and retained four valid measured runs per policy.

| Policy | Paint median / p75 | Renderer-ready median / p75 | First usable median / p75 | STT warm median / p75 |
|---|---:|---:|---:|---:|
| Eager | 511 / 531 ms | 583 / 595 ms | 595 / 599 ms | 2,561 / 2,609 ms |
| Renderer-ready | 552 / 557 ms | 617 / 620 ms | 617 / 624 ms | 2,592 / 2,741 ms |

Decision: make `eager` the default and retain `renderer-ready` as the explicit A/B override. Eager
was 41 ms faster to paint, 34 ms faster to renderer-ready, 22 ms faster to first usable, and 31 ms
faster to a warm STT engine at the median. It also improved every reported p75. On this packaged
build, deferring the warmup did not reduce renderer contention; it delayed both UI and dictation
readiness.

Run:

```powershell
bun run bench:startup-native -- -Runs 5 -Warmup 1 -Json -Output artifacts/perf/native-startup.json
```

## Recorder mirror versus bounded direct feed

Harness: `tools/perf/benchmark-recorder-feed.mjs`  
Raw result: `artifacts/perf/recorder-feed-2026-07-15.json`

The fixture sends 30,000 10 ms / 160-sample frames through the current mirror-tail shape and a
64-frame preallocated direct ring. It measures callback work, process CPU, copy volume, bounded
memory, drops, and ordered sample parity under fast, paced, and slow consumers.

| Scenario | Path | Callback p95 | CPU | Copies | Peak buffer | Drops | Parity |
|---|---|---:|---:|---:|---:|---:|---|
| Fast consumer | Mirror | 0.3 µs | 47 ms | 36.621 MiB | 18.311 MiB | 0 | pass |
| Fast consumer | Direct ring | 0.1 µs | 16 ms | 18.311 MiB | 0.001 MiB | 0 | pass |
| Paced consumer | Mirror | 0.2 µs | 15 ms | 36.621 MiB | 18.311 MiB | 0 | pass |
| Paced consumer | Direct ring | 0.1 µs | 16 ms | 18.311 MiB | 0.002 MiB | 0 | pass |
| Slow consumer | Mirror | 0.3 µs | 46 ms | 36.621 MiB | 18.311 MiB | 0 | pass |
| Slow consumer | Direct ring | 0.1 µs | 31 ms | 4.615 MiB | 0.039 MiB | 22,438 | **fail** |

Decision: keep the production mirror. The direct ring is cheaper when the consumer keeps up, but
under backpressure it preserved only 7,562 of 30,000 frames. That violates final-transcript parity,
which outweighs the copy and memory savings. A future direct path would need a lossless bounded
handoff or explicit fallback to the batch buffer before it can be promoted.

Run:

```powershell
bun run bench:recorder-feed -- --output artifacts/perf/recorder-feed.json
```

## Download worker width 1 / 2 / 4 / 8

Harness: `tools/perf/benchmark-download-concurrency.mjs`  
Raw result: `artifacts/perf/download-concurrency-2026-07-15.json`

The fixture is a local HTTP server with a shared throttled network and a shared slow sink. Each run
uses an isolated worker process, ten 2 MiB files in 64 KiB chunks, RSS sampling, and a cancellation
storm that aborts five of ten jobs. It performs no external downloads.

| Scenario | Width 1 | Width 2 | Width 4 | Width 8 |
|---|---:|---:|---:|---:|
| Slow shared network, fast sink | 4.00 MiB/s | 4.03 MiB/s | 4.01 MiB/s | 4.04 MiB/s |
| Fast network, slow shared sink | 7.59 MiB/s | 7.56 MiB/s | 7.67 MiB/s | 7.63 MiB/s |
| Cancellation storm | 3.63 MiB/s | 3.77 MiB/s | 3.90 MiB/s | 3.87 MiB/s |
| Peak scheduled concurrency | 1 | 2 | 4 | 8 |

All normal runs completed ten files without errors. Every cancellation run cancelled exactly five
jobs and completed five without errors. Widths 4 and 8 consumed more connections but did not
produce a material throughput improvement under either shared bottleneck.

Decision: keep the production default at two. The pool now accepts the bounded diagnostic override
`WINSTT_DOWNLOAD_WORKERS=1..8`, with invalid values falling back to two, so the same widths can be
tested against real model repositories without changing a build. This is a benchmark control, not a
new user setting.

Run:

```powershell
bun run bench:download-workers -- --output artifacts/perf/download-concurrency.json
```

## Package/runtime and feature split

Harness: `tools/perf/measure-package-components.mjs`  
Detailed result: `docs/research/winstt-package-components-2026-07-15.md`

| Component | Logical size |
|---|---:|
| Main release executable | 64.02 MiB |
| Windows native runtime DLLs | 18.39 MiB |
| Bundled resources | 2.26 MiB |
| Renderer dist | 6.09 MiB |
| Context sidecar | 0.40 MiB |
| Latest NSIS artifact | 27.19 MiB |

Decision:

- Retain app-local Windows runtime delivery. Turning the 18.39 MiB runtime into a first-launch
  download would reduce the initial artifact but break local-first/offline launch and recovery.
- Retain the existing context sidecar; at 0.40 MiB it is already isolated and not a useful size
  target.
- Do not split STT/TTS/LLM into additional executables without symbol-level proof. They share the
  Tauri/Rust/native graph, so more processes risk duplicate linkage, package growth, IPC overhead,
  and lifecycle failure modes.

Run:

```powershell
bun run measure:package-components -- --output-json artifacts/perf/package-components.json
```

## Final architecture decisions

- Eager is the default STT warmup policy based on the packaged native A/B; renderer-ready remains
  available strictly for controlled measurement.
- Keep the lossless mirror-tail recorder route.
- Keep two bounded download workers; retain only the 1–8 benchmark override.
- Keep native runtime files in the installer/portable package.
- Keep the current single app process plus small context sidecar; do not add speculative feature
  sidecars.
