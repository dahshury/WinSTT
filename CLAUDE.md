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
├── public/ windows/ messages/ packages/ spec/ scripts/
├── docs/              project docs + port plan (docs/port/ ← the migration plan)
├── index.html  package.json  vite.config.ts  tsconfig*.json
├── rust-migration/    Windows build helpers (.bat: vcvars + cargo/bun)
├── examples/
│   └── winstt-electron/   the original Electron+Python app (parity reference)
```

## Build / run (Windows)

The Tauri app needs the VS build env + bun/cargo on PATH. Use the helpers in
`rust-migration/` (they set up vcvars and `cd` to the right place):

- `rust-migration\tauri-dev.ps1`   — `bun run tauri dev` (long-running). **Prefer this:** Ctrl+C
  closes cleanly (no cmd "Terminate batch job (Y/N)?" prompt). `tauri-dev.bat` still works but,
  being a batch file, cmd shows that prompt on Ctrl+C.
- `rust-migration\tauri-build.bat`  — `bun run tauri build --no-bundle`
- `rust-migration\cargo-env.bat check|build` — cargo in `src-tauri/`

Note: `cargo build --release` leaves Tauri in **dev mode** (webview loads the dev URL);
only `tauri build` produces a standalone exe.

## Critical rules (carried from the reference CLAUDE.md)

- **NEVER `git stash`** in any form — the working tree is huge and stash conflicts hold
  work hostage. Use `cp file file.bak` or `git show <ref>:<path>` to compare.
- Commit/push only when asked. End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Moving `src-tauri/` invalidates absolute paths baked into `target/` — clear
  `target/debug/build/{tauri,winstt}-*` + matching `.fingerprint/*` if codegen paths break.

For the Electron/Python app's instructions, see
[`examples/winstt-electron/CLAUDE.md`](examples/winstt-electron/CLAUDE.md).
