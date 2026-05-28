# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 🛑 **NEVER run `git stash` in any form** — not `git stash`, not `git stash --keep-index`, not `git stash push`, not `git stash save`. The repo's working tree is huge and stash conflicts have repeatedly held in-progress refactors hostage. Two separate incidents on record (see `memory/feedback_no_git_stash.md`). Defenses in place: (a) `.husky/reference-transaction` blocks CREATE/UPDATE of `refs/stash`; (b) `.claude/settings.local.json` denies `git stash*` Bash commands; (c) the harness denylist blocks `git stash pop` / `git stash apply`. If you need a side copy, use `cp <file> <file>.bak`. If you need to compare against HEAD, use `git show HEAD:<path>`. If you genuinely need an isolated checkout, use `git worktree add ../winstt-scratch`.

## Project Overview

WinSTT is a Windows speech-to-text desktop application with a Python backend (WebSocket STT server) and an Electron frontend. The two communicate over dual WebSocket channels (control JSON + binary audio data).

## Repository Structure

```
WinSTT/
├── server/          # Python STT engine (hexagonal architecture)
├── frontend/        # Electron + Vite multi-page renderer (React 19 + FSD)
├── spec/            # OpenAPI 3.1 spec (single source of truth for shared types)
├── packaging/       # electron-builder configs + PyInstaller output staging
├── docs/            # Fumadocs site (architecture, settings, models, etc.)
└── examples/        # Reference monolith + 3rd-party repos used as references
```

Each sub-project has its own detailed `CLAUDE.md`:
- `server/CLAUDE.md` — hexagonal architecture rulebook, layer hierarchy, port/adapter patterns, threading model
- `frontend/CLAUDE.md` — Feature-Sliced Design rulebook, layer/segment/slice conventions, import contracts

## Commands

### Server (Python — run from `server/`)

| Command | Description |
|---|---|
| `make` (or `make all`) | Full check: format + lint + mypy + tests |
| `uv run pytest` | Run all tests |
| `uv run pytest tests/unit/recorder/test_state_machine.py` | Single test file |
| `uv run pytest tests/unit/ -k "test_name"` | Single test by name |
| `uv run ruff format .` | Format |
| `uv run ruff check . --fix` | Lint with auto-fix |
| `uv run mypy src/ --strict` | Type check (strict mode, zero errors required) |

### Frontend (TypeScript — run from `frontend/`)

| Command | Description |
|---|---|
| `bun dev` (alias of `bun electron:dev`) | Full Electron + Vite dev (concurrent: renderer, main, app) |
| `bun dev:renderer` | Vite renderer only (no Electron) — `http://localhost:3000` |
| `bun electron:dev` | Same as `bun dev` |
| `bun build` | Production renderer build (`vite build` → `dist-renderer/`) |
| `bun electron:build` | Build distributable Electron app (NSIS portable) |
| `bun electron:compile` | Bundle Electron main+preload via tsup → `dist-electron/` |
| `bun typecheck` | TypeScript type checking via `tsgo` (use `bun typecheck:tsc` for stock `tsc`) |
| `bun lint` / `bun lint:fix` | Biome lint (and auto-fix) |
| `bun format` | Biome format |
| `bun test` | Run unit tests (Bun test runner) |
| `bun test:e2e` | Playwright e2e (browser projects) |
| `bun test:e2e:electron` | Playwright e2e against compiled Electron build |
| `bun test:visual` | Playwright visual-regression suite |
| `bun generate` | Regenerate TS types from `spec/openapi.yaml` + Zod schemas |
| `bun knip` | Detect unused exports/files |
| `bun check:fsd` | Audit FSD layer/import violations (~123 rules) |
| `bun check:i18n` | Verify locale-key parity across `messages/*.json` |
| `bun check:react-doctor` | React-doctor static check (offline) |
| `bun crap:gate` / `bun coverage:gate` | Regression gates against baseline reports |
| `bun native:build` | Recompile the two C helpers (`winstt-paste.exe`, `winstt-context.exe`) |

### Packaging (release builds — produces two portable installers)

WinSTT ships in two flavors per release on Windows (CUDA is retired on Windows; see note below):

| Flavor | Installer size | ORT wheel | When to use |
|---|---|---|---|
| **DirectML** (default GPU) | ~200 MB | `onnxruntime-directml` | Any Windows GPU (AMD / Intel / NVIDIA via DirectX 12). This is the unmarked default download. |
| **CPU** | ~150 MB | `onnxruntime` | Servers, headless boxes, NPU-less laptops, or anyone who wants the smallest bundle. |

Both wrap the same Electron app; only the bundled `stt-server.exe` differs. The runtime in `server/src/recorder/infrastructure/device.py` (`resolve_accelerator`) probes the active EP at startup and falls back to CPU when the requested GPU path isn't viable — so the DirectML build auto-degrades to CPU on hosts without a D3D12-capable GPU.

Benchmark notes (whisper-tiny q4, RTX 3080 Ti, idle, N=20, 5 warmup): DirectML p50=85 ms / p95=89 ms / stdev=3 ms vs CUDA p50=120 ms / p95=151 ms / stdev=37 ms. DirectML wins on consistency AND median while being ~10× lighter — hence we no longer ship a separate CUDA installer on Windows.

The `[gpu]` extra in `server/pyproject.toml` (onnxruntime-gpu + the 8 mandatory nvidia-cu12 wheels — cublas, cudnn, cuda-runtime, cuda-nvrtc, cufft, curand, cusparse, cusolver, nvjitlink) is kept for the **eventual Linux NVIDIA build** (`device.py`'s per-OS priority list still favors CUDA on Linux, where DirectML doesn't exist). Don't trim the wheel list — ORT's CUDA EP delay-loads every one of them at session-create time regardless of the model graph, and silently demotes to CPU if any is missing.

Run from the **repo root** — all `.exe` packaging lives under `packaging/`:

```
packaging/
├── electron-builder.yml            # fallback/default config
├── electron-builder.cpu.yml
├── electron-builder.directml.yml   # default GPU
└── stt-server-dist/
    ├── cpu/        # PyInstaller output (CPU flavor)
    └── directml/   # PyInstaller output (DirectML flavor)
```

The final installer lands at `<repo>/dist/`.

| Command | Description |
|---|---|
| `pwsh server/packaging/build.ps1 -Flavor cpu` | Build the CPU `stt-server.exe` → `packaging/stt-server-dist/cpu/` |
| `pwsh server/packaging/build.ps1 -Flavor directml` | Build the DirectML `stt-server.exe` → `packaging/stt-server-dist/directml/` |
| `bun run electron:build:cpu` | Build the CPU installer (root script; reads `packaging/electron-builder.cpu.yml`) |
| `bun run electron:build:directml` | Build the DirectML installer (default GPU; reads `packaging/electron-builder.directml.yml`) |

The release workflow `.github/workflows/electron-release.yml` runs a 2-job matrix (`[cpu, directml]`) on tag push, publishing both installers to the same GitHub Release. Users see two download buttons:
- `WinSTT-Portable-<version>.exe` (DirectML — the unmarked default GPU build)
- `WinSTT-CPU-Portable-<version>.exe`

To cut a release: `git tag v0.X.0 && git push --tags`. The PyInstaller spec at `server/packaging/stt-server.spec` auto-detects whether `nvidia` is in the venv (i.e. the `[gpu]` extra is installed) and bundles CUDA DLLs accordingly — but for shipped Windows builds neither flavor installs `[gpu]`, so no NVIDIA DLLs are bundled. The build script picks the right `[cpu]` / `[directml]` extra before invoking PyInstaller.

The `dev` flow (`bun dev` or `bun electron:dev` from `frontend/`) uses whichever extra is currently installed in `server/.venv`. Run `cd server && uv sync --extra directml` once to make `bun dev` use DirectML (the recommended default).

## Architecture

### Type Contract: OpenAPI Spec

`spec/openapi.yaml` is the single source of truth for all shared types (WebSocket events, control commands, settings schemas, IPC payloads). Changes flow:

1. Edit `spec/openapi.yaml`
2. Run `bun generate` in `frontend/` to regenerate `spec/generated/ts/schema.d.ts`
3. Python server reads the same schemas via its domain events/config

### Server Architecture (Hexagonal / Ports & Adapters)

- **Domain ports** (`src/recorder/domain/ports/`): Six pure ABCs — `IAudioSource`, `ITranscriber`, `IVoiceActivityDetector`, `IWakeWordDetector`, `IDiarizer`, `ISentenceClassifier`
- **Infrastructure** (`src/recorder/infrastructure/`): ~22 concrete adapters with `@override` on every method (PyAudio, Silero/WebRTC/CompositeVAD, Porcupine/OWW/CompositeWakeWord, OnnxAsrTranscriber, RemoteTranscriber for cloud STT, OnnxAsrDiarizer, DistilbertClassifier, device resolver, model cache, custom-model scanner, etc.)
- **Application** (`src/recorder/application/`): `RecorderService` (orchestrator), `RecordingPipeline` (Worker thread), plus `DiarizationStream`, `RealtimeStabilizer`, `VadCalibrator`, `WavWriter`, `SwapBenchmark`, and `dto.py`
- **Bootstrap** (`src/recorder/bootstrap.py`): Helper builders (`build_transcriber`, `build_realtime_transcriber`, `build_diarizer`, `DownloadCallbacks`) + callback-to-event bridge (`wire_callback*`, `CALLBACK_EVENT_MAP`, `WAKE_WORD_BACKENDS`). NOT a Kink container — the facade is the sole composition root.
- **Facade** (`src/recorder/__init__.py`): `AudioToTextRecorder` — backward-compatible 100+ kwargs public API; lazy-inits via `_ensure_service()`
- **TTS sibling** (`src/synthesizer/`): Optional Kokoro-ONNX synthesizer with its own hexagonal split (`domain/ports/synthesizer.py`, infrastructure, application, bootstrap). Sys-path-injected support pack, not frozen into the exe.
- **WebSocket Server** (`src/stt_server/server.py`): Dual-channel (control JSON + binary audio data)

Dependencies point inward. Domain never imports infrastructure. Only bootstrap helpers and the facade touch concrete adapters.

### Frontend Architecture (Electron + Vite + FSD)

- **Electron main process** (`electron/main.ts`, ~1700 LOC): Owns the WebSocket connection to the STT server, spawns/kills the Python process, manages tray and windows
- **Preload bridge** (`electron/preload.ts`): Context bridge exposing IPC channels; strips `IpcRendererEvent` from callbacks
- **IPC handlers** (`electron/ipc/*.ts`): ~50+ modular handlers covering settings, hotkey, audio-mute, stt-process, tray, file-transcribe, relay, history, custom-models, cloud-STT, LLM, Ollama, Apple Intelligence, autostart, clipboard, dialog, diag bundle, etc.
- **WebSocket client** (`electron/ws/stt-client.ts`): Dual-channel client that relays events to renderer via IPC
- **Renderer** (`src/`): **Vite multi-page** static build (no Next.js, no router) with FSD layers — `app/ → views/ → widgets/ → features/ → entities/ → shared/`. Eight HTML entries (main + 7 secondary windows under `windows/`); one `.tsx` per entry under `src/entries/`. Each Electron `BrowserWindow` loads its own HTML directly via `file://` in prod.
- **Native helpers** (`electron/native/src/`): Two compiled C utilities — `winstt-paste.exe` (KEYEVENTF_UNICODE + Ctrl+V fallback) and `winstt-context.exe` (UIA caret-context reader). Built via `bun native:build`.
- **Internal package** (`packages/model-picker/`): Publishable workspace with detached model-picker UI (used in its own BrowserWindow because main window is 420×150 and clips DOM)
- **Zero WebSocket code in renderer** — all server communication flows through Electron main process via IPC

The FSD layer is named `views/` (not `pages/`) so the codebase reads as "FSD-first" rather than mirroring any router convention. There is no router — each window is its own HTML entry.

### Key Technology Choices

| Concern | Server | Frontend |
|---|---|---|
| Package manager | uv | Bun |
| Build tool | hatchling (wheel) + PyInstaller (exe) | Vite 7 (renderer) + tsup (electron-main) |
| Linter/formatter | ruff | Biome 2.x + ultracite |
| Type checker | mypy --strict | tsgo (default) / TypeScript strict |
| Test framework | pytest (100% server-domain coverage; infra/server/client `omit`-ted) | Bun test (unit + property via fast-check) + Playwright (e2e + visual) + Stryker (mutation) |
| DI | Bootstrap-helper composition (Kink installed but the facade is the composition root) | — |
| State management | EventBus pub/sub | Zustand (no TanStack Query — IPC is the data layer) |
| UI components | — | `@base-ui/react` (Base UI by MUI) + Tailwind CSS 4 |
| Icons | — | `@hugeicons/react` + `@hugeicons/core-free-icons` |
| i18n | — | `use-intl` (migrated off `next-intl`); locales: `ar`, `en`, `es`, `fr`, `hi`, `zh` |
| Forms | — | native `<form>` + `useState` + Zod `safeParse` (no form library) |
| AI SDKs | — | Vercel AI SDK (`ai` v6, `@ai-sdk/openai`, `@ai-sdk/elevenlabs`, `@openrouter/ai-sdk-provider`) |

## Critical Conventions

### Server
- `from __future__ import annotations` in every Python file
- `@override` decorator on all ABC method implementations
- `TYPE_CHECKING` guards for annotation-only imports
- ruff rules: `E W F I UP B SIM ANN RUF`, line-length 120
- Event-driven callbacks: legacy `on_*` kwargs are bridged to domain events via `wire_callback()` in bootstrap

### Frontend
- FSD import contract: layers only import from layers below (never sideways). Audited by `bun check:fsd` (~123 rules)
- Barrel files (`index.ts`) with named exports only (no `export *`)
- Path aliases: `@/*` → `src/`, `@spec/*` → `spec/`, `@electron/*` → `electron/`
- Biome: tabs, double quotes, 100-char width
- **No `useMemo` / `useCallback`** — the renderer runs `babel-plugin-react-compiler` (target `19`), gated on `command === "build"` in `vite.config.ts` to keep dev startup fast. Compute inline.
- **Vite multi-page**: 8 HTML entries in `index.html` + `windows/*.html`; each window is its own `BrowserWindow` loading via `file://` in prod. No router.

### CUDA / Torch policy
The server core is **torch-free**. The only opt-in torch dependency is the `[sentence-classifier]` extra (DistilBERT for end-of-turn detection, fail-soft). For Windows GPU we ship `[directml]` (DirectX 12, vendor-agnostic). The `[gpu]` extra (`onnxruntime-gpu` + 8 nvidia-cu12 wheels) is reserved for the future Linux NVIDIA build — see the comment in `server/pyproject.toml` for the full wheel list and why it can't be trimmed.
