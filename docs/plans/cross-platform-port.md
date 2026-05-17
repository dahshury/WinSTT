# Cross-Platform Port Plan — Linux & macOS

> **Status:** Draft / not yet executed. Awaiting confirmation of the assumptions below before Phase 0 begins.
>
> **Scope:** Port WinSTT from Windows-only to a tri-platform desktop app with parity-grade installers, CI, and tests on Windows / macOS / Linux.

---

## 0. Assumptions (flag any you want changed)

- **Linux Phase 1 = X11 only.** Wayland gets a Phase 2 epic (paste / hotkey / context are all different APIs there).
- **macOS minimum = 14.4** so we can use Core Audio Process Tap API for loopback. Older macOS gets no system-audio capture.
- **macOS code signing assumed** (Developer ID + notarization). Without it, paste/accessibility prompts are noisy; CI needs the cert as a secret.
- **GPU on macOS dropped from Phase 1.** Apple Silicon = Core ML / MLX, a different backend. CPU only on Mac initially.
- **Linux GPU = NVIDIA CUDA** via `LD_LIBRARY_PATH` (no DLL injection needed).
- **Distribution targets:** macOS DMG (signed + notarized), Linux AppImage + `.deb`.

---

## 1. Difficulty ranking (hardest → easiest)

| # | Work item | Why this rank |
|---|---|---|
| 1 | **Loopback / system-audio capture on macOS** | No public per-process API pre-14.4. Need Core Audio Process Tap (14.4+) or shipping w/ BlackHole virtual device. Entitlements + TCC. |
| 2 | **Per-process audio ducking on macOS** | `IAudioEndpointVolume` has no clean equivalent. Best we get is system volume via `AppleScript` / MediaRemote, not per-app. Likely ship as a degraded feature. |
| 3 | **Wayland parity (paste + hotkey + context)** | `wtype`/`ydotool` (root or uinput), no AT-SPI for context on most compositors. Phase 2 epic. |
| 4 | **App-context (UIA) on macOS** | AXUIElement works but needs Accessibility TCC entitlement + dedicated Swift helper binary. |
| 5 | **App-context (AT-SPI) on Linux X11** | AT-SPI2 D-Bus bridge; flaky on apps that don't expose accessibility. |
| 6 | **GPU/CUDA on Linux** | Drop Windows DLL injection branch; rely on `LD_LIBRARY_PATH` + bundling `.so` files in PyInstaller. Mechanical but touches packaging. |
| 7 | **Audio ducking on Linux** | `pactl set-sink-input-volume` on PulseAudio + PipeWire fallback. Need to track sink-input IDs by PID. |
| 8 | **Loopback on Linux** | Easy: PulseAudio/PipeWire monitor sources. Just a new audio-source adapter. |
| 9 | **Auto-paste on macOS** | `CGEventCreateKeyboardEvent` from a small Swift helper binary. TCC prompt only. |
| 10 | **Auto-paste on Linux X11** | `xdotool key ctrl+v` or `XTestFakeKeyEvent` via a small C helper. |
| 11 | **Global hotkeys on mac/Linux X11** | `uiohook-napi` already supports them; just need accessibility prompt UX on macOS. |
| 12 | **Cross-compile native helpers** | C → MSVC (current), clang for macOS, gcc for Linux; CMake unification. |
| 13 | **electron-builder mac/linux targets** | Add `mac`/`linux` blocks; DMG + AppImage + deb. Code-signing pipeline glue. |
| 14 | **Auto-launch on Linux** | Write `~/.config/autostart/winstt.desktop`. Trivial. |
| 15 | **PyInstaller spec cross-platform** | Glob `*.dll`/`*.dylib`/`*.so` conditionally. Mechanical. |
| 16 | **PowerShell build script → Python** | Single `server/packaging/build.py` replacing `build.ps1`. |
| 17 | **CI matrix expansion** | Add `macos-14` / `ubuntu-22.04` runners; matrix `[os, flavor]`. |
| 18 | **Server signal/asyncio refactor** | Conditional `sys.platform == "win32"` guards already half-there. |
| 19 | **macOS icon (`.icns`) + Linux (`.png` sizes)** | Asset generation only. |

---

## 2. Per-OS execution plan

### 2A. Linux (X11) — Phase 1

| Feature | Replacement | Files to touch | Tests |
|---|---|---|---|
| Loopback | New adapter `infrastructure/audio_sources/pulse_monitor.py` using `pasimple`/`sounddevice` against `*.monitor` source | `server/src/recorder/infrastructure/`, `bootstrap.py` registration | Docker w/ PulseAudio dummy sink; assert frames captured |
| GPU | Remove Win DLL injection branch (already conditional), add `LD_LIBRARY_PATH` extension when bundled CUDA `.so` files are present | `device.py:78-200` | CI job on `ubuntu-22.04` with CUDA toolkit cached layer; smoke-test ORT CUDA EP load |
| Audio ducking | New `electron/lib/pulse-host.ts` calling `pactl` via `child_process`; map foreground app PID → sink-input | `electron/ipc/audio-mute.ts` (platform switch), new `pulse-host.ts` | Headless integration test: spawn `aplay`, duck, assert sink-input volume changed via `pactl list sink-inputs` |
| Paste | New helper `winstt-paste-linux` (small C using `XTestFakeKeyEvent`), compiled in CI | `electron/native/src/winstt-paste-linux.c`, new CMakeLists | xvfb-run smoke test in CI |
| Context (AT-SPI) | Python helper `winstt-context-linux` using `pyatspi` to read focused-text element; spawned same way as the Windows `.exe` | `electron/native/src/`, `electron/lib/context-reader.ts` switch | Launch `gedit` in xvfb, type text, assert helper returns context |
| Global hotkey | `uiohook-napi` already supports X11 — verify prebuilt is shipped | `electron/ipc/hotkey.ts` (no changes) | Xvfb + xdotool to fake key events, assert IPC fires |
| Auto-launch | `~/.config/autostart/winstt.desktop` writer in `autostart.ts` | `electron/ipc/autostart.ts:4` (drop Linux exclusion) | Unit test: assert desktop file written correctly with `Exec=` and `X-GNOME-Autostart-enabled=true` |
| Packaging | Add `linux:` block to `electron-builder.cpu.yml`/`.gpu.yml`: targets `AppImage`, `deb` | `frontend/electron-builder.*.yml` | CI artifact upload check |
| Console signals | Remove Windows-only `ctypes.windll` path; use `signal.SIGINT`/`SIGTERM` on POSIX | `server/src/stt_server/server.py:277-303` | Existing tests + new POSIX signal-delivery test |

**Linux test environment:** ubuntu-22.04 GitHub runner, `xvfb-run` for any GUI, `pulseaudio --start` in CI, dummy mic via `pacmd load-module module-null-sink`.

### 2B. Linux (Wayland) — Phase 2 (separate epic)

- Paste via `wtype` (wlroots) or `ydotool` (uinput, requires root daemon) — ship `ydotoold` helper service.
- Hotkeys via `org.freedesktop.portal.GlobalShortcuts` (newish, Plasma/GNOME differ).
- Context: largely abandoned — fall back to clipboard sampling.
- Defer until Phase 1 is stable.

### 2C. macOS — Phase 1

| Feature | Replacement | Files to touch | Tests |
|---|---|---|---|
| Loopback | Swift helper `WinSTTAudioTap` using `AudioHardwareCreateProcessTap` (macOS 14.4+); pipe PCM over stdout to Python | New `server/packaging/macos/AudioTap/`, new domain adapter `aggregate_tap_source.py` | macos-14 runner with the helper bundle; capture from Music.app reference clip |
| Per-process ducking | **Degraded:** use `osascript` to mute focused app via System Events / fallback to system volume via MediaRemote | `electron/lib/macos-volume.ts` | Smoke test: assert mute/unmute issued; document limitation |
| Paste | Swift helper `winstt-paste-mac` using `CGEventPost` Cmd+V | New native target | Headless: spawn TextEdit, paste, assert clipboard content arrived |
| Context (AXUIElement) | Swift helper `winstt-context-mac` reading focused window/app + selected text via Accessibility API | New native target | Functional test against TextEdit; assert helper returns app bundle id + selection |
| Global hotkey | `uiohook-napi` works; add first-run flow that opens System Settings → Privacy → Accessibility | `electron/ipc/hotkey.ts`, new onboarding modal | Manual TCC verification doc + automated check that helper detects missing permission and emits warning |
| Auto-launch | Already supported by Electron `setLoginItemSettings` | `autostart.ts:4` (already covers darwin) | Existing |
| GPU | **Skipped Phase 1.** CPU-only build. Document MLX backend as Phase 2. | `device.py` early-return on darwin | N/A |
| Packaging | electron-builder `mac:` block → DMG, hardened runtime + entitlements (`com.apple.security.device.audio-input`, `com.apple.security.automation.apple-events`); notarize via `notarytool` | `frontend/electron-builder.*.yml`, new `build/entitlements.mac.plist` | CI: notarization status polled; smoke install via `hdiutil attach` on macos-14 |
| PyInstaller | Add `.app` bundle output or onefile; codesign Python helpers with same Developer ID | `server/packaging/stt-server.spec` | Verify `codesign --verify --deep` passes |
| Console signals | Same POSIX path as Linux | `server/src/stt_server/server.py` | Shared |

**macOS test environment:** `macos-14` runner (Apple Silicon), `osascript` for app automation, signed helper binaries cached as artifacts to amortize notarization time.

### 2D. Cross-cutting refactors (do these first — Phase 0)

1. Replace `build.ps1` with `server/packaging/build.py` — same `--flavor cpu|gpu` interface, dispatches per `platform.system()`.
2. Conditional PyInstaller spec: glob `*.dll|*.dylib|*.so` based on platform, drop the Win-only `_collect_nvidia_dlls`.
3. Unify native helpers under `frontend/electron/native/` with **CMake**: subdirs `windows/`, `macos/`, `linux/` producing `winstt-paste{,.exe}` and `winstt-context{,.exe}` per platform. CI runs `cmake --build` on each runner.
4. Strip remaining Win-only branches in `device.py`, `server.py`, `config.py:9` and `client.py:55` (the Darwin special-case for `INIT_HANDLE_BUFFER_OVERFLOW`).
5. Replace PowerShell host in `ps-host.ts` with a platform dispatcher: `WindowsPsHost`, `MacOSHost`, `LinuxHost` — same interface, different impls.

---

## 3. CI/CD plan

### Matrix expansion in `.github/workflows/electron-release.yml`

```yaml
strategy:
  matrix:
    include:
      - os: windows-latest
        flavor: cpu
      - os: windows-latest
        flavor: gpu
      - os: macos-14         # Apple Silicon, cpu-only
        flavor: cpu
      - os: ubuntu-22.04
        flavor: cpu
      - os: ubuntu-22.04
        flavor: gpu          # with CUDA layer
```

### Artifacts produced per release

- `WinSTT-CPU-Setup-<ver>.exe` / `WinSTT-GPU-Setup-<ver>.exe` (existing)
- `WinSTT-<ver>.dmg` (universal2 or arm64)
- `WinSTT-CPU-<ver>.AppImage` / `WinSTT-GPU-<ver>.AppImage`
- `winstt-cpu_<ver>_amd64.deb` / `winstt-gpu_<ver>_amd64.deb`

### Pre-merge CI (`.github/workflows/ci.yml`)

- **`lint` job:** ruff + mypy + biome + typecheck on ubuntu-latest (fast, fails fast).
- **`test-server` job:** matrix over `[windows-latest, macos-14, ubuntu-22.04]` × pytest with platform markers (`@pytest.mark.skipif(sys.platform != "linux")` etc.).
- **`test-frontend` job:** matrix over same 3 OSes; Bun test + Playwright headless against built renderer.
- **`build-smoke` job:** builds each installer in dry-run mode (no publish) and verifies the artifact opens / `--version` returns.

### Secrets needed

- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (notarization)
- `CSC_LINK` + `CSC_KEY_PASSWORD` (signing certs, base64'd `.p12`)
- `WINDOWS_CSC_*` (if/when Win signing is added)

---

## 4. Test plan per OS

| Layer | Windows | macOS | Linux |
|---|---|---|---|
| Server unit (pytest) | All tests pass | All tests pass; loopback tests gated to 14.4+ | All tests pass |
| Server integration | Loopback via WASAPI | Loopback via Process Tap helper (functional test against a known audio file) | Loopback via PulseAudio null sink + monitor |
| Native helpers | C MSVC + UIA fake harness | Swift XCTest against TextEdit | C + xdotool harness inside xvfb |
| Electron e2e (Playwright) | Existing | Same scenarios, plus TCC permission stub | Same scenarios under xvfb |
| Smoke install | NSIS → run → `--version` | DMG mount → app launch → `--version` | AppImage exec + `.deb` install in container |

### Pre-commit (Husky + lefthook on frontend, pre-commit framework on server)

- ruff + mypy --strict (server)
- biome + tsc --noEmit + bun test --filter affected (frontend)
- **Fast OS-local tests only** — the cross-OS matrix runs in CI, not pre-commit (otherwise commits take 20+ min). Pre-commit ensures *your platform's* tests + lint + types pass; CI enforces the rest.

---

## 5. Phased execution timeline

### Phase 0 — Cross-cutting (foundation, ~1 week)

- `build.py` replaces `build.ps1`
- CMake unification of native helpers
- PyInstaller spec made platform-conditional
- Server POSIX signal/asyncio refactor
- CI matrix scaffolding (jobs skip-then-pass on new OSes initially)

### Phase 1A — Linux X11 CPU (~1 week)

- Pulse loopback adapter, paste/context helpers, audio ducking via `pactl`, AppImage + deb output, full test green on `ubuntu-22.04`.

### Phase 1B — Linux GPU (~3 days)

- CUDA `.so` bundling, ORT CUDA EP smoke test.

### Phase 1C — macOS CPU (~2 weeks)

- Swift helpers for paste/context/loopback, code-signing pipeline, notarization, DMG output, full test green on `macos-14`.

### Phase 2 — Wayland + macOS GPU (separate epics, deferred)

- Wayland adapters; MLX/Core ML transcription backend.

**Total Phase 1: ~4 weeks of focused work + testing buffer.**

---

## 6. Open questions to resolve before Phase 0 kickoff

1. Is an Apple Developer ID account available for signing/notarization? If not, macOS ships unsigned (user must right-click → Open).
2. PulseAudio vs PipeWire-first on Linux? PipeWire is dominant on modern Fedora/Ubuntu; PulseAudio shim works on both.
3. Linux distribution targets — confirm AppImage + `.deb`, or add `.rpm` / Flatpak?
4. macOS minimum version — locking to 14.4 cuts ~25% of installed base. Acceptable, or do we want a graceful loopback-disabled path on 13.x?
5. Should Phase 0 land behind a feature flag so existing Windows release cadence isn't disrupted?
