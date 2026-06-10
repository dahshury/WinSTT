# WinSTT — Rust + Tauri (repo root)

This repository root is the **Rust + Tauri port of WinSTT** (a Windows speech-to-text
app). The original **Electron + Python** implementation now lives under
[`examples/winstt-electron/`](examples/winstt-electron/) as the reference/source-of-truth
for feature parity; `main` still tracks that Electron app.

## Layout

```
/                      ← Tauri WinSTT app (this is the app)
├── src/               renderer (FSD; ported 1:1 from the reference frontend)
├── src-tauri/         Rust backend (winstt::* modules, STT engines on `ort`)
├── public/ windows/ messages/ packages/ spec/ tools/
├── docs/              project docs
├── index.html  package.json  vite.config.ts  tsconfig*.json
├── tools/windows/     Windows build helpers (.bat: vcvars + cargo/bun)
├── examples/
│   └── winstt-electron/   the original Electron+Python app (parity reference)
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

## Critical rules (carried from the reference AGENTS.md)

- **NEVER `git stash`** in any form — the working tree is huge and stash conflicts hold
  work hostage. Use `cp file file.bak` or `git show <ref>:<path>` to compare.
- Commit/push only when asked. End commit messages with:
  `Co-Authored-By: Codex Opus 4.8 (1M context) <noreply@anthropic.com>`
- Moving `src-tauri/` invalidates absolute paths baked into `target/` — clear
  `target/debug/build/{tauri,winstt}-*` + matching `.fingerprint/*` if codegen paths break.

## IPC & events conventions

- **New frontend → backend calls use generated bindings directly.** Import
  `{ commands }` from `@/bindings` (tauri-specta) and call `commands.theCommand(...)`.
  The legacy string-channel funnel (`ipc-channels.ts` → `ipc-transport.ts`
  `COMMAND_INVOKERS` → `native-bridge-adapter.ts` ROUTE) is **FROZEN**: do not add
  new channel constants, invoker entries, or ROUTE entries. It shrinks
  opportunistically; it never grows.
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
  editing the fn + registry + `bindings.ts` (hand-edit or regenerate) + any
  `COMMAND_INVOKERS` entry together.
- **Event names are `namespace:kebab`, defined once as Rust consts.** Every
  renderer-facing event name lives in the `names` module in
  `src-tauri/src/winstt/commands/events.rs` (e.g. `WAKEWORD_DETECTED =
  "wakeword:detected"`). Emit with `app.emit(names::THE_EVENT, payload)` and listen
  on the SAME string in the adapter ROUTE — never duplicate the literal. The
  `emit-coverage` test (`src/shared/api/emit-coverage.test.ts`) fails if a renderer
  ROUTE event has no backend emitter, or a canonical backend event has no listener
  (the prefix-drift bug class); add an allowlist entry with a reason for a
  deliberately dead/internal edge.

For the Electron/Python app's instructions, see
[`examples/winstt-electron/AGENTS.md`](examples/winstt-electron/AGENTS.md).
