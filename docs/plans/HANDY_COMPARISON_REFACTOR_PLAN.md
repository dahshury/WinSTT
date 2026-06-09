# Handy Comparison Refactor Plan

Date: 2026-06-08

## Scope

This plan compares the Tauri WinSTT codebase against `examples/handy`, with Handy used as the smaller reference for consistency, command shape, folder boundaries, and runtime simplicity. Handy is not the target architecture for every layer: WinSTT's frontend FSD split is more scalable than Handy's bucketed UI structure, while Handy's backend command and manager footprint is the useful contrast.

## Baseline Measurements

- WinSTT `src`: about 835 code files and 117,627 lines.
- WinSTT `src-tauri/src`: about 239 code files and 90,096 lines.
- WinSTT `packages`: about 166 files and 27,026 lines.
- WinSTT `messages`: about 20 files and 23,180 lines.
- Handy `src`: about 143 files and 23,152 lines.
- Handy `src-tauri/src`: about 48 files and 12,092 lines.

The size gap is expected because WinSTT has more engines, diagnostics, settings, and migration code. The problem is not size alone; the problem is parallel patterns, duplicated IPC routing, broad permission surfaces, generated files in source control, and modules that have kept growing after the port.

## Findings

### Keep From WinSTT

- The `app/views/widgets/features/entities/shared` frontend split is a better long-term shape than Handy's flatter `components` and `stores` buckets.
- Generated TypeScript command bindings are valuable and should remain the source for typed backend IPC.
- The current Tauri CSP and asset protocol posture is already stricter than Handy's permissive defaults.
- Model catalogs, diagnostics, and STT/TTS domain depth justify a richer backend than Handy's.

### Highest-Risk Debt

- Tauri permissions are broad across windows. Low-trust or narrow-purpose windows inherit capabilities that should be limited to specific labels.
- Some debug/context-inspection commands remain available through the normal command registry. Raw UIA/context snapshots should be compiled out or gated behind an explicit dev-only runtime policy.
- Settings mutation is too coarse. Whole-section writes make validation, caller authorization, and auditability harder.
- Native IPC has multiple routing layers: generated commands, `COMMAND_INVOKERS`, and the native bridge route map. This creates drift and forces special cases.
- Startup wiring is concentrated in large functions and many global managed states, which makes missing state registration hard to detect.
- Several modules exceed a maintainable size and mix orchestration, validation, persistence, and command mapping.

### Dead Code And Bloat

- Tracked local artifacts existed in `.coverage` and `.playwright-cli/page-*.yml`; these should stay ignored.
- Generated build output such as `dist/`, `output/`, logs, and cargo targets should remain out of source control.
- Old Handy-era resources are deletion candidates when source references and package globs prove they are unused.
- Tauri icon folders contain platform assets not referenced by current `tauri.conf.json`; prune only after verifying installer, MSIX, and store packaging requirements.
- Dependency candidates for audit include `tauri-plugin-process`, `tauri-plugin-fs`, direct `windows-core`, and duplicate audio transitive dependencies. Remove only one at a time with a lockfile diff and build check.

## Action Plan

### Phase 0: Guardrails And Hygiene

- Keep `bun run check:deadcode --reporter compact` green and add it to CI if it is not already enforced.
- Keep `bun run typecheck` as the frontend gate for IPC wrapper changes.
- Ignore and remove local test/coverage artifacts from source control.
- Add a repo-local architecture note defining acceptable imports for `shared/api`, FSD public APIs, and raw Tauri access.

### Phase 1: Tauri Security And Capability Tightening

- Split Tauri capabilities by window label. Main, settings, overlay, quick picker, diagnostics, and updater surfaces should not share one broad default set.
- Add backend caller-label authorization for sensitive commands: settings writes, updater install, window management, file opening, model deletion, context capture, and diagnostics.
- Compile out or hard-disable context playground raw snapshot commands in release builds.
- Replace coarse `winstt_set_settings` use with narrower validated mutators for high-risk settings such as model paths, external endpoints, global shortcuts, downloads, and autostart.
- Keep the asset protocol scoped to bundled resources unless a specific renderer consumer proves it needs additional paths.
- Standardize download integrity checks so all curated model and wakeword assets have catalog-backed hashes or signatures.

### Phase 2: IPC Simplification

- Make generated bindings plus small domain wrappers the normal path for frontend calls.
- Retire duplicate command routing in stages: first remove unused `COMMAND_INVOKERS`, then shrink the native bridge route map to compatibility-only cases.
- Move every raw `invoke` or plugin call behind `src/shared/api/ipc/*`, except generated binding code.
- Normalize event names into one manifest with backend names, frontend names, payload types, and owner slice.
- Install the native bridge once during app bootstrap instead of from multiple React entry points.

### Phase 3: Backend Shape

- Split `lib.rs` startup into bootstrap modules: app construction, managed state construction, plugin setup, window setup, tray setup, and post-start tasks.
- Replace one central command registry file with feature-owned command registration modules plus a generated or tested aggregate.
- Add a command coverage test that fails when a Tauri command exists but is not registered or deliberately excluded.
- Move shared history/audio/model operations behind domain services so commands become thin validation and authorization layers.
- Make internal settings reads fail closed on secret-store errors, while exposing separate masked renderer-safe reads.

### Phase 4: Frontend Organization

- Keep FSD, but document that `views` are the window/page layer and `entries` are runtime entrypoints.
- Remove feature-to-feature imports by moving orchestration to `views` or a neutral shared/entity API.
- Export entity APIs through explicit `index.ts` files where deep imports are stable public contracts.
- Split the largest UI/model modules by responsibility: state, command calls, derived view model, and rendering.
- Keep narrow slice barrels; do not copy Handy's broad component barrel pattern.

### Phase 5: Size Reduction

- Delete verified-unused generated artifacts and old Handy resources.
- Collapse duplicate tray and icon assets only after current tray and packaging consumers are mapped.
- Audit dependency removals one at a time with `cargo check`, `cargo tree`, `bun run typecheck`, and lockfile review.
- Move large benchmark fixtures or generated catalogs out of normal source paths where possible, or document why they are intentionally checked in.
- Track a module-size budget and review any new Rust or TypeScript file above 600 lines unless it is generated data.

### Phase 6: Verification

- Add tests around settings validation, command authorization, and registry completeness.
- Add integration tests for IPC wrapper coverage and event payload shape.
- Run Windows helper builds for release confidence: `tools\windows\cargo-env.bat check` and `tools\windows\tauri-build.bat`.
- Use the app/browser smoke tests for settings, overlay hit regions, model downloads, transcription, and updater flows.

## Workstream Split

- Security worker: Tauri capability split, caller-label checks, context playground gating, updater restrictions.
- IPC worker: raw invoke removal, generated wrapper consolidation, event manifest, native bridge bootstrap.
- Backend worker: startup split, command registry coverage, manager/service boundaries, secret fail-closed behavior.
- Frontend worker: FSD import cleanup, large module splits, public API exports, route/window ownership docs.
- Bloat worker: tracked artifact cleanup, resource/icon packaging audit, dependency pruning, benchmark fixture policy.

## Completed In This Pass

- Removed tracked `.coverage` and `.playwright-cli/page-*.yml` generated artifacts.
- Added `.coverage` and `.playwright-cli/` to `.gitignore`.
- Removed unused TypeScript exports reported by Knip.
- Replaced the overlay's raw `@tauri-apps/api/core` invocation with a typed shared IPC wrapper.

## Capability Split Audit

Worker pass: 2026-06-08.

- Reduced `src-tauri/capabilities/default.json` to a shared baseline for every WinSTT window: `core:default` plus `os:allow-locale` for first-launch locale detection.
- Moved renderer-side plugin access into role-specific capabilities: `settings.json` for dialog/opener/clipboard/startup/updater/platform permissions, `tray-menu.json` for update checks, `history.json` for clipboard-write fallback, and `desktop.json` for main-window controls.
- Removed renderer plugin access from the overlay, model picker, device picker, onboarding, splash, and context playground windows.
- Left `store:default` and `process:default` unassigned because frontend scans found no direct renderer imports. Rust backend plugin usage is unaffected by renderer capabilities.
- Deferred tighter `core:default` reduction because `HtmlLang` still installs the native bridge in every window; split it after the IPC bootstrap worker narrows bridge installation and event/listen requirements.

## Resource/Dependency Bloat Audit

Worker pass: 2026-06-08.

- Deleted old mobile/store icon outputs not referenced by `src-tauri/tauri.conf.json`, source, or current desktop bundle targets: `src-tauri/icons/android/`, `src-tauri/icons/ios/`, `src-tauri/icons/logo.png`, `src-tauri/icons/StoreLogo.png`, and `src-tauri/icons/Square*Logo.png`.
- Deleted `src-tauri/resources/handy.png`; it was byte-identical to `resources/tray_idle.png`, not read by `src-tauri/src/tray.rs`, and the icon generator no longer recreates it.
- Kept direct `windows-core = 0.61.2`: a removal attempt failed `tools/windows/cargo-env.bat check` because `#[implement(IMMNotificationClient)]` in `src-tauri/src/winstt/audio_device_watcher.rs` expects `windows_core` to be a directly imported crate.
- Deleted `src-tauri/resources/default_settings.json` and removed the `resources/*.json` bundle glob. Defaults are constructed in Rust (`src-tauri/src/settings/store.rs`), and no remaining packaged JSON resource is required.
- Removed stale generated app icon outputs `src-tauri/icons/64x64.png` and `src-tauri/icons/icon.png`; the generator now emits only the icons referenced by `tauri.conf.json`.
- Deferred `tauri-plugin-fs` and `tauri-plugin-process`: frontend scans show no direct plugin imports, but removal requires coordinated edits to `src-tauri/src/lib.rs` and `src-tauri/capabilities/default.json`, which are owned by other workstreams.

## Asset Protocol Scope Audit

Worker pass: 2026-06-08.

- Removed `$APPDATA/**` from `app.security.assetProtocol.scope.allow`; the webview can no longer serve arbitrary WinSTT app-data files through `asset:` or `http://asset.localhost`.
- Kept `$RESOURCE/**` because bundled resources remain the only configured asset-protocol scope and are lower sensitivity than user data.
- Source scans found no renderer `convertFileSrc`, `asset://`, or `http://asset.localhost` construction. History playback uses backend data-URI commands, and sound previews read bytes through backend IPC, so recordings and custom sounds do not require asset-protocol access.
- Further tightening can disable the asset protocol entirely after a packaged-app smoke test proves no hidden resource consumer depends on it.
