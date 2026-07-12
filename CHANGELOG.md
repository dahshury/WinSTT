# Changelog

## [0.1.3-alpha.6] - 2026-07-12

Changes since `v0.1.3-alpha.5`.

### Added

- Added hover model-spec cards across the STT, TTS, LLM, and Ollama pickers, backed by a shared `ModelSpecCard`/`ModelSpecHoverCard`, per-source spec builders, and a models.dev catalog integration for cloud/LLM metadata.
- Added a Listen-mode output-device picker surfaced as a footer chip, a detached picker window, and a recording-sound preview button, with device enumeration and hooks under `features/listen-mode`.
- Added dedicated settings-warning and LLM-settings-notice surfaces so hydration, capability, and provider issues are shown inline instead of failing silently.
- Added a dictionary context control and an encoder-dictionary workspace index, replacing the previous phonetics path.
- Added a modifier-only push-to-talk hotkey toast and a recording-mode settings command for clearer mode configuration.
- Added catalog/model-info and cloud-STT parity fixtures with matching frontend parity tests to keep the Rust catalog and the renderer in lockstep.

### Changed

- Completed the ESLint-to-Biome migration: removed `eslint.config.js` and the remaining ESLint dependencies, replacing the i18n JSX guard with a standalone `tools/i18n/check-no-literal-string.ts` scanner wired into `bun run lint`.
- Enriched the model pickers and switching UI with a switching quant badge, shared combobox-base primitives, a host-platform helper, and a performance-color utility.
- Refreshed backend catalog data, cloud STT, loopback capture, TTS, download, and command plumbing while keeping generated Tauri bindings in sync.

### Fixed

- Fixed model-picker, listen-mode device, settings-hydration, and cloud key-removal-revert edge cases covered by the expanded frontend and Rust test suites.

### Maintenance

- Bumped the application version from `0.1.3-alpha.5` to `0.1.3-alpha.6` while keeping the alpha release policy.

## [0.1.3-alpha.5] - 2026-07-08

Changes since `v0.1.3-alpha.4`.

### Added

- Added context-aware dictation: caret-split reading with a proximity-bounded visible window, a workspace index and file-reference resolver, generic UIA field context, and shared context terms so instructions route as content vs. commands instead of being echoed verbatim.
- Added a tray-indicator surface (third floating window) with a recording-mode pill and a PTT-plus-arrow mode-cycle gesture wired through the low-level hook.
- Added cloud STT provider support with per-run cloud metrics/cost tracking, a cloud selected-summary, cloud error surfacing, and automatic offline-to-local fallback and key-removal revert.
- Added new LLM→codec TTS engines (Orpheus, Spark, Qwen3-TTS voice-design) alongside shared token sampling, plus an STT fallback path.
- Added a full-fidelity clipboard snapshot, a pinned-foreground action, and a native networking module for the backend.
- Added Ollama thinking/lite-model catalog helpers, model-search fuzzy matching, saved-secret settings schema, and expanded onboarding/model-picker coverage.

### Changed

- Ported the wakeword detector from sherpa-onnx to a native ORT detector, removing the sherpa detector path.
- Migrated linting/formatting from Prettier + ESLint to Biome/Ultracite, dropping `.prettierrc`/`.prettierignore` and slimming ESLint to i18n-only checks.
- Reworked settings, model picker, tray, overlay, history, TTS, LLM, and Ollama UI and refreshed docs, screenshots, and demo assets to match the current app.
- Refreshed backend audio, STT, TTS, download, history, and command plumbing while keeping generated Tauri bindings in sync.

### Fixed

- Fixed context-leak edge cases (whole-inbox/OTP bleed into before-caret) with proximity bounds and on-screen range clamping, plus additional PTT, model-selection, overlay, and history edge cases.

### Maintenance

- Bumped the application version from `0.1.3-alpha.4` to `0.1.3-alpha.5` while keeping the alpha release policy.
- Applied Dependabot updates: `@babel/core` `7.29.7` → `8.0.1` and `@playwright/test` `1.61.0` → `1.61.1`, refreshing `bun.lock`.

## [0.1.3-alpha.4] - 2026-07-03

Changes since `v0.1.3-alpha.3`.

### Added

- Added a reusable input-device selector and device-picker window coverage for the recording and device-picker flows.
- Added model author/provider usage analysis and a model-author radar view for transcription history.
- Added post-processing profile swap helpers and expanded LLM/settings coverage for provider configuration, modifier presets, and processing extras.

### Changed

- Refined settings, model picker, shortcut, tray, overlay, diagnostics, updates, transcription-history, and data-grid UI behavior.
- Reworked backend audio, STT, TTS, file-transcribe, download, history, settings, window-placement, and command plumbing while keeping generated Tauri bindings in sync.
- Moved the Rust crate to edition 2024 and refreshed dependency pinning, lockfile checks, and cargo-deny policy.
- Updated release verification examples and app metadata for `0.1.3-alpha.4`.

### Fixed

- Fixed additional audio-device, push-to-talk, model-selection, snippets, history, tray-menu, and processing-extra edge cases covered by the expanded test suite.
- Fixed updater/about diagnostics presentation and restart/status messaging across localized settings strings.

### Maintenance

- Bumped the application version from `0.1.3-alpha.3` to `0.1.3-alpha.4` while keeping the alpha release policy.

## [0.1.3-alpha.3] - 2026-07-01

Changes since `v0.1.3-alpha.2`.

### Added

- Added Qwen3-ASR local STT support with `qwen3-asr-0.6b` and `qwen3-asr-1.7b` int4 ONNX catalog entries, resolver globs, engine routing, tokenizer/prompt handling, and a smoke-test binary.
- Expanded the STT catalog to 73 shipped models across 11 families, including Granite Speech 4.1 2B Plus/NAR, Qwen3-ASR, Dolphin, and additional native streaming NeMo/Nemotron/Parakeet variants.
- Added dynamic Ollama library discovery, tag browsing, local model capability/context metadata, and richer pull progress handling so newly available Ollama models can be found and installed from inside the app.
- Added a model-footprint window and runtime resource breakdown surfaces for installed/loaded models.
- Added shared toast, brand-logo, entry-card-list, data-grid, and picker primitives used across settings, model selection, history, and diagnostics.

### Changed

- Overhauled the local, cloud STT, TTS, OpenRouter, and Ollama model picker flows with better filtering, favorites, quantization shelves, hardware-fit chips, and delete confirmations.
- Reworked LLM cleanup and transform settings around provider-specific model selection, warmup status, credentials, OpenRouter fallbacks, and safer cloud-key removal behavior.
- Improved TTS download/model selection flows across local and cloud providers, including shared download progress helpers and clearer installation states.
- Refactored settings persistence, settings sync, context capture, cleanup, diagnostics, and backend command organization while preserving generated Tauri command bindings.
- Updated the public docs to describe the 73-model / 11-family catalog, Qwen3-ASR support, Granite/Dolphin additions, and dynamic Ollama model discovery.
- Updated release verification examples and app metadata for `0.1.3-alpha.3`.

### Fixed

- Fixed stale local model selections through catalog id migration, including the Granite Speech 4.1 2B to 2B Plus replacement.
- Fixed Ollama pull progress rendering so high-frequency NDJSON frames no longer stall model-picker navigation.
- Fixed cached partial Ollama pulls so saved progress can appear immediately after reopening the renderer.
- Fixed OpenRouter catalog-scan failures so they report consistent user-visible issues for LLM, STT, and TTS scans.
- Fixed cleanup, audio, push-to-talk, recording-sound, transcript-preview, history, and overlay edge cases covered by the expanded tests.

### Removed

- Removed the old diarization pipeline and speaker-color/speaker-text frontend surfaces.
- Removed legacy shared CRUD/table components in favor of the new shared data-grid primitives.

### Maintenance

- Bumped the application version from `0.1.3-alpha.2` to `0.1.3-alpha.3` while keeping the alpha release policy.
- Included upstream dependency maintenance after the last release: `actions/checkout` pin updates, Cargo minor patch updates, and the `sysinfo` patch bump.
