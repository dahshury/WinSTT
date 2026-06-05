# Platform Verification Harness

Run from Windows PowerShell.

```powershell
tools\platform\verify-all.ps1
tools\platform\verify-all.ps1 -Profile full
tools\platform\verify-all.ps1 -Linux -Profile full
tools\platform\verify-all.ps1 -Windows -Profile smoke
```

Profiles:

- `smoke`: Rust check plus renderer build.
- `standard`: Rust fmt, check, clippy, tests, plus renderer build.
- `full`: standard checks plus frontend tests, Tauri no-bundle build, and launch smoke.

Linux runs inside Docker using `tools/platform/linux.Dockerfile`. Docker verifies Linux on a
real Linux userspace from Windows, but it does not replace native macOS verification. macOS still
needs a native runner such as GitHub Actions `macos-latest`, a MacStadium runner, or an SSH Mac.
