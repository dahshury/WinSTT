# Build Instructions

This guide covers how to set up a development environment for WinSTT and how to produce the two release installers (CPU + DirectML).

For end-user installation, just download an installer from the [releases page](https://github.com/dahshury/WinSTT/releases) — this document is for **building from source**.

## Prerequisites

All builds:

- **[Git](https://git-scm.com/)** — `onnx-asr` is fetched as a git dependency
- **[uv](https://docs.astral.sh/uv/)** — Python toolchain manager (installs Python 3.11 for you)
- **[Bun](https://bun.sh/)** — JS runtime and package manager
- **PowerShell 7+** (`pwsh`) — only required for the packaging script (`server/packaging/build.ps1`)

Optional, depending on what you build:

| Need | Required for |
|---|---|
| **NVIDIA GPU + recent driver** | The legacy `gpu` extra (`onnxruntime-gpu` + ~2 GB of CUDA wheels). Not used by the default DirectML release flow. |
| **D3D12-capable GPU** | The DirectML build at runtime (AMD / Intel / NVIDIA via DirectX 12). The packaged installer falls back to CPU when no compatible GPU is present. |
| **Visual Studio Build Tools 2022** with C++ Desktop workload | Only if you rebuild the native helpers in `frontend/electron/native/src/winstt-*.c`. The prebuilt NAPI binaries that ship with `uiohook-napi` are loaded as-is in normal dev. |
| **Ollama** | Local LLM cleanup / custom transforms (runtime feature, not a build requirement). |

> WinSTT's transcription stack is **ONNX-only**. PyTorch is only pulled in by the optional `sentence-classifier` extra (Smart Endpoint / DistilBERT) and never bundled into a release.

## Quick Setup

From the repo root:

```bat
setup-dev.bat
```

This script:

1. Installs uv (if missing).
2. Installs Bun (if missing).
3. Detects an NVIDIA GPU and picks `--extra cpu` or `--extra gpu` automatically — override with `setup-dev.bat --flavor cpu | gpu`.
4. Syncs Python 3.11 + server deps via `uv sync`.
5. Runs `bun install` in `frontend/`.

After it finishes, [run the app](#running-locally).

## Manual Setup

### 1. Install uv

```powershell
irm https://astral.sh/uv/install.ps1 | iex
```

Add `C:\Users\<you>\.local\bin` to your PATH and restart your terminal.

```bash
uv --version    # verify
```

### 2. Server dependencies

```bash
cd server
uv sync --extra cpu          # CPU-only ONNX Runtime (~small)
# or
uv sync --extra gpu          # onnxruntime-gpu + full NVIDIA CUDA wheels (~2 GB)
```

Optional feature extras can be combined:

```bash
uv sync --extra cpu --extra tts --extra sentence-classifier
```

| Extra | Adds |
|---|---|
| `cpu` | `onnxruntime` (CPU only). Required if you don't use `gpu`. |
| `gpu` | `onnxruntime-gpu` + the full NVIDIA cu12 wheel set. Mutually exclusive with `cpu`. |
| `directml` | `onnxruntime-directml`. Used by the default Windows release. |
| `tts` | Kokoro-82M ONNX TTS (`kokoro-onnx`, torch-free). |
| `sentence-classifier` | Smart Endpoint / DistilBERT. The only extra that pulls in `torch` + `transformers`; gated and fails soft if absent. |

> **One ONNX runtime extra is required.** Plain `uv sync` with no extra installs neither runtime, and the server will crash on import.

### 3. Frontend dependencies

```bash
cd frontend
bun install
```

Verify the Electron build compiles:

```bash
bun electron:compile
```

## Running locally

Open two terminals:

```bash
# Terminal 1 — STT server
cd server
uv run stt-server

# Terminal 2 — Electron app
cd frontend
bun electron:dev
```

The server starts two WebSockets on `127.0.0.1`:

- Control (JSON commands) — port `8011`
- Audio (binary PCM) — port `8012`

Useful server flags:

```bash
uv run stt-server -m tiny.en          # smaller model, faster startup
uv run stt-server --device cpu        # force CPU (no CUDA / DirectML)
uv run stt-server -c 8011 -d 8012     # custom WebSocket ports
uv run stt-server -D                  # verbose / debug log level
uv run stt-server --help              # all options
```

The Electron main process is the only WebSocket client — the renderer talks to it via IPC.

## Packaging (release builds)

WinSTT ships **two NSIS installers per release**. Both wrap the same Electron app; only the bundled `stt-server.exe` differs:

| Installer | Size | ORT wheel | When to ship |
|---|---|---|---|
| `WinSTT-Portable-<version>.exe` | ~200 MB | `onnxruntime-directml` | Default GPU build — any Windows GPU via DirectX 12. Auto-falls-back to CPU. |
| `WinSTT-CPU-Portable-<version>.exe` | ~150 MB | `onnxruntime` | Servers / headless boxes / users who want the smallest download. |

The legacy CUDA-bundle build (`onnxruntime-gpu` + 8 NVIDIA cu12 wheels, ~2 GB) was retired for Windows because DirectML is faster on our workload (DirectML p50 = 85 ms vs CUDA 120 ms on a Whisper-tiny q4 benchmark), more consistent in tail latency, and ~10× smaller. CUDA EP detection is preserved in `server/src/recorder/infrastructure/device.py` for the eventual Linux NVIDIA build.

### Layout

Run from the **repo root**. All packaging configs and intermediate bundles live under `packaging/`; the final installer lands at `<repo>/dist/`:

```
packaging/
├── electron-builder.yml
├── electron-builder.cpu.yml
├── electron-builder.directml.yml
└── stt-server-dist/
    ├── cpu/                # PyInstaller output, CPU flavor
    └── directml/           # PyInstaller output, DirectML flavor
```

### Two-step build

Build the server executable first, then the matching installer.

**CPU:**

```bash
pwsh server/packaging/build.ps1 -Flavor cpu        # -> packaging/stt-server-dist/cpu/
bun run electron:build:cpu                         # -> dist/WinSTT-CPU-Portable-<version>.exe
```

**DirectML (default GPU):**

```bash
pwsh server/packaging/build.ps1 -Flavor directml   # -> packaging/stt-server-dist/directml/
bun run electron:build:directml                    # -> dist/WinSTT-Portable-<version>.exe
```

`build.ps1` uses an **isolated build venv** (`server/.venv-build-<flavor>/`, controlled by `UV_PROJECT_ENVIRONMENT`) so packaging never fights the live `stt-server` process holding DLLs open in the dev `.venv`. You can keep `bun electron:dev` running in another terminal while you build.

The PyInstaller spec at `server/packaging/stt-server.spec` auto-detects whether the `nvidia` package is in the venv (the `[gpu]` extra) and bundles CUDA DLLs accordingly. For shipped Windows builds neither flavor installs `[gpu]`, so no NVIDIA DLLs end up in the installer.

### Tagging a release

```bash
git tag v0.X.0
git push --tags
```

`.github/workflows/electron-release.yml` runs the CPU + DirectML builds as a matrix on tag push and publishes both installers to the same GitHub Release.

### macOS-only: Apple Intelligence CLI

When packaging the Electron app on macOS, compile the bundled Apple Intelligence bridge **before** running electron-builder:

```bash
bash tools/apple-intelligence-cli/build.sh
```

This emits `frontend/electron/resources/macos/winstt-apple-llm` — a tiny Swift binary that the Electron main process spawns to call Apple's on-device `FoundationModels` framework (macOS 15+ Apple Silicon). The script no-ops on Windows/Linux. The corresponding renderer-side provider option is hidden on non-Apple-Silicon platforms.

## Useful Commands

### Server (`server/`)

| Command | Description |
|---|---|
| `uv run stt-server` | Start the STT server |
| `uv run pytest` | Run all tests |
| `uv run pytest tests/unit/recorder/test_state_machine.py` | Single test file |
| `uv run pytest -k "test_name"` | Single test by name |
| `uv run ruff format .` | Format |
| `uv run ruff check . --fix` | Lint with auto-fix |
| `uv run mypy src/ --strict` | Type check (must be zero errors) |
| `make` | All of the above as a single check |

### Frontend (`frontend/`)

| Command | Description |
|---|---|
| `bun dev` | Vite renderer dev server (no Electron) |
| `bun electron:dev` | Full Electron + Vite dev |
| `bun electron:compile` | Compile Electron main/preload only |
| `bun build` | Production renderer build |
| `bun electron:build` | Build distributable Electron app |
| `bun typecheck` | TypeScript check |
| `bun lint` / `bun lint:fix` | Biome lint |
| `bun format` | Biome format |
| `bun test` | Bun test runner |
| `bun generate` | Regenerate TS types from OpenAPI spec |
| `bun knip` | Detect unused exports/files |

### Native helpers (rarely needed)

If you've modified `frontend/electron/native/src/winstt-*.c`, rebuild from a Developer Command Prompt:

```bash
bun --cwd frontend run native:build
```

Otherwise the prebuilt NAPI binaries shipped with `uiohook-napi` are loaded as-is.

## Troubleshooting

For runtime issues see [docs/content/docs/troubleshooting.mdx](docs/content/docs/troubleshooting.mdx). Build-specific gotchas below.

### `uv sync` installs no ONNX runtime / `No module named onnxruntime`

You forgot `--extra cpu` or `--extra gpu`. They conflict, so pick one. Add `--extra tts` / `--extra sentence-classifier` for the optional features.

### `onnx-asr` git fetch fails

`onnx-asr` is fetched directly from `github.com/dahshury/onnx-asr` (pinned commit in `server/pyproject.toml`). If `uv sync` errors on the git step, check your network / GitHub access and re-run. No local clone is needed.

### `bun install` errors on `uiohook-napi`

The prebuilt NAPI binary loads as-is; no rebuild is forced in normal dev. If you specifically need to rebuild the native C helpers, install Visual Studio Build Tools 2022 with the C++ Desktop workload and run `bun --cwd frontend run native:build` from a Developer Command Prompt.

### `electron-builder` complains about a locked DLL

Stop the dev server (`bun electron:dev`) before packaging — Electron holds onnxruntime DLLs open. The packaging script uses an isolated build venv so the *server* side is decoupled, but the *frontend* side still needs the dev Electron to exit.

### PyInstaller wheel resolution is wrong

Delete `server/.venv-build-cpu/` or `server/.venv-build-directml/` and re-run `pwsh server/packaging/build.ps1 -Flavor <flavor>`. The isolated build venv is disposable.
