# WinSTT and Handy comparison

WinSTT has a substantial lead in the range of speech workflows and the control surrounding inference. Handy remains competitive in transcription itself and has stronger designs in several reliability and compatibility areas. The evidence supports calling WinSTT a more capable speech workstation; it does not establish that WinSTT is universally faster, more accurate, smaller, or more reliable.

Assessment date: 11 October 2026. WinSTT baseline: `01a0919ce8ce9220db8a894be88eaf82c8084b6d`, plus the existing local working changes. Handy baseline: upstream `main`, `48a3d8e9ee456c1c6a3b7223779271c457890b4d`, dated 10 October 2026; its package version is 0.9.8. The existing clean reference checkout in `E:/DL/Projects/WinSTT/examples/Handy` was updated with `git pull --ff-only`; HEAD matches origin/main. Application code was not changed for this comparison.

The comparison distinguishes implemented code, historical measurements recorded in the repository, and engineering judgments. A current controlled comparison of the two release builds has not been performed. Catalog availability also does not establish accuracy or performance of every export.

## Overall assessment

| Aspect | Assessment | Reason |
| --- | --- | --- |
| Speech workflows | WinSTT leads substantially | Dictation, system-audio listening, wake words, file queues, diarization, TTS, text transforms, and context-aware cleanup are integrated. |
| Local transcription models | Both are extensive | WinSTT has 84 catalog rows. Handy has 69 curated GGUF rows, 16 retained legacy entries, and local model discovery. Neither row count nor variant count establishes quality. |
| Accelerator and precision policy | WinSTT offers finer control | Decisions account for engine, export, precision, RAM/VRAM, and the cost of GPU versus CPU operations. |
| Native inference crash containment | Handy leads on its current GGUF path | transcribe.cpp executes in a supervised child process. WinSTT STT runs in the application process. Handy's retained ONNX path is also in-process. |
| Audio callback design | Handy has the stronger real-time transport design | A wait-free SPSC sample ring removes allocation and locks from the callback. WinSTT recycles buffers over channels. |
| Typed command boundary | Both use the same foundation | Both use tauri-specta generated bindings. WinSTT adds explicit boundary and event-coverage guards. |
| Architecture for a broad product | WinSTT is better organized for its scope | Frontend slices and backend domain modules separate many independent features, at a substantial complexity cost. |
| Forkability and a narrow dictation app | Handy is simpler | A much smaller renderer and fewer feature surfaces make the core easier to understand. |
| Local cloud-key storage | WinSTT has stronger protection | OS-protected secrets versus Handy's serialization of a string map with debug redaction. |
| Hardware reach | Handy leads in explicit release coverage | Windows ARM, Linux ARM, Intel Mac, Apple Silicon, and baseline Windows x64 CPU support are present in its release matrix. |
| Speed, accuracy, idle memory, battery use | No overall winner established | Requires matched release builds, audio, hardware, configuration, and workloads. |
| Distribution and public adoption | Handy leads substantially | Larger public ecosystem and a broader platform matrix; this is not a measure of code quality. |

## Features and user experience

| Workflow | WinSTT | Handy at the examined revision |
| --- | --- | --- |
| Hold or toggle dictation and paste into apps | Implemented | Implemented, including combined hold/tap activation |
| Live partial transcription | Implemented; incremental streams and rolling preview | Implemented; model-capability-based streaming and finalization |
| Local inference and GPU acceleration | Unified ONNX with platform providers | GGUF/transcribe.cpp with Vulkan or Metal; retained ONNX models on CPU |
| Cloud speech recognition | OpenRouter transcription endpoint and ElevenLabs | No corresponding application workflow found |
| Cleanup using local or cloud LLMs | Ollama and multi-provider transport, modifiers, presets, fallback behavior | Configurable prompts and providers; includes Apple Intelligence on supported Macs |
| Dictionary | Contextual on-device masked-LM correction when downloaded, or LLM ownership | Custom words, supported decode prompts, fuzzy correction |
| Snippet expansion | Implemented, with LLM integration policy | No corresponding application workflow found |
| Context from the active application | Implemented with capture, scope rules, deny lists, and scrubbing | No corresponding application workflow found |
| Application-specific cleanup rules | Implemented | No corresponding application workflow found |
| System-audio listening and captions | Implemented, with platform capture implementations | No corresponding application workflow found |
| Separate speaker diarization pipeline | Streaming Nemotron/Sortformer worker integrated with listening | No equivalent pipeline found; the catalog does include MOSS Transcribe Diarize, so speaker-aware model output is a separate possibility |
| Wake-word activation | Native keyword spotter on the existing ORT runtime | No corresponding application workflow found |
| File transcription | Queue, pause/resume/cancel/retry, media decoding and exports | No equivalent file queue found |
| Transcript export | TXT, SRT, VTT, JSON, CSV | No equivalent multi-format file workflow found |
| Text-to-speech | Local engine catalog and cloud paths; voice features vary by engine | No corresponding application workflow found |
| History | SQLite with FTS5 across transcription, transforms, and TTS | SQLite, pagination, recordings, retention, and retry |
| External automation | Native application commands and integrations | CLI control of an existing instance; documented community Raycast integration |

These are application features, not claims that one app has exclusive access to the underlying research models. WinSTT's distinctive value is combining workflows and applying language, memory, model, and provider policies around them.

For a user who needs captions, audio files, voice output, or app-specific cleanup, WinSTT's lead is meaningful. A user who wants only to dictate and paste may prefer Handy's smaller choice surface. UI beauty, accessibility in actual operation, onboarding completion, and paste success rates need hands-on evaluation; screenshots and component count cannot settle them.

Sources: [file queue](E:/DL/Projects/WinSTT/src-tauri/src/winstt/managers/file_transcribe_manager.rs), [export serializers](E:/DL/Projects/WinSTT/src-tauri/src/winstt/managers/transcript_export.rs), [listening](E:/DL/Projects/WinSTT/src-tauri/src/winstt/managers/loopback_manager.rs), [diarization](E:/DL/Projects/WinSTT/src-tauri/src/winstt/diarize/mod.rs), [dictionary correction](E:/DL/Projects/WinSTT/src-tauri/src/winstt/encoder_dict/mod.rs), [TTS catalog](E:/DL/Projects/WinSTT/src-tauri/src/winstt/tts/catalog.rs), [WinSTT history](E:/DL/Projects/WinSTT/src-tauri/src/managers/history.rs), [Handy settings](E:/DL/Projects/WinSTT/examples/Handy/src-tauri/src/settings.rs), [Handy history](E:/DL/Projects/WinSTT/examples/Handy/src-tauri/src/managers/history.rs), [Handy README](E:/DL/Projects/WinSTT/examples/Handy/README.md).

## Architecture and maintenance

Both applications share Rust, Tauri, React, Zustand, CPAL, SQLite, and generated Specta bindings. WinSTT's use of Rust or Tauri is therefore not a differentiator. Neither is generated command typing by itself.

WinSTT organizes the renderer by app, views, widgets, features, entities, and shared infrastructure. The backend separates domain features under `winstt/`; the generic transcription lifecycle calls a `SttBackend` trait for WinSTT-specific resolution, decoding, cloud transport, and postprocessing. That boundary is useful for controlling an expanded product. Engine swaps resolve required resources before unloading the old engine, and preview paths yield to final inference.

Handy is organized more directly around components, stores, managers, and a transcription coordinator. This is easier to navigate for a narrower product, although it still has substantial manager modules. Its supervisor is a particularly valuable architectural addition: native backend initialization, enumeration, load, decode, and streaming run in a child, with bounded calls, cancellation, restart, and CPU-only recovery.

WinSTT catches Rust panics and recovers poisoned locks, but those mechanisms cannot contain a native access violation, process abort, or stuck driver. Its engine policy even documents DirectML graph combinations that previously terminated the process. Avoiding known bad combinations helps; a process boundary also protects against unknown combinations. WinSTT already uses a persistent sidecar for context capture, providing a local example of bounded requests and worker recovery.

Source inventory illustrates the maintenance difference:

| Static inventory | WinSTT | Handy |
| --- | ---: | ---: |
| Frontend production TS/TSX files, excluding test and recognized generated files | 1,059 | 144 |
| Frontend TS/TSX test files under src | 441 | 3 |
| Rust files under src-tauri/src | 314 | 66 |
| Literal Rust `#[test]` attributes | 1,838 | 294 |
| Literal Tauri command attributes | 252 | 118 |

These counts are descriptive, not coverage or quality scores. Rust totals include tests and generated numerical tables. Handy also has tests outside src. WinSTT's broader test and contract infrastructure is valuable, but its larger implementation creates more interactions to maintain.

Sources: [WinSTT backend boundary](E:/DL/Projects/WinSTT/src-tauri/src/winstt/stt/backend.rs:1), [transcription lifecycle](E:/DL/Projects/WinSTT/src-tauri/src/managers/transcription.rs), [Handy process isolation](E:/DL/Projects/WinSTT/examples/Handy/src-tauri/src/engine_supervisor/mod.rs:1), [Handy supervisor](E:/DL/Projects/WinSTT/examples/Handy/src-tauri/src/engine_supervisor/supervisor.rs), [context worker lifecycle](E:/DL/Projects/WinSTT/src-tauri/src/winstt/managers/context_manager.rs).

## Engines and model coverage

WinSTT owns ONNX frontends and decode implementations across Whisper, Moonshine, CTC, transducers, streaming NeMo/Zipformer, and several larger encoder-decoder models. Its 84 runtime catalog entries and picker rows currently agree. Keeping STT, keyword spotting, and other neural features on the same ORT library avoids carrying a separate runtime solely for wake words.

That choice buys precise control of export quirks, graph fixes, GPU memory placement, and scheduling. It also makes WinSTT responsible for maintaining tokenization, feature extraction, cache contracts, termination rules, and provider compatibility as exports evolve. Sharing a runtime does not mean only one neural model is resident, nor does it prove a smaller whole installation.

Handy's current curated catalog is entirely routed through transcribe.cpp. Architecture is inferred from GGUF metadata; the same path covers Whisper, Parakeet, Voxtral, Qwen3-ASR, Nemotron, Granite, and others. The separate transcribe-rs ONNX implementations are retained for legacy models. Uninstalled legacy URL entries are hidden in the UI; installed ones remain usable. Thus the comparison is not 84 working models versus a small Whisper-only application.

The catalogs also differ rather than forming a strict superset. Handy lists Voxtral, MedASR, and MOSS models absent from WinSTT's shipped catalog. WinSTT has Audio8, VibeVoice BitNet, Kaldi/Zipformer choices, and detailed streaming latency/precision variants. Both cover Qwen3-ASR, Granite, Moonshine, and substantial NeMo-derived speech recognition.

WinSTT should retain its unified ONNX strategy where it has validated exports and useful provider control. It should judge an optional transcribe.cpp worker by demonstrated gaps or measured gains. Adding a second backend for parity alone would add model formats, packaging, and maintenance without a demonstrated user benefit.

Sources: [WinSTT runtime catalog](E:/DL/Projects/WinSTT/src-tauri/src/winstt/catalog/data.rs), [picker catalog](E:/DL/Projects/WinSTT/src-tauri/src/winstt/commands/catalog_data/catalog_data.json), [Handy curated catalog](E:/DL/Projects/WinSTT/examples/Handy/src-tauri/src/catalog/catalog.json), [Handy runtime taxonomy](E:/DL/Projects/WinSTT/examples/Handy/src-tauri/src/managers/model.rs:27), [catalog and legacy coexistence](E:/DL/Projects/WinSTT/examples/Handy/src-tauri/src/managers/model.rs:1204), [native keyword spotter](E:/DL/Projects/WinSTT/src-tauri/src/winstt/wakeword/ort_detector.rs).

## Accelerator and precision decisions

WinSTT's strongest inference engineering is its granular policy:

- Auto precision chooses a published precision using estimated runtime footprint and the memory budget of the device that will actually run the model. Explicit precision selections remain explicit. Parameter-based footprint is a heuristic; activations and runtime allocation still need measurement.
- GPU availability does not force GPU execution. Incompatible graphs and combinations measured slower on DirectML are routed to CPU.
- NeMo transducers can put the large encoder on GPU and the repeated decoder/joiner work on CPU. This avoids paying GPU launch costs for small per-frame operations.
- Whisper keeps cache tensors on the execution device through IoBinding instead of copying the complete cache through host memory each token. Bindings and feature-extraction resources are reused.
- Cohere routing examines the actual export for fused MultiHeadAttention, allowing suitable decomposed exports onto DirectML.
- CPU thread selection uses physical cores with a cap; GPU sessions use fewer feeder threads. This is more deliberate than using every logical thread everywhere.

Handy's GGUF backend offers Vulkan on Windows x64/Linux and Metal on macOS, with runtime CPU dispatch and selectable devices. Its ONNX path is deliberately CPU-only in the shipped dependency configuration. That trades ONNX GPU coverage for simpler compatibility and avoidance of the AVX2 baseline that previously broke startup on old CPUs. Its process supervisor further protects the application from native failures.

WinSTT's default Windows accelerator is DirectML; CUDA, ROCm, OpenVINO, and WebGPU are opt-in features with target-specific routing. The macOS bundle helper enables CoreML. Available enum variants must not be described as accelerators enabled in every shipped build. Handy's configurable accelerator settings have the same distinction between UI settings and actual build capabilities.

Engineering judgment: WinSTT offers more fine-grained control; Handy has a simpler broadly portable path for its curated GGUF models. Neither ONNX nor GGUF is inherently the faster choice for all architectures, precisions, and devices.

Sources: [fit and provider policy](E:/DL/Projects/WinSTT/src-tauri/src/winstt/stt/quant_resolve.rs), [engine compatibility policy](E:/DL/Projects/WinSTT/src-tauri/src/winstt/stt/engine_kind.rs), [transducer sessions](E:/DL/Projects/WinSTT/src-tauri/src/winstt/stt/families/transducer.rs:95), [Whisper cache handling](E:/DL/Projects/WinSTT/src-tauri/src/winstt/stt/whisper.rs), [WinSTT build features](E:/DL/Projects/WinSTT/src-tauri/Cargo.toml), [Handy native backends and CPU baseline](E:/DL/Projects/WinSTT/examples/Handy/src-tauri/Cargo.toml), [macOS build helper](E:/DL/Projects/WinSTT/tools/macos/tauri-bundles.sh:38).

## Speed and resource use

WinSTT has substantive optimizations: device-resident KV caches, reused IoBinding, parallel FFT/mel extraction, model-aware long-audio chunking, native-stream final reuse, background warmup, conditional preview work, and startup/window preparation. These are credible mechanisms, not a measured win over Handy.

Handy also feeds native streaming engines while recording and reuses the finalized stream. Its current recorder uses a wait-free SPSC ring, with callback work designed to be allocation-, lock-, logging-, and blocking-free. WinSTT instead recycles Vec buffers and sends input chunks over a channel. This can work well, but its structure offers fewer hard real-time guarantees. WinSTT has extensive capture-boundary, pre-roll, device-readiness, and tail-drain logic; that addresses different problems than callback transport.

WinSTT's engine-policy comments record earlier local observations, including Parakeet RNN-T hybrid inference at 645 ms versus 2.38 s all-CPU on a 66-second clip, and Qwen3-ASR int4 at 4.5 s DirectML versus 8.2 s CPU on a 66-second clip. Those are historical comparisons within WinSTT. They do not compare against Handy's GGUF path and are not current replicated benchmarks.

The July startup artifact records roughly 0.6 seconds to renderer readiness and 2.6 seconds to STT warmup on its tested build. It predates both examined revisions. The recorder-feed benchmark is a JavaScript transport simulation, not a live CPAL benchmark. Neither supports a current product-level speed claim.

A faster model in one picker, a smaller quantized weight file, or a newer React version does not establish faster end-to-end dictation. Final latency includes capture shutdown, tail drain, inference, correction, optional LLM work, and text insertion. Concurrent TTS, diarization, and preview can also affect resource use.

Sources: [WinSTT realtime worker](E:/DL/Projects/WinSTT/src-tauri/src/winstt/managers/realtime_manager.rs:1), [Handy stream finalization](E:/DL/Projects/WinSTT/examples/Handy/src-tauri/src/managers/transcription.rs), [WinSTT recorder](E:/DL/Projects/WinSTT/src-tauri/src/audio_toolkit/audio/recorder.rs), [Handy recorder](E:/DL/Projects/WinSTT/examples/Handy/src-tauri/src/audio_toolkit/audio/recorder.rs:31), [historical startup artifact](E:/DL/Projects/WinSTT/artifacts/perf/native-startup-final-2026-07-15.json), [historical recorder simulation](E:/DL/Projects/WinSTT/artifacts/perf/recorder-feed-2026-07-15.json).

## Reliability and privacy

Handy's native worker provides the clearest reliability advantage. A crash can trigger worker replacement and CPU recovery while the application remains alive. Killing an unloaded worker also returns native CPU/GPU allocations to the OS. WinSTT should consider the same containment for its inference boundary, with a stream protocol that preserves incremental operation.

Handy also implements receipt-sequenced clipboard restoration on Windows/macOS. This is a debug-gated option, disabled by default, so it cannot be presented as the reliability of every default Handy paste. It waits for post-keystroke clipboard-consumer activity before restoration and checks ownership. WinSTT restores after a 400 ms background delay with ownership protection and preserves multiple clipboard formats. Ownership protection prevents overwriting a later copy; it does not prove the target already consumed the transcript. Receipt-based restoration is worth evaluating against WinSTT's existing clipboard preservation.

WinSTT has strong recovery plumbing for absent or incomplete model caches, explicit cloud errors/cancellation, and startup selection reconciliation. Handy has resumed downloads, bounded network behavior, mirrors, pinned curated model revisions, and SHA256 verification. WinSTT's general STT resolver selects repositories and searches cache revisions without the same per-model immutable revision/hash manifest in its runtime catalog. Pinning tested graphs would help keep export-specific routing reproducible; some other WinSTT subsystems already pin their artifacts.

For secrets at rest, WinSTT uses DPAPI on Windows and OS-keychain-backed protection on other systems, integrated into settings persistence. Handy's SecretMap redacts Debug output but serializes the string map transparently. Redaction helps logs; encryption helps persisted credentials. WinSTT has the stronger design here.

Both can transcribe locally. WinSTT's cloud STT, cloud cleanup, and application context expand the possible data flows. Its scope rules, deny list, and secret scrubber help, but source inspection is not a security audit or proof that every sensitive string is removed. Local dictation should remain a clearly selectable workflow, and cloud context transmission should be understandable to users.

Sources: [Handy supervisor](E:/DL/Projects/WinSTT/examples/Handy/src-tauri/src/engine_supervisor/supervisor.rs), [Handy paste transaction](E:/DL/Projects/WinSTT/examples/Handy/src-tauri/src/paste_tx/mod.rs:1), [Handy default reliable-paste setting](E:/DL/Projects/WinSTT/examples/Handy/src-tauri/src/settings.rs:983), [WinSTT clipboard restoration](E:/DL/Projects/WinSTT/src-tauri/src/clipboard_snapshot.rs:24), [WinSTT startup recovery](E:/DL/Projects/WinSTT/src-tauri/src/winstt/stt/startup_recovery.rs), [Handy download verification](E:/DL/Projects/WinSTT/examples/Handy/src-tauri/src/managers/model/download.rs:52), [WinSTT resolver](E:/DL/Projects/WinSTT/src-tauri/src/winstt/stt/resolver/fetch.rs:274), [WinSTT secret storage](E:/DL/Projects/WinSTT/src-tauri/src/winstt/commands/secret_storage.rs), [Handy SecretMap](E:/DL/Projects/WinSTT/examples/Handy/src-tauri/src/settings.rs:340), [context policy](E:/DL/Projects/WinSTT/src-tauri/src/winstt/context.rs).

## Choosing engines and workflows

The following choices are candidates for testing on the user's language and hardware, not a universal accuracy ranking. Model-card capabilities must also be supported by the specific export and application adapter.

| Need | Starting point | Decision rule |
| --- | --- | --- |
| English live dictation on a constrained CPU | Small native-streaming Moonshine | Favor time to useful text and sustained RTF below 1; compare small versus tiny for accuracy. The examined streaming checkpoint is English-only. |
| English or supported European-language batch dictation | Parakeet/TDT candidate | Check the exact variant's language coverage; Parakeet v3 supports 25 European languages, which excludes Arabic. |
| Arabic or mixed Arabic/English | Compare supported Whisper, Qwen3-ASR, and Cohere exports | Evaluate dialects, code switching, names, numerals, and quiet/noisy speech. Qwen3-ASR and Cohere explicitly include Arabic; that does not settle Egyptian-dialect accuracy. |
| Continuous captions | A genuine native-streaming model | Measure stable partial latency, finalization lag, backlog, and long-session drift. Keep speaker attribution separate from text latency. |
| Long recordings or subtitle files | Model with verified segmentation and timestamps | Score transcript accuracy and timestamp error; apply engine-specific chunk limits rather than feeding every model an arbitrarily long clip. |
| Tiny models or repeated small decoder operations | CPU or hybrid sessions | GPU dispatch/transfer costs can dominate. Use measured engine/precision routing. |
| Large compatible encoder on Windows | DirectML candidate | Keep cache tensors resident; test repeated calls and shape changes, not only first-run success. |
| Limited RAM/VRAM | A fitting published quantization | Choose using measured memory and accuracy. Do not assume int8 is always faster on a GPU or parameter size fully predicts peak memory. |
| Terminology correction with cleanup disabled | Downloaded contextual dictionary model | Bound retrieval work and test false corrections. Handy's simpler fuzzy path may be sufficient for a small vocabulary. |
| Text cleanup | Deterministic formatting first; small local LLM if needed | Keep ordinary dictation separate from open-ended rewriting; measure meaning preservation and added latency. |
| Cloud transcription | Explicitly selected cloud workflow | Evaluate latency, cost, privacy requirements, and local fallback behavior separately from offline inference. |

Official capability sources: [Moonshine Streaming Small](https://huggingface.co/moonshine-ai/moonshine-streaming-small), [Parakeet TDT v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [Qwen3-ASR](https://huggingface.co/Qwen/Qwen3-ASR-0.6B), [Cohere Transcribe](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026). Application routing sources: [engine taxonomy](E:/DL/Projects/WinSTT/src-tauri/src/winstt/stt/engine_kind.rs), [long-form chunk limits](E:/DL/Projects/WinSTT/src-tauri/src/winstt/stt/mod.rs), [precision policy](E:/DL/Projects/WinSTT/src-tauri/src/winstt/stt/quant_resolve.rs).

## Testing and release engineering

WinSTT has substantial frontend tests, Rust tests, IPC completeness/event guards, catalog parity, cycles/deadcode checks, startup bundle budgets, accessibility tooling, and cross-platform build/package gates. Handy also has Rust tests, frontend keyboard tests, Playwright infrastructure, formatting/lint checks, translation/model-language checks, and artifact validation. The comparison should credit both rather than treating Handy as untested.

Five selected WinSTT test files were executed once. The result was 16 passes and one timeout. Event coverage, catalog DTO parity, cloud catalog parity, model fitness/language suggestions, and two boundary behavior checks passed. The production source-scanning boundary test exceeded its default 5,000 ms timeout, taking about 15.6 seconds. The command finished with a failing exit code. No failing source assertion was reported; the test-runtime limit remains a verification limitation. Log: [targeted checks](E:/DL/Projects/WinSTT/.tmp/handy-comparison-tests.log).

These checks do not establish the health of either full test suite, native binaries, or all supported platforms. No fresh backend build, complete gate run, or paired release benchmark was performed.

Handy's release matrix explicitly includes Windows x64/ARM64, Linux x64/ARM64, and both Mac architectures. WinSTT's documented current downloads cover Windows x64, Linux x64, and Apple Silicon. WinSTT's Windows x64 package requires an AVX2-capable processor, while Handy has deliberately worked around the prior ONNX AVX2 startup baseline. This is a practical Handy advantage for older PCs and ARM users, separate from transcription speed.

Public GitHub API counts on the assessment date were 33,470 stars and 3,115 forks for Handy versus 33 stars and three forks for WinSTT. These show a much larger visible adoption/forking ecosystem; they do not prove retention, active user counts, or correctness. Sources: [Handy repository metadata](https://api.github.com/repos/cjpais/Handy), [WinSTT repository metadata](https://api.github.com/repos/dahshury/WinSTT).

Both repositories declare MIT for application code. Models and native components have their own licenses and notices. WinSTT's notices still describe a bundled sherpa-onnx DLL and the older diarization path, although the current Cargo/runtime code has removed or replaced them. Updating those descriptions is documentation maintenance, not a finding that distribution is legally noncompliant.

Sources: [WinSTT CI](E:/DL/Projects/WinSTT/.github/workflows/ci.yml), [WinSTT native gates](E:/DL/Projects/WinSTT/.github/workflows/rust-ci.yml), [Handy Rust tests](E:/DL/Projects/WinSTT/examples/Handy/.github/workflows/test.yml), [Handy releases](E:/DL/Projects/WinSTT/examples/Handy/.github/workflows/release.yml:49), [WinSTT downloads and AVX2 requirement](E:/DL/Projects/WinSTT/README.md), [third-party notices](E:/DL/Projects/WinSTT/THIRD_PARTY_NOTICES.md).

## Priority improvements

1. Add supervised native inference containment, starting with a bounded protocol for batch load/decode/cancel and preserving a streaming extension. Require native-abort and hung-worker tests, CPU recovery, and audio recovery without duplicate pastes. Handy's retained ONNX path is not isolated, so adapt the design rather than assuming it already solves ORT containment.
2. Benchmark WinSTT's callback transport against an allocation-free SPSC ring while preserving pre-roll, readiness, VAD masks, and tail capture. Measure overruns and worst-case callback time under CPU load, not only average throughput.
3. Evaluate receipt-sequenced paste restoration in Chrome/Electron apps, editors, terminals, and slow targets. Preserve existing multi-format snapshots and ownership safeguards; account for clipboard managers that can create misleading early reads.
4. Pin tested model exports with immutable revisions and integrity metadata. Run repeated provider/precision fixtures for every changed export, including dynamic shapes and session reuse.
5. Correct documentation drift: the README's separate fast preview model is contradicted by the single-engine realtime implementation; catalog comments mention older totals; third-party notices describe removed runtimes. Also investigate the source-scan test's runtime budget without weakening its assertion.
6. Publish a reproducible paired benchmark before claiming a general speed or accuracy lead. Continue feature development against actual workflow demand rather than using catalog size as the competitive metric.

## Benchmark needed to establish a performance lead

Use fresh optimized builds from the recorded revisions on the same machine, with exact model/export/precision/provider versions and audio published in the result manifest. The inspected development machine has an Intel i9-12900KF and NVIDIA RTX 3080 Ti; include a CPU-only laptop, an older Windows PC, and an Apple Silicon machine before generalizing.

Run two distinct comparisons: an inference comparison using the same base model with explicitly documented export/precision differences, and a product comparison using each application's recommended configuration for the same task. The latter captures practical defaults; the former helps attribute differences to implementation. A result comparing one app's tiny model to the other's large model should not be labeled an engine-speed comparison.

Include short dictation, minute-long speech, 30-minute audio, silence/noise, names/numerals, Arabic/English code switching, Bluetooth capture, and long streaming sessions. Keep LLM cleanup, dictionary correction, and diarization disabled for raw STT comparisons; measure them separately as complete workflows. Repeated warm trials and fresh-process cold trials should be reported separately.

Record word/character error rates, hallucinated output on silence, timestamp error, time to first stable partial, stop-to-final-text and stop-to-successful-paste p50/p95, RTF, peak and post-unload RAM/VRAM, idle CPU, callback overruns, and recovery behavior after cancellation, disconnect, worker crash, or failed download. Measure package size, startup readiness, and model-ready time separately from inference. Count successful text insertion in real target applications; a generated string is not a successful dictation.

A defensible competitive claim today is: **WinSTT offers substantially more integrated speech workflows and finer ONNX routing, while Handy remains a serious transcription competitor with valuable reliability and compatibility advantages.**
