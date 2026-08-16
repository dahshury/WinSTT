# WinSTT — Rust + Tauri (repo root)

This repository is **WinSTT** — a local-first speech-to-text desktop app built
with **Rust + Tauri** (React renderer, `ort`/ONNX Runtime STT backend).

## Layout

```
/                      ← Tauri WinSTT app (this is the app)
├── src/               renderer (Feature-Sliced Design)
├── src-tauri/         Rust backend (winstt::* modules, STT engines on `ort`)
├── public/ windows/ messages/ packages/ spec/ tools/
├── docs/              project docs
├── index.html  package.json  vite.config.ts  tsconfig*.json
└── tools/windows/     Windows build helpers (.bat: vcvars + cargo/bun)
```

## Build / run (Windows)

The Tauri app needs the VS build env + bun/cargo on PATH. Use the helpers in
`tools/windows/` (they set up vcvars and `cd` to the right place):

- `tools\windows\tauri-dev.ps1` — `bun run tauri dev` (long-running). **Prefer this:** Ctrl+C
  closes cleanly (no cmd "Terminate batch job (Y/N)?" prompt). `tauri-dev.bat` still works but,
  being a batch file, cmd shows that prompt on Ctrl+C.
- `tools\windows\tauri-build.bat` — `bun run tauri build --no-bundle`
- `tools\windows\cargo-env.bat check|build` — cargo in `src-tauri/`

Note: `cargo build --release` leaves Tauri in **dev mode** (webview loads the dev URL);
only `tauri build` produces a standalone exe.

## Critical rules

- **NEVER `git stash`** in any form — the working tree is huge and stash conflicts hold
  work hostage. Use `cp file file.bak` or `git show <ref>:<path>` to compare.
- Commit/push only when asked. End commit messages with:
  `Co-Authored-By: Codex Opus 4.8 (1M context) <noreply@anthropic.com>`
- Moving `src-tauri/` invalidates absolute paths baked into `target/` — clear
  `target/debug/build/{tauri,winstt}-*` + matching `.fingerprint/*` if codegen paths break.

## Gates

Git hooks live in `.husky/` and shell out to npm scripts. Skip with
`WINSTT_SKIP_GIT_HOOKS=1` only when you have a reason.

- **`bun run precommit`** — lockfile, `lint`, `typecheck`, `check:cycles`.
- **`bun run prepush`** — lockfile, `test`, `check:deadcode` (knip), `check:rust`.

`check:cycles` runs `tools/check-cycles.mjs`, a zero-dependency circular-import
detector over `src/`. **Do not swap it for `madge`**: madge parses TS via
`detective-typescript` → `@typescript-eslint/typescript-estree`, which reads
`ts.Extension.Cjs` at module-load time. That is `undefined` under this repo's
TypeScript 7, so madge throws before parsing anything, with or without
`--ts-config`. The local checker resolves `@/` aliases and barrel `index` files
itself and counts type-only imports, because the cycle class this repo actually
hits is a module importing its own slice barrel
(`entities/x/lib/y.ts` → `@/entities/x` → back to `lib/y.ts`). Fix those by
importing from the defining module, not the barrel.

## IPC & events conventions

- **All frontend → backend calls use generated bindings.** Import `{ commands }`
  from `@/bindings` (tauri-specta) and call `commands.theCommand(...)`.
  The legacy string-channel funnel (`ipc-channels.ts` → `ipc-transport.ts`
  `COMMAND_INVOKERS` → `native-bridge-adapter.ts` ROUTE) is **GONE** — all three
  files were deleted in `720890c6`. Do not try to edit them, and do not
  reintroduce the pattern: `src/shared/api/native-boundary.test.ts` scans every
  non-test file under `src/` and fails on an `ipc-channels` import, a
  `COMMAND_INVOKERS` symbol, or a `native-bridge-adapter` mention.
  What survived the split: `src/shared/api/native-events.ts` holds renderer-facing
  EVENT names only (command names live exclusively in the generated bindings),
  `src/shared/api/native-boundary.ts` owns the Tauri listen/invoke boundary, and
  `src/shared/api/ipc-client.ts` is now just a re-export barrel.
  Note the test harness still models the old funnel (`test/mocks/legacy-ipc.ts`,
  `test/mocks/ipc-client.ts`, `test/preload.ts` installing `window.nativeBridge`),
  which is why `native-boundary.ts` keeps a few `window.nativeBridge` branches
  marked "Unit-test compatibility only". Those are production-dead; retiring them
  means converting the bun suite to `commands.*` assertions first.
- **A new Rust command needs only 2 edits:** (a) the `#[tauri::command] #[specta::specta]`
  fn, and (b) its entry in `collect_commands![]` (`commands_registry.rs`). A
  completeness guard test enforces (b); regenerate `bindings.ts` via the
  `export_bindings` test, then call it from the renderer through `commands.*`.
- **Command names are `domain_verb_object`.** The ~200 commands share one global
  namespace, so the `domain` prefix (`stt`/`tts`/`llm`/`ollama`/`openrouter`/
  `wakeword`/`history`/`file_transcribe`/…) is mandatory — never a bare verb like
  `list_models`. Verb conventions: `list_*` for local/cached reads,
  `refresh_*` for network re-scans (e.g. `ollama_refresh_models`,
  `openrouter_refresh_stt_models`), `get_*` only when no plainer noun fits (prefer
  `wakeword_model_status` over `get_wakeword_status`). The generated binding is the
  command's camelCase (`stt_list_models` → `commands.sttListModels`); a rename means
  editing the fn + registry + `bindings.ts` (hand-edit or regenerate) together.
- **Event names are `namespace:kebab`, defined once as Rust consts.** Every
  renderer-facing event name lives in the `names` module in
  `src-tauri/src/winstt/commands/events.rs` (e.g. `WAKEWORD_DETECTED =
  "wakeword:detected"`). Emit with `app.emit(names::THE_EVENT, payload)` and listen
  on the SAME string via `NATIVE_EVENTS` in `src/shared/api/native-events.ts` —
  never duplicate the literal. The `emit-coverage` test
  (`src/shared/api/emit-coverage.test.ts`) fails if a renderer-side event has no
  backend emitter, or a canonical backend event has no listener (the prefix-drift
  bug class); add an allowlist entry with a reason for a deliberately
  dead/internal edge.
