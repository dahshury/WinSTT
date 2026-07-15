# WinSTT vs Handy v0.9.2: Architecture and Performance Research Report

**Research date:** 2026-07-14  
**Handy version:** `ea10f7454e86f893581f5a380a15866476aa6423` (`main`, release v0.9.2)  
**WinSTT basis:** current local working tree over `22bd19fd9ad94a51c3350070c7caa457ce713d69`  
**Research mode:** Deep technical comparison

## Executive Summary

WinSTT should not broadly rebase its architecture onto Handy. The current WinSTT backend is more resilient, its frontend is more modular and better tested, its model downloader is more controllable, and its transcription-to-paste path removes more blocking work from the latency-critical path. Handy is easier to read largely because it has a narrower product surface and far less code. WinSTT's production frontend contains about 118,500 code lines versus Handy's 26,300, while the Rust trees contain about 107,900 and 15,000 code lines respectively. Those counts are complexity indicators, not feature-normalized quality scores [1], [12].

The best Handy ideas are selective and high leverage. First, Handy exposes model selection as one backend-owned command, while WinSTT still coordinates optimistic frontend state, settings persistence, reload behavior, lifecycle events, and cross-window reconciliation. WinSTT should introduce a typed, atomic `stt_switch_model` transaction and revisioned backend settings patches, retaining its stronger load guards and warmup semantics [5], [7], [15], [18], [19]. Second, Handy has a tested 50 ms push-to-talk release-grace classifier that absorbs synthetic release/press bursts; this can be added to WinSTT's already stronger session-aware coordinator [21], [24]. Third, Handy's headless transcription CLI provides the benchmark surface this audit was missing, including file transcription, model/device selection, repeat counts, and JSON output [22], [25].

Fresh frontend builds show a nuanced size result. WinSTT's complete renderer is 6.01 MiB versus Handy's 1.30 MiB, but WinSTT's initial main-window JS+CSS is only 43% larger by a per-file gzip proxy: 0.52 MiB versus 0.36 MiB. WinSTT achieves that through multi-entry splitting, but its tiny main window still reaches 76 JavaScript files and three stylesheets, compared with Handy's two JavaScript files and one stylesheet [9], [17]. Published Windows x64 NSIS installers are 27.63 MiB for WinSTT and 20.00 MiB for Handy; on Linux, however, WinSTT's packages are substantially smaller [11], [26].

**Primary recommendation:** adopt Handy's atomic action boundaries and benchmark tooling, not its flatter stores, monolithic managers, synchronous critical-path work, weaker credential persistence, or unload-first engine lifecycle.

**Confidence:** High for code-flow and size findings; medium for launch-speed conclusions because a controlled native cold-start benchmark was not available.

## Introduction

### Research question

This report compares the latest Handy repository with the current WinSTT working tree in depth: overall architecture, recording and transcription flow, post-processing, model switching, model downloads, frontend and backend organization, package and renderer size, launch behavior, and concrete opportunities WinSTT can adopt.

### Scope and method

The local `examples/Handy` checkout did not exist at the start of the audit. The canonical `cjpais/Handy` repository was cloned there, `git pull --ff-only` reported it was current, and local `HEAD` was independently matched to upstream `main` at `ea10f745`. The checkout is Handy v0.9.2 from July 12, 2026 [1], [11]. No Handy source was edited.

The comparison used source tracing, repository metadata, fresh production renderer builds, Tauri/Cargo/Vite configuration review, published GitHub release assets, and measured local artifacts. WinSTT had a large pre-existing dirty working tree. The audit preserved it and evaluated the live files because they represent the product under development. GitHub links for WinSTT establish repository/source identity, while local line references and build measurements reflect the working tree rather than claiming every change is already published [12].

Native cold launch was not benchmarked. A WinSTT debug process was already running, and Handy had no native build artifact locally; terminating the user's process or performing an uncontrolled first build/run would not produce a fair cold-start comparison. Launch conclusions are therefore divided into observed code-path facts and explicitly labeled inferences. The recommended headless and launch harness closes this evidence gap.

### Key assumptions

1. The current local WinSTT working tree is the relevant comparison target, despite being ahead of its last commit.
2. Package comparisons use like-for-like published artifacts where possible; installer formats are not compared across formats.
3. Per-file gzip is a useful renderer-size proxy, not a Tauri network-transfer measurement, because WebView assets are local.
4. Code size is treated as a maintenance/complexity signal, never as proof that the smaller implementation is better.
5. Recommendations must retain WinSTT's broader feature scope, security controls, model diversity, tests, and multi-window product design.

## Comparison Snapshot

| Area | Handy v0.9.2 | Current WinSTT | Assessment |
|---|---|---|---|
| Backend boundary | Concrete managers and a hard-coded loaded-engine enum | Trait-based STT backend plus separated core and WinSTT managers | WinSTT stronger for extensibility |
| Recording coordinator | Simple stages plus tested 50 ms release grace | Session IDs, panic recovery, wedge repair, realtime reuse | WinSTT stronger; adopt release grace |
| Post-processing | OpenCC plus optional provider/prompt LLM | Profiles, context, OpenCC, LLM, replacements, encoder correction, snippets, caret join | WinSTT much richer |
| Model selection | One backend command from UI | Backend swap orchestration plus frontend optimistic settings/reconciliation | Simplify WinSTT ownership boundary |
| Downloads | URL/HF/local, resume, cancel, SHA-256, extraction | Per-quant queued pause/resume/cancel, path validation, multi-file HF cache planning | WinSTT operationally stronger |
| Custom models | GGUF/bin and HF-cache discovery | `set_custom_model` exists but scanner is stubbed | Handy pattern is adoptable |
| Frontend | Two entries, flat components, two large stores | Feature-Sliced, eleven entries, many domain stores, extensive tests | WinSTT stronger, but synchronization is over-complex |
| Fresh renderer | 1.30 MiB total; 0.36 MiB initial compressed proxy | 6.01 MiB total; 0.52 MiB initial compressed proxy | WinSTT total is larger; initial gap is moderate |
| Windows x64 NSIS | 20.00 MiB | 27.63 MiB | WinSTT is 38.1% larger |
| Launch policy | Less startup model work; selected STT model remains cold | Splash plus parallel manager boot and eager STT warmup | Trade launch contention for first-dictation readiness |

## Main Analysis

### Finding 1: WinSTT's backend architecture is larger but has the better long-term abstraction

Handy organizes its core around `AudioRecordingManager`, `ModelManager`, `TranscriptionManager`, and `HistoryManager`, all placed into Tauri state during startup. Its transcription manager owns a concrete enum of supported engines and dispatches each engine variant directly. This produces a compact, approachable codebase, and its use of `transcribe-rs` and `transcribe-cpp` gives practical support for Whisper/GGUF, Parakeet, Moonshine, SenseVoice, GigaAM, Canary, and Cohere without implementing every runtime from first principles [3], [6], [10].

WinSTT uses a more layered boundary. The shared transcription manager owns a transcriber abstraction and delegates product-specific resolution, cloud routing, capabilities, warmup, streaming, and shutdown policy through a backend trait. Engine families and runtime/provider rules are separated from the coordinator. That makes the source much larger, but it also localizes the difficult parts of a product that supports many ONNX graph shapes, multiple quantizations, DirectML/CPU policies, native and preview streaming, cloud STT, TTS, LLM features, and more [12], [13], [15].

The error and concurrency discipline is also stronger in WinSTT. It uses RAII guards for model-loading state, catches engine-build panics, waits for concurrent load completion, tracks loading separately from warming and residency, and can recover its transcription coordinator after a command panic. Handy contains good localized guards, but its common model-init path still manually clears a loading flag, its coordinator wraps the whole loop rather than each command, and manager constructors use startup `expect` in the normal path [3], [6], [15].

This matters because a desktop STT app is mostly lifecycle management around expensive, failure-prone native resources. A concrete enum is pleasant while the engine set remains small; once model families, providers, execution devices, streaming capabilities, and unload policies multiply, WinSTT's trait boundary is the safer architecture. Replacing it with Handy's enum would trade explicit complexity for central coupling.

The opportunity is to borrow product-facing capabilities without collapsing the boundary. Handy's automatic GGUF discovery is useful, and `transcribe-cpp` could be evaluated as an optional Whisper/GGUF adapter. It should enter WinSTT through the existing transcriber/backend interfaces, with the same panic containment, provider reporting, warmup contract, and shutdown discipline. A wholesale engine rewrite would discard more proven behavior than it gains.

### Finding 2: WinSTT has the stronger transcription-to-paste path; Handy contributes one excellent input fix

Handy's normal path starts model loading and VAD preload when the shortcut is pressed, selects streaming versus offline VAD from model capabilities, starts capture, and updates tray/overlay state. On release it stops recording, saves a WAV concurrently, finalizes a live stream when one exists or falls back to batch decode, applies post-processing, saves history, and pastes on the main thread [2], [3]. The flow is coherent and easy to trace.

There are several latency and reliability costs in that implementation. The WAV path deep-clones the sample buffer. Fallback batch transcription runs synchronously inside an async-runtime task instead of `spawn_blocking`. The path waits for WAV verification and history persistence before paste. Handy's clipboard sandwich preserves text rather than the full set of Windows clipboard formats, and one log statement records the full transcription. Those choices are simpler, but they can occupy runtime workers, increase memory traffic, delay visible output, destroy non-text clipboard content, and expose dictated text in logs [2].

WinSTT's corresponding path is more deliberate. It shares captured audio through `Arc`, runs blocking inference on a blocking worker, reuses realtime output only for engine kinds where final reuse is safe, detaches history/WAV persistence, ends the transcription session before clipboard/key synthesis, and restores richer clipboard state. It also records timings and character counts rather than the dictated content. Its coordinator adds monotonic session IDs, exact-session completion, silence-stop generations, per-command panic recovery, and a wedge timeout [13], [24].

Handy's clear advantage is its push-to-talk release classifier. It defers a release for 50 ms and cancels the pending stop when a matching press follows, absorbing synthetic X11 auto-repeat release/press pairs. The classifier is isolated and accompanied by a simulator-style regression harness covering burst repeats and genuine final release [21]. WinSTT's coordinator has stronger session semantics but no equivalent release-grace layer [24].

WinSTT should port that classifier ahead of its existing command queue, preserving session IDs and recovery behavior. The implementation should be platform-tested rather than assumed Linux-only; Windows keyboard hooks can also produce bounce-like sequences. This is a low-risk, high-confidence adoption because it adds one input-normalization rule without changing audio, inference, history, or paste architecture.

For native-streaming engines, Handy's direct recorder-to-stream router is worth benchmarking. WinSTT currently mirrors audio and lets a realtime worker snapshot new tails. A bounded, allocation-conscious direct feed may reduce latency and coordination overhead, but Handy's unbounded channel and callback allocation should not be copied literally. The acceptance criterion should be measured callback time, dropped-frame behavior, CPU, and final-transcript parity.

### Finding 3: WinSTT's post-processing pipeline is substantially more capable; Handy mainly broadens provider reach

Handy's post-processing path is intentionally small:

`raw transcript -> effective-language OpenCC -> optional selected provider/prompt -> paste`

It validates provider, model, and prompt selection; disables reasoning for some compatible providers; requests structured output when supported; handles Apple Intelligence separately; removes invisible characters; and falls back to legacy/raw completion or the original transcription on failure [2]. That is a good fail-soft baseline.

WinSTT's path is:

`raw transcript -> app-profile merge -> one context snapshot -> OpenCC -> structured LLM cleanup -> deterministic replacements -> optional encoder correction -> snippets -> caret-aware final join`

The order is explicit and significant. One captured context feeds both LLM and encoder-assisted correction. Replacement pairs run as a deterministic safety net even if the LLM ignores them. The encoder can bias vocabulary toward on-screen terms. Snippets run last unless the LLM already owns them, and caret join is the final idempotent boundary adjustment. Metadata records model, duration, token counts, cost, learned side effects, history tags, and privacy markers [14].

Handy's structured-output feature is therefore not a missing WinSTT capability. WinSTT already requests structured schemas for OpenRouter/Ollama paths, salvages malformed responses, supports fallback models, and retains deterministic post-model guarantees. Replacing its pipeline with Handy's would be a major functional regression.

The real gap is provider reach. Handy's registry includes multiple commercial providers and an editable OpenAI-compatible endpoint, enabling LM Studio, llama.cpp servers, enterprise gateways, and other compatible services [2]. WinSTT's post-processing provider enum is narrower. Adding a `custom_openai_compatible` provider would improve local-first and enterprise flexibility while reusing WinSTT's existing structured-output and fail-soft logic.

The security boundary must remain WinSTT's. Handy's secret map is transparently serialized and merely redacted in debug output; that is not encryption. WinSTT seals stored secrets and strips them from renderer persistence. A custom endpoint should support HTTPS policy, explicit local-HTTP opt-in, host validation, timeouts, cancellation, and the existing secret-sealing path. The useful idea is compatible routing, not Handy's credential storage.

### Finding 4: The biggest architectural opportunity is atomic backend ownership of model and settings changes

Handy's renderer switches models by calling one generated `setActiveModel(modelId)` command. The backend validates that the model is installed, records the intended selection, loads it unless immediate-unload policy says otherwise, and restores the previous selection on failure. The frontend updates `currentModel` after command success and then refreshes from backend lifecycle events [5], [7].

The backend implementation is not perfect. Handy unloads the resident engine before constructing the replacement, so rolling the setting back does not restore the previous in-memory engine. Its loading status can also conflate an unloaded model with an active load. WinSTT's load guard, panic recovery, resolver, capability tracking, quantization override, warmup, and classified failure events are stronger [3], [5], [15].

The important transferable property is the command boundary, not the internals. WinSTT currently has backend swap orchestration, but its renderer also performs optimistic swap state, writes settings, conditionally requests reload, listens for lifecycle events, and reconciles runtime and settings state across webviews. A six-second self-heal exists for phantom optimistic swaps, and separate hooks defend against stale cache and reversed/reverted updates [18], [19]. This is evidence of distributed ownership rather than merely verbose code.

WinSTT should expose a generated `stt_switch_model` transaction with `{modelId, quantization, device, requestId}`. The backend should validate and resolve the request, emit `started`, load and warm using existing machinery, persist the authoritative selection only on success, and emit `completed` or a classified `failed` snapshot. Every event should carry the request ID, settings revision, selected model, resident model, warm state, and any rollback state. The frontend should render this state and stop independently persisting the same transition.

Settings should follow the same direction. Handy uses narrow per-setting commands and treats Rust as canonical, which is simpler than WinSTT's whole-tree save/broadcast/dirty-section synchronization. Handy's frontend, however, sometimes awaits a generated result without checking whether it is an error, so its optimistic UI can lie [8]. The improved pattern is a typed backend patch transaction that returns the new revision and normalized section; the UI may update optimistically but must unwrap and roll back on error.

A revisioned snapshot protocol would eliminate many timing heuristics while preserving multi-window behavior:

`patch request(baseRevision) -> validate/normalize/persist -> snapshot(newRevision, changedSections) -> broadcast`

Local storage can remain a secret-free paint cache, but it should not be an independent authority. This is the most valuable Handy-inspired refactor because it reduces race surface without reducing WinSTT's features.

### Finding 5: WinSTT's download manager is stronger, but custom discovery and explicit verification are real gaps

Handy models can come from direct URLs, Hugging Face, or local files. Direct downloads use HTTP range resume into `.partial` files, restart cleanly if the server ignores range requests, verify expected size, optionally compute a catalog SHA-256 off the async runtime, and then atomically rename or extract through a temporary directory. Hugging Face downloads are cancellable and reuse the shared cache. Download, verification, extraction, completion, cancellation, and failure have distinct events [4].

WinSTT's STT downloader is more operationally advanced. It keys state by model and quantization, queues work through a fixed worker pool, supports pause/resume/cancel, releases worker slots while paused, preserves progress/ETA, resumes into HF-compatible staging, validates repository and cache paths, plans multi-file ONNX plus external-data sets, probes cache state, and falls back to hf-hub where necessary [16]. Handy does not offer the same per-quant lifecycle or bounded queue.

The custom-model comparison reverses that verdict. Handy scans local `.bin`/`.gguf` files, probes GGUF capabilities, suppresses duplicates, discovers compatible models already present in the shared HF cache, and exposes a rescan command [4]. WinSTT already exposes `set_custom_model`, but the command explicitly returns that custom scanning is not wired [23].

WinSTT should finish the scanner using Handy's architecture rather than its file parser: isolate discovery from commands, validate the requested directory is within an approved user-selected root, detect supported multi-file ONNX layouts, verify external-data references, infer engine kind and capabilities, deduplicate against the catalog/HF cache, and return a typed catalog row. A single-flight background rescan can then refresh every webview through the canonical catalog event.

Trusted hashes are a secondary opportunity. WinSTT has strong HF layout and file-set checks, but catalog-provided SHA-256 values would add independent content integrity for artifacts whose publishers provide stable digests. Multi-gigabyte hashing must be off runtime workers and represented as an explicit `verifying` state. The benefit is defense in depth, not faster downloads.

Handy's apparent eight-way HF concurrency is not automatically better than WinSTT's two-worker design. Model packages differ in file count, disk pressure, and cancellation behavior. WinSTT should benchmark 1/2/4/8 workers across slow SSD, fast NVMe, metered/slow networks, and cancellation storms before changing the bound.

### Finding 6: WinSTT's frontend architecture is stronger, while its cross-window synchronization is its main liability

Handy has two renderer entries: the main app and recording overlay. Its UI uses conventional `components`, `hooks`, and `stores` folders. A single app component owns onboarding, permission checks, global listeners, navigation, and settings composition. Settings panels are statically imported, and the primary settings/model Zustand stores are each several hundred lines. Many consumers subscribe to whole stores rather than narrow selectors [7], [8], [9].

WinSTT uses Feature-Sliced layers (`app`, `entities`, `features`, `widgets`, `views`, `entries`) and eleven production renderer entries. Settings, overlay, model picker, onboarding, history, device picker, tray surfaces, and other windows have separate bootstraps. Settings panels are dynamically imported, and domain stores generally expose narrow selectors. The repository also has substantially stronger unit, component, property, accessibility, type, lint, and dead-code gates [12], [17].

IPC is mixed. Handy calls generated commands directly at about a hundred sites and has no raw `invoke` use, demonstrating the ergonomic endpoint WinSTT is moving toward [7], [8]. Handy still duplicates many event strings and exposes few generated typed event wrappers. WinSTT protects event coverage more rigorously, but still maintains a large frozen compatibility funnel from channels through invokers and a route adapter. The result is safer than unguarded literals but more expensive to understand and evolve [18].

WinSTT should continue its existing migration rule: every new call uses generated `commands.*`, canonical events are defined once in Rust, and the legacy funnel only shrinks. The next step is to generate typed wrappers for all renderer-facing canonical events, migrate consumers, and delete matching adapter entries only after coverage parity. Handy is evidence that direct calls remain manageable; it is not a model for event governance.

Handy's recurring permission preflight is also worth adopting. Returning users have microphone/accessibility permissions rechecked, and device/keyboard initialization is deferred until onboarding/permission state is ready. WinSTT already owns permission commands and onboarding UX; it should reveal a focused recovery surface when the OS revokes permission after onboarding rather than allowing later device operations to fail ambiguously [6], [8].

Patterns not to copy include flat component organization, whole-store subscriptions, large singleton stores, unchecked generated results, static settings imports, weak frontend tests, and duplicated literal events. Those make Handy smaller but would reduce WinSTT's isolation and regression protection.

### Finding 7: WinSTT's total bundle and Windows/macOS installers are larger, but its Linux packaging is leaner and launch policy is a tradeoff

Both fresh renderer builds completed successfully. Excluding the audit-only Vite manifest, Handy emitted eight files totaling 1,360,070 bytes (1.30 MiB); WinSTT emitted 263 files totaling 6,299,694 bytes (6.01 MiB). Total renderer size is therefore 4.63 times larger in WinSTT [1], [12].

The startup graph is closer. Handy's main HTML loads one main chunk, preloads one shared chunk, and loads one stylesheet: 1,308,399 raw bytes and a 376,755-byte per-file gzip proxy. WinSTT's main graph reaches 76 JavaScript chunks plus three stylesheets: 1,722,217 raw bytes and a 539,968-byte gzip proxy. WinSTT is 31.6% larger raw and 43.3% larger by that compressed proxy, despite a much larger total product [9], [17]. The file count still matters because dozens of local module loads impose WebView filesystem, compilation, and scheduling overhead.

Published release artifacts show platform-specific results. Handy v0.9.2 versus WinSTT v0.1.3-alpha.6 are: Windows x64 NSIS 20.00 versus 27.63 MiB; macOS ARM64 DMG 17.79 versus 27.43 MiB; Linux x64 AppImage 125.99 versus 107.57 MiB; DEB 67.05 versus 28.60 MiB; RPM 129.26 versus 63.61 MiB [11], [26]. Handy is smaller on Windows/macOS, while WinSTT is dramatically smaller on the compared Linux formats.

Both projects already use LTO, one codegen unit, symbol stripping, and unwind panics in release profiles [10], [28]. Checked-in Tauri resources are almost identical at roughly 2.2 MiB and both include Silero VAD rather than a full STT model. WinSTT's Windows build additionally carries DirectML/runtime components and broader native functionality; Handy packages its own transcribe/ggml/Vulkan/runtime libraries by platform. Dependency counts reflect the scope difference: 971 versus 818 locked Cargo packages and 29 versus 27 direct JavaScript runtime dependencies [10], [28].

No trustworthy end-to-end launch milliseconds were obtained. Code inspection shows that Handy builds a hidden webview and synchronously constructs managers, native backends, tray, and overlay before visibility, while leaving the selected STT model cold until dictation. WinSTT paints a splash, moves headless initialization to a worker, overlaps manager/model work with renderer startup, and hands off on renderer paint/bootstrap rather than waiting for STT warmup [6], [13].

The likely user tradeoff is therefore not simply “Handy is faster.” Handy performs less model work at launch and has a smaller/preloaded renderer, so it should create less startup contention; WinSTT has a more sophisticated visible-start path and warms the selected engine, so it should deliver faster first dictation. Only a controlled cold-start and first-dictation benchmark can decide perceived launch plus time-to-first-use.

The first A/B optimization should be to restore module preload in WinSTT and reduce the main pill's static graph. Sortable UI, download infrastructure, settings code, search controls, animation, and diagnostics appear in the startup closure even when not needed for first paint. Target fewer than ten initial JavaScript files and less than 1 MiB raw without merging secondary windows. Separately test moving eager STT warmup to just after renderer handoff or idle, retaining an eager-first-dictation preference for users who value immediate dictation.

Handy's release workflow performs end-package audits, including extracting packages and silently installing Windows artifacts to verify required runtime files [27]. WinSTT should adopt equivalent NSIS/portable/package smoke tests. That reduces missing-DLL and staging regressions independently of binary size.

## Counterevidence Register

| Observation that appears to favor Handy | Counterevidence or qualification | Decision consequence |
|---|---|---|
| Handy's complete renderer is 4.63x smaller. | WinSTT's initial compressed-size proxy is only 43.3% larger because its multi-entry build defers substantial functionality. | Optimize WinSTT's startup closure; do not flatten the frontend architecture. |
| Handy exposes model switching as one backend command. | Its implementation unloads the resident model before the replacement is ready and does not restore that engine on failure. | Adopt backend transaction ownership while retaining WinSTT's load guard, warmup, and rollback semantics. |
| Handy's transcription and model managers are easier to trace. | They cover fewer engines and centralize more unrelated responsibilities; WinSTT has stronger panic, concurrent-load, and session recovery. | Preserve WinSTT's internal abstractions and simplify only the public transaction boundaries. |
| Handy does less model work at launch. | No controlled cold-start measurement was available, and a cold selected model can delay the first dictation. | Benchmark visible readiness and first-dictation readiness separately before changing warmup policy. |
| Handy permits greater Hugging Face download concurrency. | More parallelism can increase memory, disk, and cancellation pressure for multi-file model packages. | Benchmark queue widths of 1/2/4/8 and keep WinSTT's bounded, cancellable worker model. |

## Synthesis & Insights

Three patterns explain most differences.

First, **WinSTT's complexity is partly essential and partly accidental**. Multiple STT archetypes, quantizations, cloud/local routing, native streaming, TTS, LLM transforms, context awareness, multiple webviews, and richer history necessarily require more code. Optimistic model state, independent settings persistence, cross-window reconciliation, and timeout-based self-healing are accidental complexity created by distributed authority. The architecture should be simplified at transaction boundaries, not flattened internally.

Second, **Handy optimizes for a compact product loop, while WinSTT optimizes for capability and resilience**. Handy's core path is easy to follow, but it pays with unload-first switching, synchronous operations on the output path, smaller test coverage, and weaker clipboard/secret handling. WinSTT's stronger behavior should be preserved even when adopting Handy's surface ergonomics.

Third, **launch performance has two endpoints**: time to first visible usable UI and time to first warm dictation. Handy likely favors the former through less model work; WinSTT intentionally favors the latter by warming during startup. A single “launch seconds” number would obscure that tradeoff. The benchmark should report process-to-splash, renderer-ready, background-runtime-ready, selected-model-loaded, selected-model-warm, and first-dictation end-to-end separately.

The most valuable combined design is therefore:

`WinSTT's resilient backend + atomic backend transactions + compact preloaded renderer + post-paint configurable warmup + headless benchmark surface`

This preserves feature depth while removing synchronization races and generating the measurements required for future size/speed work.

## Limitations & Caveats

The WinSTT working tree contained extensive pre-existing modifications and untracked files. Measurements intentionally reflect that live state, but some linked GitHub source lines represent the baseline commit rather than every local change. The report's local path references are the authoritative locators for the audited files.

Native launch timing was not measured. Handy had no compiled binary locally, and a WinSTT debug instance was already running. Source-based launch conclusions are labeled as inference. Renderer gzip totals are compression proxies; Tauri does not transfer these assets over a production network. File-count and raw-byte comparisons are still relevant to packaging and WebView parse/load work.

Package sizes depend on platform, installer format, compression, code signing, and bundled runtimes. NSIS is compared with NSIS, DMG with DMG, and like Linux formats. An MSI should not be compared directly with NSIS. Models downloaded after installation are excluded from app package size.

Feature scope is not normalized. WinSTT's larger code and bundle include functionality Handy does not implement. Recommendations therefore focus on equivalent flows and architectural boundaries, not on matching Handy's absolute size by deleting WinSTT features.

## Recommendations

### P0 — Implement an atomic backend model-selection transaction

Create generated `stt_switch_model({modelId, quantization, device, requestId})`. Reuse WinSTT's existing resolver, load guard, panic handling, warmup, and classified swap events. Persist selection only after successful readiness, return an authoritative snapshot, and include request/revision IDs in events. Remove frontend settings-save/reload duplication and retire the six-second phantom-swap recovery after migration.

**Expected impact:** highest reliability and maintainability improvement; fewer cross-window race classes.

### P0 — Port Handy's 50 ms PTT release-grace classifier

Place it before WinSTT coordinator commands, retain session IDs and wedge recovery, and port Handy's burst/genuine-release harness. Add Windows and Linux integration cases.

**Expected impact:** low-effort reduction in hotkey bounce/auto-repeat failures.

### P1 — Add a headless transcription and benchmark CLI

Add `--transcribe-file`, `--model`, `--device`, `--list-models`, `--list-devices`, `--repeat`, `--json`, and optional warm/cold controls. Initialize only model/runtime state, never webviews, tray, mic, or paste. Emit load, warmup, decode, RTF, memory, and provider/device data.

**Expected impact:** enables reproducible engine, launch-component, accelerator, and first-dictation regressions.

### P1 — Move settings to revisioned backend patches

Expose typed domain patches with `baseRevision`; validate, normalize, persist, and broadcast a new revision atomically. Keep a secret-free local paint cache only. Always unwrap generated `Result` values and roll back optimistic UI on errors.

**Expected impact:** simplifies `use-sync-settings` and multi-window convergence.

### P1 — Restore/pretest module preload and trim the main startup graph

A/B test removing `modulePreload: false`. Defer picker, sort, download, diagnostics, and nonessential behavior hooks until renderer-ready or idle. Establish budgets: under ten initial JS files, under 1 MiB raw main assets, no regression in first interaction.

**Expected impact:** likely best visible-launch improvement.

### P1 — Finish custom ONNX scanning

Implement the existing command through a dedicated, tested scanner with ONNX family detection, external-data verification, capability inference, approved-root checks, duplicate suppression, and HF-cache discovery.

**Expected impact:** closes a visible feature stub and improves interoperability.

### P2 — Add custom OpenAI-compatible post-processing

Support editable endpoint/model headers through WinSTT's structured-output pipeline and encrypted secret store. Require explicit opt-in for non-loopback HTTP and retain cancellation/timeouts.

**Expected impact:** expands local and enterprise provider compatibility.

### P2 — Unify acquisition and activation states

Publish one authoritative lifecycle per model/quantization:

`queued -> downloading -> paused -> verifying -> installing -> loading -> warming -> active | failed | cancelled`

Keep WinSTT's per-quant and queue features; borrow Handy's explicit verification/install phases.

### P2 — Add recurring permission preflight

Recheck microphone/accessibility permission for returning users, defer device-dependent work until known, and show a focused recovery window when revoked.

### P2 — Add package-content smoke audits

Silently install/extract every release artifact in CI, verify executables/runtime libraries/resources, run a headless smoke command, and uninstall/clean the isolated test prefix.

### P3 — Benchmark, do not blindly adopt

Prototype direct native-stream feeds, adaptive 1/2/4/8 download workers, post-paint versus eager STT warmup, trusted SHA-256 catalog verification, dynamic Windows runtime packaging, and feature/sidecar splits. Promote only changes that improve controlled measurements without reducing cancellation, first-dictation speed, or reliability.

## Bibliography

[1] cjpais (2026). "Handy source tree at v0.9.2 commit". GitHub. https://github.com/cjpais/Handy/tree/ea10f7454e86f893581f5a380a15866476aa6423 (Retrieved: 2026-07-14)

[2] cjpais (2026). "Handy transcription and post-processing actions". GitHub. https://github.com/cjpais/Handy/blob/ea10f7454e86f893581f5a380a15866476aa6423/src-tauri/src/actions.rs (Retrieved: 2026-07-14)

[3] cjpais (2026). "Handy TranscriptionManager". GitHub. https://github.com/cjpais/Handy/blob/ea10f7454e86f893581f5a380a15866476aa6423/src-tauri/src/managers/transcription.rs (Retrieved: 2026-07-14)

[4] cjpais (2026). "Handy ModelManager and download implementation". GitHub. https://github.com/cjpais/Handy/blob/ea10f7454e86f893581f5a380a15866476aa6423/src-tauri/src/managers/model.rs (Retrieved: 2026-07-14)

[5] cjpais (2026). "Handy model commands". GitHub. https://github.com/cjpais/Handy/blob/ea10f7454e86f893581f5a380a15866476aa6423/src-tauri/src/commands/models.rs (Retrieved: 2026-07-14)

[6] cjpais (2026). "Handy Tauri bootstrap". GitHub. https://github.com/cjpais/Handy/blob/ea10f7454e86f893581f5a380a15866476aa6423/src-tauri/src/lib.rs (Retrieved: 2026-07-14)

[7] cjpais (2026). "Handy frontend model store". GitHub. https://github.com/cjpais/Handy/blob/ea10f7454e86f893581f5a380a15866476aa6423/src/stores/modelStore.ts (Retrieved: 2026-07-14)

[8] cjpais (2026). "Handy frontend settings store". GitHub. https://github.com/cjpais/Handy/blob/ea10f7454e86f893581f5a380a15866476aa6423/src/stores/settingsStore.ts (Retrieved: 2026-07-14)

[9] cjpais (2026). "Handy Vite configuration". GitHub. https://github.com/cjpais/Handy/blob/ea10f7454e86f893581f5a380a15866476aa6423/vite.config.ts (Retrieved: 2026-07-14)

[10] cjpais (2026). "Handy Rust manifest". GitHub. https://github.com/cjpais/Handy/blob/ea10f7454e86f893581f5a380a15866476aa6423/src-tauri/Cargo.toml (Retrieved: 2026-07-14)

[11] cjpais (2026). "Handy v0.9.2 release artifacts". GitHub Releases. https://github.com/cjpais/Handy/releases/tag/v0.9.2 (Retrieved: 2026-07-14)

[12] dahshury (2026). "WinSTT repository and local working-tree comparison source". GitHub/local workspace. https://github.com/dahshury/WinSTT (Retrieved: 2026-07-14)

[13] dahshury (2026). "WinSTT Tauri bootstrap baseline". GitHub. https://github.com/dahshury/WinSTT/blob/22bd19fd9ad94a51c3350070c7caa457ce713d69/src-tauri/src/lib.rs (Retrieved: 2026-07-14)

[14] dahshury (2026). "WinSTT post-processing pipeline baseline". GitHub. https://github.com/dahshury/WinSTT/blob/22bd19fd9ad94a51c3350070c7caa457ce713d69/src-tauri/src/actions/post_process.rs (Retrieved: 2026-07-14)

[15] dahshury (2026). "WinSTT model load and swap baseline". GitHub. https://github.com/dahshury/WinSTT/blob/22bd19fd9ad94a51c3350070c7caa457ce713d69/src-tauri/src/managers/transcription/load.rs (Retrieved: 2026-07-14)

[16] dahshury (2026). "WinSTT STT download manager baseline". GitHub. https://github.com/dahshury/WinSTT/blob/22bd19fd9ad94a51c3350070c7caa457ce713d69/src-tauri/src/winstt/managers/download_manager.rs (Retrieved: 2026-07-14)

[17] dahshury (2026). "WinSTT Vite configuration baseline". GitHub. https://github.com/dahshury/WinSTT/blob/22bd19fd9ad94a51c3350070c7caa457ce713d69/vite.config.ts (Retrieved: 2026-07-14)

[18] dahshury (2026). "WinSTT frontend settings synchronization baseline". GitHub. https://github.com/dahshury/WinSTT/blob/22bd19fd9ad94a51c3350070c7caa457ce713d69/src/features/update-settings/api/use-sync-settings.ts (Retrieved: 2026-07-14)

[19] dahshury (2026). "WinSTT frontend model swap orchestration baseline". GitHub. https://github.com/dahshury/WinSTT/blob/22bd19fd9ad94a51c3350070c7caa457ce713d69/src/features/swap-model/model/apply-swap.ts (Retrieved: 2026-07-14)

[20] Tauri Programme (2026). "Tauri architecture documentation". Tauri. https://v2.tauri.app/concept/architecture/ (Retrieved: 2026-07-14)

[21] cjpais (2026). "Handy transcription coordinator". GitHub. https://github.com/cjpais/Handy/blob/ea10f7454e86f893581f5a380a15866476aa6423/src-tauri/src/transcription_coordinator.rs (Retrieved: 2026-07-14)

[22] cjpais (2026). "Handy CLI definitions". GitHub. https://github.com/cjpais/Handy/blob/ea10f7454e86f893581f5a380a15866476aa6423/src-tauri/src/cli.rs (Retrieved: 2026-07-14)

[23] dahshury (2026). "WinSTT STT command surface baseline". GitHub. https://github.com/dahshury/WinSTT/blob/22bd19fd9ad94a51c3350070c7caa457ce713d69/src-tauri/src/winstt/commands/stt.rs (Retrieved: 2026-07-14)

[24] dahshury (2026). "WinSTT transcription coordinator baseline". GitHub. https://github.com/dahshury/WinSTT/blob/22bd19fd9ad94a51c3350070c7caa457ce713d69/src-tauri/src/transcription_coordinator.rs (Retrieved: 2026-07-14)

[25] dahshury (2026). "WinSTT CLI definitions baseline". GitHub. https://github.com/dahshury/WinSTT/blob/22bd19fd9ad94a51c3350070c7caa457ce713d69/src-tauri/src/cli.rs (Retrieved: 2026-07-14)

[26] dahshury (2026). "WinSTT v0.1.3-alpha.6 release artifacts". GitHub Releases. https://github.com/dahshury/WinSTT/releases/tag/v0.1.3-alpha.6 (Retrieved: 2026-07-14)

[27] cjpais (2026). "Handy release build and package-audit workflow". GitHub Actions configuration. https://github.com/cjpais/Handy/blob/ea10f7454e86f893581f5a380a15866476aa6423/.github/workflows/build.yml (Retrieved: 2026-07-14)

[28] dahshury (2026). "WinSTT Rust manifest baseline". GitHub. https://github.com/dahshury/WinSTT/blob/22bd19fd9ad94a51c3350070c7caa457ce713d69/src-tauri/Cargo.toml (Retrieved: 2026-07-14)

## Appendix: Methodology

### Research process

The investigation followed eight phases: scope decomposition; source and measurement planning; repository retrieval; claim triangulation across code, build configuration, generated bundles, and releases; outline refinement; synthesis; adversarial critique; and report packaging. The outline was refined after inspection showed that the most important contrast was not “new Handy architecture versus old WinSTT architecture,” but backend authority versus distributed renderer synchronization. Launch findings were also separated into visual readiness and first-dictation readiness after evidence showed the apps intentionally optimize different endpoints.

Twenty-eight primary sources were registered. Most are exact source files pinned to Handy's audited commit or WinSTT's comparison baseline, supplemented by current local files, official release metadata, build workflows, and Tauri documentation. Code claims use exact local symbols/line regions in the evidence ledger. Build claims were reproduced from fresh `bun run build` outputs and independently measured file graphs.

### Verification approach

Major conclusions were cross-checked across at least three evidence clusters: backend implementation, frontend call/state flow, and build/runtime configuration. For example, atomic model ownership was assessed using Handy's backend command, Handy's model store, WinSTT's load manager, WinSTT's frontend swap action, and its settings synchronization hook. Package claims were checked against both release pages and local renderer/resource configuration.

No contradictory evidence was suppressed. Handy's smaller package and simpler command boundary are reported alongside its weaker unload behavior and Linux package sizes. WinSTT's better startup orchestration is reported alongside its larger startup graph and eager model contention. Where direct timing was unavailable, the report explicitly stops at inference.

### Claims-evidence table

| Claim | Supporting sources | Confidence |
|---|---|---|
| WinSTT's backend lifecycle architecture is stronger overall | [3], [13], [15], [24] | High |
| Handy's atomic model command is the best frontend/backend pattern to adopt | [5], [7], [18], [19] | High |
| Handy's 50 ms release grace fills a real WinSTT coordinator gap | [21], [24] | High |
| WinSTT's post-processing pipeline is richer | [2], [14] | High |
| WinSTT's downloader is stronger, but custom scanning is missing | [4], [16], [23] | High |
| WinSTT's full renderer is 4.63x larger, while initial compressed proxy is 43% larger | [1], [9], [12], [17] plus build measurements | High |
| Handy likely does less launch work, while WinSTT likely improves first dictation | [6], [13], [17] | Medium; inference |
| Headless CLI is necessary for trustworthy performance regression testing | [22], [25] | High |

### Report metadata

**Total registered sources:** 28  
**Primary source types:** source code, build configuration, CI workflow, release metadata, official documentation  
**Temporal coverage:** current repositories/releases through 2026-07-14  
**Validation target:** structure, bibliography completeness, URL/citation checks, claim/evidence ledger consistency
