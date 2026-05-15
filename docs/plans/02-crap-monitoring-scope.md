# CRAP Monitoring Scope & Reduction Plan

> **Status:** Decision proposal — 2026-05-15
> **Author:** Architect-mode synthesis
> **Goal:** Reduce CRAP score to ≤ 4 for all monitored production-critical code.

---

## TL;DR

The frontend has **2,552 functions** across **282 source files**. Today, **176 functions** exceed the CRAP ≥ 4 threshold (6.9% of all functions; the codebase distribution is 92.7% clean / 6.0% mild / 1.0% bad / 0.2% crisis).

CRAP ≤ 4 is **mathematically impossible** for any function with cyclomatic complexity ≥ 5, regardless of coverage. Pushing a strict ≤ 4 bar across all 282 source files would force artificial sub-component extraction in JSX trees that legitimately need many conditional branches (loading, error, empty, success states × N features).

**Decision: monitor only the parts that benefit from CRAP enforcement** — pure logic, IPC handlers, state stores, hooks, business utilities — and **exclude pure React rendering files**. The dispatcher's job is then twofold:

1. Extract logic-bearing functions (reducers, data transforms, validators) **out of** UI files into `lib/` / `model/` segments, where CRAP enforcement applies.
2. Get CRAP ≤ 4 for every function in the monitored scope by combining (a) refactoring to drop CC below 5 and (b) test coverage that pushes CRAP under the threshold for surviving CC 2-4 functions.

---

## Why CRAP ≤ 4 cannot be a universal rule

The CRAP formula is `CC² × (1 - cov)³ + CC`:

| CC | Min CRAP (100% cov) | Coverage needed for CRAP ≤ 4 |
|---|---|---|
| 1 | 1 | any |
| 2 | 2 | ≥ 21% |
| 3 | 3 | ≥ 52% |
| 4 | 4 | 100% |
| ≥ 5 | ≥ 5 | **impossible** |

So **any function with CC ≥ 5 must be refactored** to satisfy CRAP ≤ 4. This is fine for procedural logic, where high CC is almost always a smell, but it punishes React components whose CC is dominated by JSX-level conditionals and event handlers — splitting them often produces worse code (props drilling, lifted state for one consumer, fragmented mental model).

The architectural answer is *separation of concerns*: keep logic in `lib/` / `model/` (monitored), keep rendering in `ui/` (not monitored). When you find logic embedded in a `ui/` file, **move it**.

---

## Monitored scope (CRAP ≤ 4 enforced)

These layers contain logic that pays back rigorous coverage and complexity discipline:

### Always monitored

| Pattern | Rationale |
|---|---|
| `electron/**/*.ts` (excluding `*.test.ts`, `*.d.ts`, `native/`) | Electron main process is the security and reliability boundary — IPC handlers, WebSocket client, native bridges, OS interactions. Hard to recover from production bugs here; coverage and complexity discipline pay back. |
| `src/shared/api/**/*.ts` | Data flow integrity (IPC client, query client). |
| `src/shared/lib/**/*.{ts,tsx}` | Cross-cutting utilities used by everything. |
| `src/shared/i18n/**/*.ts` | Translation pipeline, config, fallbacks. |
| `src/entities/*/api/**/*.ts` | Entity persistence and remote access. |
| `src/entities/*/lib/**/*.{ts,tsx}` | Pure domain logic (word stats, model options, preset prompts). |
| `src/entities/*/model/**/*.ts` | State stores (Zustand) and selectors. |
| `src/features/*/api/**/*.{ts,tsx}` | Feature-level hooks (`use-*.ts`) and API integrations. |
| `src/features/*/lib/**/*.{ts,tsx}` | Feature business logic (animators, replacements, parsers). |
| `src/features/*/model/**/*.ts` | Feature state machines. |
| `src/widgets/*/lib/**/*.{ts,tsx}` | Widget logic (filters, helpers, hooks). |
| `src/widgets/*/model/**/*.ts` | Widget state, reducers (after extraction). |
| `electron/native/src/**/*.ts` | Native binding wrappers (TypeScript portion). |

### Explicitly NOT monitored (architectural exemption)

| Pattern | Rationale |
|---|---|
| `src/shared/ui/**` | Pure UI primitives (Button, Tooltip, Modal, FormControl, etc.). High CC here usually reflects render-state matrix, not algorithmic complexity. Visual regression and snapshot tests are the better tool. |
| `src/entities/*/ui/**` | Entity rendering — pure presentation of domain objects. |
| `src/features/*/ui/**` | Feature UI — JSX trees with event handlers. Already partly excluded (`ReactShaderToy.tsx`). |
| `src/widgets/*/ui/**` | Widget panels — large composite render trees. Logic must be extracted to `lib/`. |
| `src/views/**` | Top-level page composition. |
| `src/app/**` | Bootstrap, providers, layouts. |
| `test/**`, `**/*.test.{ts,tsx}` | Test infrastructure. |
| `spec/generated/**` | Generated OpenAPI types. |
| `scripts/**` | Build tooling. |
| `electron/native/bin/**` | Compiled native artifacts. |

### Excluded UI files MUST still satisfy a logic-leakage rule

A `ui/` file is allowed unbounded CRAP **only for rendering and event-handler glue**. Any of these belong in `lib/` / `model/` of the same slice (where CRAP IS enforced):

- Reducers (anything that takes state + action and returns new state)
- Data transformations (mapping/grouping/aggregating arrays)
- Validators, parsers, type guards
- Format functions (`formatBytes`, `formatDuration`, etc.)
- Selectors more complex than `s => s.x`
- Side-effecting helpers (storage, IPC, timers) that aren't React-rendering glue

Agents reducing CRAP must extract these from UI files first, then add tests to the extracted logic.

---

## Tooling change required

Today the CRAP analyzer treats `biome-linter-disabled` paths as its exclusion list (see `frontend/scripts/crap/analyzer.ts:37`). Adding broad UI-layer exclusions to biome would disable linting for those files, which we don't want.

**Action: introduce a separate `frontend/crap.ignore.json`** alongside `biome.jsonc`, listing the path patterns above. Extend `readBiomeLinterDisabledPaths()` (or add a sibling function) to merge both sources. This keeps lint enforcement decoupled from CRAP scope.

```jsonc
// frontend/crap.ignore.json
{
  "ignore": [
    "src/shared/ui/**",
    "src/entities/*/ui/**",
    "src/features/*/ui/**",
    "src/widgets/*/ui/**",
    "src/views/**",
    "src/app/**",
    "test/**",
    "spec/generated/**",
    "electron/native/bin/**"
  ]
}
```

The `--strict` flag in `crap.ts` then becomes a hard gate the dispatcher must drive to zero.

---

## In-scope offenders (work to be done)

These ~50 files have CRAP ≥ 4 functions within the monitored scope. Grouped by ownership for parallel dispatch:

### Group A — Electron IPC (renderer↔main boundary)
- `electron/ipc/stt-commands.ts` — `setupSttCommandHandlers>(anonymous)` CC=9 (worst offender, CRAP=73.85)
- `electron/ipc/llm.ts` — 12 offenders including `assertCustomPromptPayload` CC=5, several CC=2 with 0% coverage
- `electron/ipc/relay.ts` — `setupRelay>capture` CC=4, several handlers
- `electron/ipc/audio-mute.ts` — 4 offenders
- `electron/ipc/stt-process.ts` — 4 offenders
- `electron/ipc/hotkey.ts` — 3 offenders
- `electron/ipc/overlay.ts`, `settings.ts`, `transcription-history.ts` — assorted
- Singletons: `clipboard.ts`, `tray.ts`, `app-menu-template.ts`, `autostart.ts`, `dialog.ts`, `file-transcribe.ts`, `loopback.ts`, `updater-status-history.ts`, `context-menu-template.ts`

### Group B — Electron utilities (lib/, ws/)
- `electron/ws/stt-client.ts` — `dispatchControlEvents` CC=9
- `electron/lib/paste.ts` — 3 offenders
- `electron/lib/keycodes.ts`, `text-processing.ts`, `recording-indicator.ts`, `debug-log.ts`, `recording-state.ts`, `context-reader.ts`, `context-snapshot.ts`

### Group C — Shared layer (api, lib, i18n)
- `src/shared/api/ipc-client.ts` — `onModelCacheChanged>(anonymous)` CC=2
- `src/shared/lib/use-recording-sound.ts` — 2 offenders
- `src/shared/i18n/config.ts` — 1 offender

### Group D — Entities (lib, model)
- `src/entities/model-catalog/lib/model-options.ts` — `isUncomfortable` CC=6
- `src/entities/model-catalog/model/model-state-store.ts` — 2 offenders
- `src/entities/transcription-history/lib/word-stats.ts` — `intensityLevel` CC=6
- `src/entities/llm-catalog/lib/preset-prompts.ts` — `getPresetPrompt` CC=5

### Group E — Features (api, lib)
- `src/features/listen-mode/api/use-loopback-devices.ts` — 3 offenders
- `src/features/push-to-talk/api/use-push-to-talk.ts` — 1 offender
- `src/features/audio-visualizer/lib/use-{bar,radial,grid,aura}-animator.ts` — 4 files
- `src/features/audio-visualizer/lib/use-agent-state.ts`
- `src/features/text-post-processing/lib/apply-replacements.ts`

### Group F — Widgets (lib)
- `src/widgets/tray-menu/lib/tray-device-options.ts`
- `src/widgets/openrouter-model-selector/lib/use-model-selector-filters.ts`, `use-favorite-providers.ts`, `model-selector-display-utils.tsx`
- `src/widgets/desktop-tools-settings/lib/desktop-tools.ts`

### Group G — Logic extraction from UI (creates new in-scope files)
Functions to extract from `ui/` files into freshly-created `lib/` siblings:

| Source `ui/` file | Function | Destination |
|---|---|---|
| `widgets/desktop-tools-settings/ui/DesktopToolsSettingsPanel.tsx` | `panelReducer`, `updaterEntriesReducer` | `widgets/desktop-tools-settings/lib/panel-reducer.ts`, `updater-entries-reducer.ts` |
| `widgets/llm-settings/ui/LlmSettingsPanel.tsx` | `ollamaDialogReducer`, `getLevel` | `widgets/llm-settings/lib/ollama-dialog-reducer.ts`, `level-utils.ts` |
| `widgets/transcription-history-settings/ui/ActivityHeatmap.tsx` | `toWeekColumns` | `widgets/transcription-history-settings/lib/heatmap-columns.ts` |
| `widgets/transcription-history-settings/ui/HistoryTable.tsx` | data-shaping helpers | `widgets/transcription-history-settings/lib/history-rows.ts` |
| `widgets/tray-menu/ui/TrayMenu.tsx` | `trayMenuReducer`, handler helpers | `widgets/tray-menu/lib/tray-menu-reducer.ts` |
| `widgets/model-settings/ui/ModelSettingsPanel.tsx` | `formatBytes`, large dialog state | `widgets/model-settings/lib/format-bytes.ts`, `download-dialog-state.ts` |
| `widgets/general-settings/ui/GeneralSettingsPanel.tsx` | `isLiveTranscriptionDisplayValue` | `widgets/general-settings/lib/live-transcription-display.ts` |
| `widgets/audio-display/ui/DownloadOverlay.tsx` | `formatBytes` | reuse `shared/lib/format-bytes.ts` |
| `widgets/status-bar/ui/StatusBar.tsx` | data-shaping helpers | `widgets/status-bar/lib/` |
| `views/overlay/ui/OverlayPage.tsx` | `toPreset` | `views/overlay/lib/preset.ts` |
| `features/connect-server/ui/ConnectionIndicator.tsx` | `resolveConnectionChip` | `features/connect-server/lib/connection-chip.ts` |

After extraction, the new `lib/` files are in scope and must hit CRAP ≤ 4 (which is straightforward — small focused functions with unit tests).

---

## Dispatch plan (waves)

Each wave runs as many parallel agents as possible, where each agent owns a non-overlapping set of files. After every wave: re-run CRAP, verify the in-scope offender count strictly decreased, commit, then dispatch the next wave.

### Pre-wave: tooling setup
- Add `frontend/crap.ignore.json`
- Patch `frontend/scripts/crap/analyzer.ts` to merge biome + crap-ignore exclusions
- Verify report by re-running `bun run scripts/crap.ts --skip-coverage --strict --threshold 4`
- Expected: report drops to in-scope offenders only

### Wave 1 — High-CC refactors (CC ≥ 5 functions, blocking everything else)
Parallel agents, each owns one file:

1. `electron/ipc/stt-commands.ts` — split the CC=9 IIFE
2. `electron/ipc/llm.ts` — split `assertCustomPromptPayload` (CC=5); already large file
3. `electron/ws/stt-client.ts` — split `dispatchControlEvents` (CC=9) by event family
4. `entities/model-catalog/lib/model-options.ts` — refactor `isUncomfortable` (CC=6)
5. `entities/transcription-history/lib/word-stats.ts` — refactor `intensityLevel` (CC=6)
6. `entities/llm-catalog/lib/preset-prompts.ts` — refactor `getPresetPrompt` (CC=5)
7. `electron/ipc/transcription-history.ts` — refactor `isEntry` (CC=7) into smaller predicates

### Wave 2 — Logic extraction from UI files (Group G)
One agent per slice (no cross-file conflicts):

8. desktop-tools-settings (panelReducer + updaterEntriesReducer)
9. llm-settings (ollamaDialogReducer + getLevel)
10. transcription-history-settings (toWeekColumns, history rows)
11. tray-menu (trayMenuReducer)
12. model-settings (formatBytes, dialog state)
13. general-settings (isLiveTranscriptionDisplayValue)
14. status-bar helpers
15. overlay/connect-server helpers

### Wave 3 — Test-coverage uplift on remaining CC 2-4 functions
Parallel agents per Group:

16. Group A leftovers (Electron IPC after refactor)
17. Group B (Electron lib/ws)
18. Group C (Shared)
19. Group D leftovers (entities after refactor)
20. Group E (features)
21. Group F (widgets/lib)

### Wave 4 — Verification & cleanup
- Re-run CRAP report, confirm `--strict` exits 0
- Wire `bun run scripts/crap.ts --skip-coverage --strict --threshold 4` into pre-commit hook if not already

---

## Per-agent rules (baked into every prompt)

- **React Compiler is on** — never add `useMemo`, `useCallback`, `React.memo`.
- **Package manager: bun** (never npm/yarn).
- **FSD layer contract:** logic moves down (UI → lib), never sideways.
- **No `git stash`** — read files directly.
- **No new abstractions for hypothetical reuse** — extract only what the offender needs.
- **Tests sit next to source** as `*.test.ts(x)`.
- **Verification:** after edits, `cd frontend && bun typecheck && bun run scripts/crap.ts --skip-coverage --threshold 4 <changed paths>` (or full run).
- **Pre-existing failing tests** (recording-state suite, some OverlayPage/StatusBar UI tests) are out of scope — do not fix them as part of this work.
- **Don't change UI behavior** — extracted reducers/helpers must produce identical outputs.

---

## Per-wave evaluation criteria (Architect re-eval)

After each wave's agents complete, before committing:

1. Did the in-scope offender count strictly decrease?
2. Did `bun typecheck` stay clean (no new errors)?
3. Did `bun test` not introduce *new* failures (pre-existing ignored)?
4. Did any extracted logic deviate from original behavior? Spot-check 2-3 extracted files vs git diff.

If all four are yes → **commit and continue**. If any is no → **stop and investigate** before next wave.

---

## Success criteria

- `bun run scripts/crap.ts --skip-coverage --strict --threshold 4` exits 0
- `frontend/crap.ignore.json` is committed and the analyzer honors it
- Every monitored file with CRAP ≥ 4 has been either refactored (CC drop) or covered (coverage uplift)
- No reduction in lint or typecheck health
- No regression in test pass rate (3546 pass baseline preserved)
