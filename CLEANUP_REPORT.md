# Cleanup Report

Audit + cleanup pass over the WinSTT codebase, scoped to high-confidence changes that tool output could verify.

## Baseline after cleanup

| Check | Result |
|---|---|
| `bun typecheck` (frontend) | 0 errors |
| `bun lint` (frontend, Biome) | 0 issues across 251 files |
| `bun knip` (frontend) | 0 findings |
| `bunx madge --circular` (frontend) | 0 circular deps across 226 files |
| `scripts/check-fsd-violations.ts` | 0 violations across 175 files |
| `bun test` (frontend) | 47/47 pass |
| `uv run mypy src/ --strict` (server) | 0 issues across 53 files |
| `uv run ruff check .` (server) | 0 issues |
| `uv run pytest` (server) | 290 pass / 6 skipped |

Frontend build + server tests already ran in green state.

## Changes applied

### 1. Deduplication

| Where | What was removed | Why |
|---|---|---|
| `frontend/src/shared/lib/errors/index.ts` (folder deleted) | Dead barrel that only re-exported from `../errors` | TS module resolution picked `errors.ts` over the folder; nothing imported `errors/` |
| `frontend/electron/ipc/clipboard.ts`, `context-menu-handler.ts`, `app-menu-template.ts` | 3× local copies of `isRecord()` | Identical 2-line type guard; extracted to `electron/lib/ipc-helpers.ts` |
| `frontend/electron/ipc/relay.ts`, `file-transcribe.ts` | 2× local copies of `type SafeSend` | Identical signature; moved to `electron/lib/ipc-helpers.ts` |
| `frontend/electron/ipc/hotkey.ts`, `file-transcribe.ts`, `relay.ts` | 3× inline `safeSend = (channel, …) => if (!win.isDestroyed()) …` | Extracted to `createSafeSender(win)` factory in `electron/lib/ipc-helpers.ts` |
| `frontend/src/shared/api/ipc-client.ts`, `entities/connection/model/connection-store.ts`, `features/update-settings/api/use-sync-settings.ts` | 4× local `components["schemas"]["X"]` type aliases for `AudioDevice`, `GpuInfo`, `ServerStatus`, `AllowedParameter`, `AllowedMethod`, `OllamaModel`, `AppSettings` | Consolidated in new `shared/api/models.ts` |
| `frontend/src/features/audio-visualizer/ui/AudioVisualizerWave.tsx`, `AudioVisualizerAura.tsx` | 2× identical `hexToRgb` + `HEX_COLOR_RE` + `DEFAULT_COLOR` | Extracted to new `features/audio-visualizer/lib/hex-to-rgb.ts` (also removes the dead try/catch that wrapped regex+parseInt — neither throws) |
| `server/src/recorder/bootstrap.py`, `recorder/__init__.py` | 12-line duplicate for-loop wiring each legacy callback to its event type | Extracted to new `wire_all_callbacks(event_bus, callbacks)` helper in `bootstrap.py`; `__init__.py` now calls it directly, eliminating duplicate imports of `CALLBACK_EVENT_MAP`, `wire_callback_*`, and matching event types |

### 2. Types / weak-type fixes

| File | Change |
|---|---|
| `server/src/stt_server/loopback.py:207` | `stream: Any` → `stream: _AudioStream` (Protocol with `read`, `stop_stream`, `close`); removes the `ANN401` ruff violation |
| `frontend/src/shared/config/defaults.ts` | `WHISPER_MODELS` / `COMPUTE_TYPES` refactored to `as const satisfies readonly components["schemas"]["X"][]` — preserves literal tuple type so zod `z.enum(COMPUTE_TYPES)` in `settings-schema.ts` can use it without a cast (single source of truth for compute-type list) |
| `frontend/src/shared/config/settings-schema.ts` | Removed hardcoded duplicate of the 10 compute types; now imports `COMPUTE_TYPES` from `defaults.ts` |

### 3. Lint / test-file fixes

| File | Change |
|---|---|
| `server/tests/integration/test_loopback_capture.py:19` | Added `# noqa: E402` for post-`importorskip` import (idiomatic pytest pattern) |
| `server/tests/unit/recorder/test_download_progress.py:447, 470` | Combined nested `with pytest.raises` + context manager into parenthesized single-statement form (`SIM117`) |
| `frontend/knip.json` | Scoped `test/**/*` + `**/*.test.*` as entry/project so knip no longer reports `@happy-dom/global-registrator` and `@testing-library/react` as unused; added `postcss`, `electron-updater` to `ignoreDependencies` (both used via dynamic import / config file not statically analyzable) |

### 4. Bug fix in WIP code (uncovered during verification)

| File | Change |
|---|---|
| `frontend/src/widgets/desktop-tools-settings/lib/desktop-tools.ts` | `parseAppMenuTemplateJson` was delegating all validation to zod's `menuTemplateSchema.safeParse`, which never produces the "JSON root must be an array" message its test expected (pre-existing failure in untracked WIP widget). Added an explicit `Array.isArray(raw)` check before the schema parse to emit a meaningful error and to satisfy the existing test |

## Baseline coverage verification

Server coverage after changes sits at **97.90%** (fails the 100% gate in `pyproject.toml`). Verified as pre-existing by stashing only `server/` changes and re-running `pytest` on the baseline — same **97.90%**. Uncovered lines are in `recorder_service.py` and `building_blocks/errors.py`, neither of which this cleanup touched. The gap is a WIP-state artifact, not a regression.

## What I deliberately did NOT touch

- **`contextlib.suppress(Exception)` in `server/src/stt_server/loopback.py:179/188/193`** — suppressing stream shutdown exceptions is a legitimate workaround for a documented pyaudio/WASAPI segfault when the capture thread is still blocked on a read. Narrowing without reproducing the segfault on target hardware is high-risk.
- **Empty catches in `electron/lib/debug-log.ts` and `src/shared/lib/ollama-endpoint.ts`** — intentional silent fallbacks (log-write during app shutdown; URL normalization for user-entered strings that may not be valid URLs). Neither hides actionable errors.
- **Single `any` in `src/widgets/general-settings/lib/use-sound-file-drop.ts:32`** — next-intl's `useTranslations()` returns a `Translator` generic parameterized by `NamespacedMessageKeys`, which cannot be narrowed to plain `string` without breaking assignability at the call site. Verified: typecheck fails when `any` is replaced. Kept with an updated `biome-ignore` comment explaining the reason.
- **`shared/api/ipc-client.ts` fallback catches** (`invokeOrDefault`, `invokeSecureOrDefault`) — explicit "return a safe default if IPC failed" is load-bearing behaviour for the renderer when running outside Electron (e.g., Next.js SSR pass during static export). Not a swallowed error.
- **`entities/audio-device/model/audio-device.ts`** — flagged by the audit as a duplicate of `shared/api/models.ts#AudioDevice`, but this is FSD-correct: entities own their canonical domain type. Kept.
- **16 files with single-line JSDoc** — checked, all are meaningful short descriptions, not auto-generated noise.
- **Zero `TODO` / `FIXME` / `HACK` / `XXX`** comments were found anywhere in `frontend/src`, `frontend/electron`, or `server/src`. Noise-comment audit produced no targets.

## Files added

- `frontend/electron/lib/ipc-helpers.ts`
- `frontend/src/shared/api/models.ts`
- `frontend/src/features/audio-visualizer/lib/hex-to-rgb.ts`

## Files deleted

- `frontend/src/shared/lib/errors/` (folder with dead barrel `index.ts`)
