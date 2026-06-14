# LOC Reduction Execution Plan

Date: 2026-06-08

## Decision

This replaces the earlier broad identification plan with an execution-focused cleanup plan. The old plan was useful as an inventory, but it mixed proven cleanup with speculative "maybe consolidate" ideas. This version keeps only work that is either already proven by references, safely gated by tests, or useful as a narrow investigation before deleting code.

The goal is net-negative source and repository bloat without breaking behavior.

## Removed From The Old Plan

These parts were cut because they were too broad, redundant, or not a safe LOC reduction path:

- Directory-by-directory "consider consolidation" bullets for small FSD slices. Small explicit slices are acceptable when ownership is clear.
- Generic hook/factory suggestions that did not prove at least two active call sites would disappear.
- Broad backend folder reshuffling between `src-tauri/src/commands` and `src-tauri/src/winstt/commands` without a deletion target.
- "Move generated files" as a LOC win by itself. Generated/data-like files should be labeled and excluded from handwritten complexity scoring, but moving them only to improve metrics is not cleanup.
- Manual consolidation of locale JSON, TTS engine implementations, and STT engine implementations.
- Release gating work such as `context_playground` unless a security/build policy issue is proven. It is not a LOC cleanup task by default.
- Docs, Nix, and Windows packaging reductions without concrete duplicate inputs/outputs. Tooling stays unless a specific stale artifact is proven.

## Non-Negotiable Guardrails

- Do not delete tests that protect active behavior.
- Do not create a shared abstraction unless it removes real duplication across active call sites.
- Every source delete needs a reference scan plus a relevant typecheck/test/smoke gate.
- Every backend command delete needs frontend command scan, generated binding check, and command registry coverage.
- Every resource delete needs `rg` reference checks plus Tauri bundle/build validation when packaging references change.

## Current Evidence

Confirmed from the current worktree:

- `findProviderRowIndex` is used only inside `packages/model-picker/src/lib/model-list-content-virtualized-utils/scroll.ts`.
- `windowOpenDevicePicker` has no references outside `src/shared/api/ipc/stt-audio.ts`.
- `src-tauri/tauri.conf.json` references only desktop bundle icons: `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, and `icon.ico`.
- `src-tauri/tauri.conf.json` still packages `resources/*.png`, `resources/*.wav`, and `resources/models/**/*`; it no longer packages `resources/*.json`.
- eSpeak NG is installed on demand under `%LOCALAPPDATA%/winstt/tts/runtime/espeakng_loader`; the tracked `src-tauri/resources/espeakng_loader/` copy is not referenced by code or bundled by Tauri.
- The active scripts for validation are in `package.json`: `typecheck`, `lint`, `check:deadcode:*`, `test:src:*`, and `test:packages`.
- Root CSV/TXT scan outputs are generated working artifacts, not product source.
- App/context menu wrappers, STT server lifecycle request wrappers, and window telemetry subscription wrappers had no active Tauri callers.
- Legacy root command modules under `src-tauri/src/commands/{models,history,transcription}.rs` were redundant after the `winstt::commands::*` registry became the registered backend command surface.
- `LlmWarmupStatus`/`LlmWarmupOutcome` local DTOs duplicated generated Specta bindings.

## Executed In This Pass

These items were kept from the old plan and executed because they were reference-proven and testable.

| Task | Action | Validation |
| --- | --- | --- |
| Generated audit artifacts | Ignored and deleted root scan outputs such as `tmp_*`, `frontend_*`, `backend_*`, `packages_tracked_*`, `docs_tracked_*`, `tauri_*`, `ref_*`, `large_files.txt`, and `transport_command_call_counts.csv` | `git status --short`; source tests not required |
| Frontend dead exports | Made single-module helpers private and removed unused filter-menu helper exports | `bun run check:deadcode:exports`; `bun run typecheck`; `bun test ./packages` |
| Frontend dead wrapper | Removed `windowOpenDevicePicker` because no caller imports it | `rg "windowOpenDevicePicker"`; `bun run typecheck` |
| IPC wrapper cleanup | Removed unused app/context menu wrappers, STT server lifecycle request wrappers, and window telemetry wrapper; moved simple history/STT/TTS routes to generated command dispatch | `bun test src/shared/api/ipc-client.test.ts src/shared/api/ipc-client.fallbacks.test.ts src/shared/api/route-coverage.test.ts`; `bun run typecheck` |
| Warmup DTO dedupe | Re-exported generated warmup DTOs instead of maintaining local duplicates | `bun run typecheck`; targeted warmup tests |
| Legacy command modules | Deleted redundant `src-tauri/src/commands/{models,history,transcription}.rs` and removed their registry entries after binding regeneration | `tools\windows\cargo-env.bat test export_bindings`; `tools\windows\cargo-env.bat test tauri_command_definitions_are_registered_or_explicitly_excluded`; `tools\windows\cargo-env.bat check --all-targets` |
| Unbundled eSpeak resource copy | Deleted `src-tauri/resources/espeakng_loader/`; runtime install path is app data, not Tauri resources | `rg "resources/espeakng_loader|src-tauri/resources/espeakng_loader"` for active refs; `bun run tauri -- info` |
| Tauri icons/resources | Kept stale deleted mobile/store icons and stale unreferenced resources out of the active bundle path | `rg` resource refs; `bun run tauri -- info` |

## Kept High-Value Work

These remain in the plan, but they must be done in small patches with proof before deletion.

### 1. IPC Surface Reduction

Partially executed in this pass. Keep the remaining work because it is still the largest proven frontend bloat cluster:

- `src/bindings.ts`
- `src/shared/api/native-bridge-adapter.ts`
- `src/shared/api/ipc-channels.ts`
- `src/shared/api/ipc-transport.ts`
- `src/shared/api/ipc/*`

Execution rule:

1. Add or keep route coverage that classifies channels as generated command, compatibility route, event, plugin/window route, or retired.
2. Remove compatibility wrappers only after production `rg` finds no caller.
3. Prefer generated commands plus small domain wrappers.
4. Do not delete event/channel constants until listener and emitter scans are clean.

Remaining concrete targets:

- Identify `COMMAND_INVOKERS` entries that simply call generated commands with no translation.
- Collapse repeated `invokeOrDefault(IPC.X, fallback, args)` wrappers only when the wrapper has no domain-specific decoding.
- Retire remaining domain routes one group at a time: audio, model download, LLM/TTS, updater/window.
- Keep the small compatibility wrappers that normalize fallback values, event payloads, or legacy parity shapes.

### 2. Legacy History Retirement

Keep this because two history shapes are expensive to maintain, but treat it as a gated migration:

1. Find all frontend callers of legacy history channels.
2. Move active UI callers to the SQLite row API.
3. Delete legacy persisted-store history commands only after tests and playback smoke pass.

Validation:

- `bun run test:src:widgets`
- `bun run test:src:entities`
- history playback smoke
- backend helper check when command code changes

### 3. Legacy Download Singleton Retirement

Keep this because model download state is repeated across model-download and swap-model paths.

Execution rule:

1. Prove all active backend download events include enough model/quantization identity.
2. Remove singleton fallback state from frontend stores only after event callers are migrated.
3. Validate model picker progress, pause/resume/cancel, and swap gate behavior.

Validation:

- `bun run test:src:features`
- `bun run test:packages`
- model picker smoke

### 4. Model Picker Consolidation

Keep this only for repeated UI primitives that are already duplicated across STT, TTS, Ollama, and OpenRouter selectors.

Allowed targets:

- filter submenu builder
- card/list shell primitives
- favorite/provider trigger plumbing
- shared test harnesses

Rejected targets:

- provider-specific ranking logic
- catalog family metadata
- hardware-fit scoring unless two active implementations are proven equivalent

Validation:

- `bun run test:packages`
- targeted visual smoke for OpenRouter, Ollama, STT, and TTS picker flows

### 5. Tauri Resource And Generated-Data Policy

Keep this as a hygiene policy, not a blind move:

- Keep only icons referenced by `src-tauri/tauri.conf.json` and current package targets.
- Keep `resources/*.png`, `resources/*.wav`, and `resources/models/**/*` while Tauri bundle config requires them.
- Do not keep a tracked `src-tauri/resources/espeakng_loader/` copy while runtime installation is app-data based and Tauri does not bundle that directory.
- Label data-heavy files as generated/data-like for maintainability reporting:
  - `src-tauri/src/winstt/stt/gigaam_v3_consts.rs`
  - `src-tauri/src/winstt/commands/catalog_data/catalog_data.json`
  - `src-tauri/src/winstt/settings_schema.rs`
  - `src/bindings.ts`
  - `messages/*.json`

## Deferred Or Policy-Dependent Work

Do not execute these as cleanup until a product or architecture decision exists:

- Deleting locales from `messages/`.
- Replacing STT/TTS engine implementations with descriptor tables.
- Dropping legacy settings migrations before a dated migration cutoff.
- Moving generated/data files solely to improve LOC charts.

## Parallel Workstreams

### Agent A: Artifact And Resource Cleanup

Scope:

- root scan outputs
- ignored generated folders
- Tauri icon/resource references

Deliverable:

- deleted generated artifacts
- `.gitignore` coverage
- resource reference audit

### Agent B: Frontend Dead Exports

Scope:

- Knip-reported unused exports
- reference checks
- narrow TypeScript validation

Deliverable:

- removed unused exports or made internal helpers private

### Agent C: IPC Reduction

Scope:

- command/channel classification
- wrapper removal candidates
- route coverage gaps

Deliverable:

- prioritized deletion candidates with exact validation before source edits

### Agent D: Backend/Resource Audit

Scope:

- Tauri config
- bundle resources
- command registry and backend command deletion candidates

Deliverable:

- safe source/config edits only when references prove they are stale

## Execution Order

1. Continue IPC reduction only where route coverage proves generated command parity.
2. Retire legacy persisted-store history after the SQLite history UI/API migration is complete.
3. Retire singleton download state only after model picker progress, pause/resume/cancel, and swap-gate behavior are covered.
4. Consolidate model-picker primitives only where duplicate active implementations disappear.
5. Keep every follow-up patch net-negative unless it is adding tests required for a later deletion patch.

## Validation Run

Latest pass:

- `tools\windows\cargo-env.bat test export_bindings`
- `tools\windows\cargo-env.bat test tauri_command_definitions_are_registered_or_explicitly_excluded`
- `tools\windows\cargo-env.bat check`
- `tools\windows\cargo-env.bat check --all-targets`
- `bun run typecheck`
- `bun run check:deadcode:exports`
- `bun test ./packages`
- `bun test src/shared/api/ipc-client.test.ts src/shared/api/ipc-client.fallbacks.test.ts src/shared/api/route-coverage.test.ts`
- `bun run tauri -- info`
- `tools\windows\tauri-build.bat`
- `git diff --check` (only a pre-existing CRLF notice in `packages/model-picker/src/stt/ui/SttFiltersMenu.tsx`)

## Acceptance Criteria

Each executed cleanup must report:

- files removed
- files changed
- net source direction
- tests/scans run
- skipped validation with reason
- behavior intentionally changed, if any

The bar for merging a cleanup is simple: less redundant code, no lost product behavior, and no new abstraction unless duplicate implementations actually disappear.
