# Reference app review — October 11, 2026

WinSTT has a strong local engine and streaming foundation, but that does not establish a general lead over these products. OpenWhispr and Anarlog have substantial meeting/assistant workflows; Superwhisper has specialized cleanup and agent tooling; Buzz has a mature file/subtitle workflow. Improvements should follow a demonstrable gap rather than a model count or marketing latency claim.

## Checkout inventory and maintenance

This checkout initially contained only `examples/Handy` and `examples/diarization-playground`. The playground is local research, not an independent Git checkout; running Git inside it resolves to WinSTT's repository. It was preserved. Handy was clean and already current. Eight new reference checkouts were cloned, then all nine references were fetched and checked for a safe fast-forward.

The reference directories remain ignored by Git. The tracked [repository list](../../tools/references/repositories.json) and [sync script](../../tools/references/sync.ps1) make this repeatable:

```powershell
./tools/references/sync.ps1
```

The script checks the directory and origin, requires an independent `.git`, fetches, and only fast-forwards a clean checkout on the upstream default branch. Dirty, detached, non-default, or divergent checkouts are preserved. It never stashes, resets, installs dependencies, or executes an upstream build. Exact results go to `examples/reference-inventory.json`.

| Directory | Upstream reviewed | HEAD | Commit date |
| --- | --- | --- | --- |
| Handy | [cjpais/Handy](https://github.com/cjpais/Handy) | `48a3d8e9ee456c1c6a3b7223779271c457890b4d` | Oct 10 |
| OpenWhispr | [OpenWhispr/openwhispr](https://github.com/OpenWhispr/openwhispr) | `5f9a88b0481a066c147bfd2c38ea1d9acae502ee` | Oct 10 |
| VoiceInk | [Beingpax/VoiceInk](https://github.com/Beingpax/VoiceInk) | `c09cc1f677f40f2ee665843a61f07670210f012e` | Oct 1 |
| Voxtype | [peteonrails/voxtype](https://github.com/peteonrails/voxtype) (`dev`) | `6d2fc6ddbf791ac00d6a54dc002664010c16b100` | Sep 26 |
| Epicenter | [EpicenterHQ/epicenter](https://github.com/EpicenterHQ/epicenter), current Whispering | `470b1ee81951776da89accf3d5bc8fc445d83f4c` | Oct 11 |
| Hyprnote | [fastrepl/anarlog](https://github.com/fastrepl/anarlog), renamed Anarlog | `cc7a8f707d360a73f677ced16098067d161437aa` | Oct 11 |
| Wisper | [hudsonbrendon/wisper](https://github.com/hudsonbrendon/wisper) | `f5d6777d8d2c5c22617cf8ff3ac4f1d217a0dc7e` | Jul 31 |
| Buzz | [chidiwilliams/buzz](https://github.com/chidiwilliams/buzz) | `5082ca4e139a4d500525c54a25039a46574e1288` | Oct 11 |
| Superwhisper-CLI | [superultrainc/superwhisper-cli-release](https://github.com/superultrainc/superwhisper-cli-release) | `d51a8812ebad74e67ca2f08258ceacd26f8461bd` | Jun 16 |

The old `braden-w/whispering` repository is archived and redirects to Epicenter. Hyprnote redirects to Anarlog; its community app remains MIT, while enterprise components have separate terms. Superwhisper's public CLI repository contains release documentation/install plumbing, not the private CLI or application source. No proprietary application source was available to clone or inspect.

Discovery used GitHub, official product sites, and searches for X posts. X results/profile access did not provide reliable recent evidence, so no X popularity ranking is claimed. GitHub's public API snapshot showed approximately 33.5k Handy stars, 21.9k Buzz, 9.5k Anarlog, 9.3k OpenWhispr, 6.7k VoiceInk, 4.8k Epicenter, and 1.6k Voxtype. Wisper is a small technical reference, not a demonstrated trend. These are discovery signals, not quality measurements. Raw metadata is in `.tmp/reference-github-metadata.json`.

## What the references offer

This is a scoped source/product review of relevant paths, not an exhaustive audit or an execution benchmark of every application.

| Reference | Architecture and useful differences | WinSTT decision |
| --- | --- | --- |
| OpenWhispr | Electron/React; local Whisper/Parakeet/Cohere plus its Orukeet route; notes, meeting transcription, speaker identity, semantic retrieval, assistant and selection-edit workflows. Its streaming design retains capture for recovery and applies explicit language routing. | Keep our ORT engines and native streaming worker/replay. Retained audio and one finalization/paste remain important invariants. Meeting retrieval and assistant panels are real product gaps, not a reason to replace the backend. |
| VoiceInk | Native Swift macOS application; whisper.cpp, FluidAudio Parakeet and transcribe.cpp paths; contextual modes, correction learning, and versioned vocabulary portability. | Adopt portable vocabulary behavior through our own implementation. Recognize its current version 1 dictionary archive. Preserve our cross-platform schema and explicit replacement rules. |
| Voxtype | Rust Linux daemon/TUI; multiple inference backends, CUDA/MIGraphX/TensorRT/OpenVINO feature combinations, compositor-specific output. Streaming events distinguish tentative text, final text, replacement and completion. Its source documents model-specific EP limitations. | Keep capability-driven streaming and existing commit/preview behavior. Do not adopt a blanket GPU preference or final-only output policy. Investigate additional providers only on relevant hardware with matched-model measurements. |
| Whispering / Epicenter | Current app is in a larger local-first monorepo; portable data and configurable transformations. Transformation requests have explicit endpoint boundaries and conservative handling of uncertain outcomes. | Adopt redirect rejection for cloud API uploads. Keep our separate transcript/cleanup stages and generated IPC. Data portability is useful; wholesale monorepo/storage migration is not justified. Current app license is AGPL, unlike the older MIT repository. |
| Anarlog | Tauri/Rust meeting notepad; local SQLite/files, separate transcription and intelligence choices, editable notes, summaries and chat. VAD chunking carries preroll and merges short neighboring speech. | Our listen/diarization gives us a foundation, not equivalent meeting notes. Do not tune away short dictation with meeting-oriented VAD thresholds. Meeting documents and retrieval need an explicit product/storage design. |
| Wisper | Compact Tauri/Rust dictation using whisper.cpp; dictionary/replacements, local history, meeting capture and optional cleanup. | Useful small reference. Our existing preroll, VAD, engine policy and streaming are already more involved; its simpler implementation does not establish a performance advantage. |
| Buzz | Python/Qt app focused on media transcription; multiple Whisper backends, speech separation, subtitle viewer/editing, watched folders and scripting. | WinSTT already exports TXT/SRT/VTT and queues files. Folder watching, subtitle editing and optional speech separation are genuine additions, but they need queue/resource/UX design or workload measurements. |

Relevant source paths reviewed include OpenWhispr's `docs/orukeet-streaming.md` and `scripts/lib/download-utils.js`; VoiceInk's `Features/Dictionary/Workflows/DictionaryArchive.swift`; Voxtype's `src/transcribe/streaming.rs` and `Cargo.toml`; Epicenter's `apps/whispering/src/lib/transformation.ts`; Anarlog's `crates/audio-chunking/src/vad/{session,chunk_policy}.rs`; Wisper's `src-tauri/src/stt.rs`; and Buzz's file/model workflow and README.

VoiceInk's GPL and current Whispering's AGPL implementations were treated as references. No implementation was copied from them. Vocabulary support is independently written against the documented/exported data shape.

## Changes adopted now

**Dictionary and snippet portability.** Both settings sections now have Import and Export controls. Import accepts WinSTT version 1 archives and typed JSON arrays, CSV with headers or positional columns, and dictionary word lists. Dictionary import also accepts VoiceInk's `voiceink.dictionary` schema version 1: vocabulary terms and each replacement source become WinSTT entries. Explicit replacement rules take precedence over redundant plain vocabulary within that incoming archive.

Parsing handles UTF-8 BOM, CRLF/LF, escaped quotes, commas and multiline expansions. Validation uses the existing renderer schemas and UTF-8 limits. The entire file must validate before one store update; files are capped at 20 MiB, dictionaries at 2,000 entries and snippets at 1,000. Merge reads the live store after file IO, keeps existing rules, deduplicates case-insensitively and reports added/skipped counts. New IDs are generated locally. Import uses the existing settings persistence path and save-error handling.

Export uses generated `commands.settingsExportVocabulary` and a native save dialog restricted to the settings window. It validates and re-serializes only dictionary/snippet fields, excluding arbitrary settings fields. The versioned JSON archive preserves expansion whitespace and provenance. No global settings, credentials, model choices or streaming policy are changed by vocabulary import. UI strings were added in all 20 shipped locales.

**Complete model pinning in the streaming downloader.** The previous resolver pinning did not cover `DownloadManager`'s direct HTTP streamer. That path still requested `resolve/main`, seeded progress from mutable metadata, and verified the server's ETag. It now requests the same curated commit as the resolver, rejects a mismatching returned commit, checks files against the shipped size/SHA inventory, and refuses unlisted files in curated repositories. Custom repositories retain their existing behavior. Pinned downloads do not rewrite `refs/main`. Progress sizes also use the actual quantization's repository/pinned inventory, removing a metadata round trip for curated models and fixing incorrect totals for per-quant repository overrides.

**Cloud API endpoint boundaries.** WinSTT already refused redirects when fetching validated untrusted URLs, such as voice previews. Its shared cloud API client still followed redirects. It now rejects redirects with an actionable endpoint error, preventing 307/308 from replaying a speech/text upload at another URL. The credential probe also reuses this pooled client. Download clients remain separate and support normal Hub/CDN redirects. Custom API endpoints that depended on a redirect must be configured with their final URL. This is an independently implemented request-boundary rule, not copied transformation code.

**Repeatable references and accurate comparisons.** Added the safe reference sync tool and corrected the public comparison page's stale model count, unsupported generic competitor claims, pricing generalizations and audio-retention description. Existing test-only IPC mock extras are now typed explicitly so the broader test typecheck works; production string-channel IPC was not restored.

These additions do not alter the native streaming protocol, partial emission cadence, audio callback, decode options, GPU selection, CPU recovery or finalization/paste sequence from the earlier reliability work.

## Superwhisper and other closed products

Superwhisper's [changelog](https://superwhisper.com/changelog) currently shows macOS 2.19.2 on October 5. The default page describes macOS; it is not evidence that Windows has every listed feature. Recent work includes microphone startup, paste recovery, realtime audio fixes and CSV portability. WinSTT already has volume-relative ducking, preroll/VAD, retained streaming state and receipt-based Windows paste; these overlap and still need native runtime comparisons.

Its [CLI/MCP announcement](https://superwhisper.com/blog/cli-mcp) describes history search/export, stats, vocabulary/snippet management and agent workflows. That is a real automation gap: WinSTT's headless file-transcription CLI and UI history are not equivalent. The public [CLI release repository](https://github.com/superultrainc/superwhisper-cli-release) says its source is private and describes macOS binaries; the marketing page alone does not establish Windows CLI parity.

Its [S1 announcement](https://superwhisper.com/blog/s1) introduces cloud speech/cleanup and a small local cleanup model. **WinSTT already integrates S1-mini** as the recommended Ollama cleanup option `hf.co/superwhisper/s1-mini-GGUF:Q4_K_M`. The catalog identifies its English-only specialization; the dictation and warmup paths use its exact system/control prompt, disable thinking, use greedy decoding and preserve streamed plain-text output. They omit generic cleanup instructions and structured side-effect requests. See [catalog](../../src/entities/llm-catalog/lib/recommended-models.ts), [request builder](../../src-tauri/src/winstt/llm/ollama_request.rs) and [dictation integration](../../src-tauri/src/winstt/managers/llm_manager/ollama_chat.rs). [S1-mini's model card](https://huggingface.co/superwhisper/s1-mini) recommends limited input length. Quality and latency evaluation on our workloads remains useful; adding another integration is unnecessary. Its custom license/naming clause also needs consideration before redistribution. Vendor benchmark numbers are not WinSTT measurements. WinSTT already ships Cohere; that announcement alone adds no missing engine.

[Scribe v2 Realtime](https://superwhisper.com/blog/scribe-v2) is another provider comparison candidate. A cloud streaming adapter should preserve language coverage, cancellation, retained audio and exactly-one final delivery. Introducing a subscription/cloud default is not needed to improve our local path.

[Wispr Flow](https://wisprflow.ai/) emphasizes contextual rewriting, vocabulary/snippets, mobile/desktop continuity and a notetaker. [Aqua Voice](https://aquavoice.com/) emphasizes realtime contextual dictation and coding. We already have related context/cleanup features, but equivalence in quality is unmeasured. Their speed claims cannot be compared to our local decode benchmarks without matched audio, hardware and measured endpoint-to-paste latency. Their application source was not available in the reviewed official material.

## Choices to evaluate before adoption

1. **Small specialized local cleanup:** S1-mini is already a visible recommended option with a dedicated request path. Benchmark it against other local cleanup models on names, code, corrections and long passages, including Arabic/English mixing to assess its English-only limitation. Decide whether to change recommendations or defaults using those measurements.
2. **History CLI/MCP:** start with read-only bounded search/export if agent workflows are wanted. Decide which fields/audio are exposed, explicit access boundaries, and whether writes to vocabulary are allowed. A general agent execution/screenshot workflow is a separate choice.
3. **Meeting workspace:** decide whether Listen should evolve into persistent meeting documents, speaker identity, notes/templates, cross-meeting retrieval and summaries. OpenWhispr/Anarlog have a real lead in this workflow. We should reuse our capture/diarization rather than graft in their whole storage/UI.
4. **Hardware-specific inference:** evaluate MIGraphX, TensorRT, Intel NPU/OpenVINO, GGUF/Vulkan or alternative Apple backends with the same model/precision and task. Include startup, warm latency, p95 stop-to-paste, RAM/VRAM, installer/runtime size, transcript quality and crash recovery. Additional backends are not universal wins.
5. **Media workflows:** prioritize watch folders/subtitle editing if file transcription is central. Speech separation needs a noisy-audio quality/runtime comparison; extra preprocessing can harm clean speech and increase latency.
6. **Cloud providers/mobile/sync:** treat these as opt-in product expansions, with their cost and storage implications, rather than prerequisites for reliable local dictation.

## Validation

The new parser/UI tests cover atomic rejection, merge behavior, quoted/multiline CSV, BOM/CRLF, VoiceInk conversion, schema-version/kind checks, expansion whitespace, UTF-8/collection limits and generated-binding export. Rust tests cover export field stripping/validation, curated pin metadata/unlisted-file rejection, and actual local HTTP 307/308 responses whose redirect targets receive no connection.

- `bun run precommit`: passed lockfile, lint, application/Node typechecks and cycle checks.
- `bun run prepush`: passed **5,171 frontend tests**, dead-code checks and Rust formatting/all-target Clippy. The later API-boundary change is validated separately by the final Rust suite/gate.
- `bun run typecheck:tests`: passed after correcting the existing test-only mock's extra-export typing.
- `bun run check:i18n`: all 20 locales have exact key parity. Its existing English-equal translation backlog remains; the new controls have localized strings.
- Full Rust unit suite after the API change: **1,831 passed, 12 existing ignored**.
- Final `bun run check:rust`: passed formatting and all-target Clippy with warnings denied.
- Docs production build and typecheck: passed.
- Reference sync: all nine checkouts updated safely; the local playground preserved.

No competitor binaries were installed or benchmarked. Native import/save dialogs, macOS paste behavior, physical microphone startup and comparative model accuracy remain runtime evaluation work, not claims established by the unit tests. Changes remain uncommitted.
