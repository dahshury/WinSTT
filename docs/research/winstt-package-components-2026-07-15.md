# WinSTT package component measurement

Measured: 2026-07-14T21:41:12.267Z

| Component | Logical size | Path |
|---|---:|---|
| release executable | 64.02 MiB | `src-tauri/target/release/winstt.exe` |
| context sidecar | 0.40 MiB | `src-tauri/target/release/winstt_context.exe` |
| Windows native runtime DLLs | 18.39 MiB | `src-tauri/binaries/runtime` |
| bundled resources | 2.26 MiB | `src-tauri/resources` |
| renderer dist | 6.09 MiB | `dist` |
| portable ZIP | missing | `dist/WinSTT-portable.zip` |
| published Windows NSIS | missing | `dist/WinSTT.exe` |
| latest raw NSIS | 27.19 MiB | `src-tauri\target\release\bundle\nsis\WinSTT_0.1.3-alpha.6_x64-setup.exe` |
| Linux release artifacts | missing | `dist/linux` |
| macOS release artifacts | missing | `dist/macos` |

## Decision

- Keep the context reader as the existing sidecar: it is independently replaceable and small enough that another process split has no package-size payoff.
- Do not split STT/TTS/LLM Rust features into more executables without symbol-level evidence: the main binary shares the Tauri/Rust/native dependency graph, and extra binaries would duplicate runtime/linkage while adding IPC and lifecycle failure modes.
- Windows runtime DLLs are 18.39 MiB beside a 64.02 MiB executable. Making the runtime an on-demand download would reduce the initial artifact, but would break offline-first launch/recovery; retain app-local packaging.
- The context sidecar is 0.40 MiB, confirming it is not a meaningful package-size target.
