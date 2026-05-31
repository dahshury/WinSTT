# WinSTT (Rust + Tauri)

A fast, private, on-device speech-to-text app for Windows — push-to-talk, toggle,
wake-word and listen dictation that types into any app, with on-device transcription
(ONNX via `ort`), LLM post-processing, transforms, dictionary/snippets, history, and
TTS read-aloud.

This is the **Rust + Tauri** implementation. The original **Electron + Python** app —
the parity reference — lives in [`examples/winstt-electron/`](examples/winstt-electron/).

## Develop

Windows, with the VS build tools, [bun](https://bun.sh), and the Rust toolchain.

```bat
rem dev (hot-reload renderer + Rust backend)
rust-migration\tauri-dev.bat

rem release build (standalone exe; --no-bundle skips the installer)
rust-migration\tauri-build.bat
```

These helpers set up the VS environment and run `bun run tauri dev|build` from the repo
root. For Rust-only checks: `rust-migration\cargo-env.bat check`.

## Structure

| Path | What |
|------|------|
| `src/` | Renderer (Feature-Sliced Design), ported from the Electron frontend |
| `src-tauri/` | Rust backend — `winstt::*` modules, STT engines, audio, IPC |
| `windows/`, `public/`, `messages/` | Secondary-window HTML, assets, i18n |
| `packages/` | Shared renderer packages (e.g. model-picker) |
| `rust-migration/` | Windows build/dev helper scripts |
| `examples/winstt-electron/` | The original Electron + Python app (parity reference) |
| `examples/Handy/` | Upstream Rust+Tauri STT app this port forks from |

## License

See [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
