# Changelog

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
