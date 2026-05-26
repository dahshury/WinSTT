# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 🛑 **NEVER run `git stash` in any form** — not `git stash`, not `git stash --keep-index`, not `git stash push`, not `git stash save`. The repo's working tree is huge and stash conflicts have repeatedly held in-progress refactors hostage. Two separate incidents on record (see `memory/feedback_no_git_stash.md`). Defenses in place: (a) `.husky/reference-transaction` blocks CREATE/UPDATE of `refs/stash`; (b) `.claude/settings.local.json` denies `git stash*` Bash commands; (c) the harness denylist blocks `git stash pop` / `git stash apply`. If you need a side copy, use `cp <file> <file>.bak`. If you need to compare against HEAD, use `git show HEAD:<path>`. If you genuinely need an isolated checkout, use `git worktree add ../winstt-scratch`.

## Project Overview

WinSTT is a Windows speech-to-text desktop application with a Python backend (WebSocket STT server) and an Electron frontend. The two communicate over dual WebSocket channels (control JSON + binary audio data).

## Repository Structure

```
WinSTT/
├── server/          # Python STT engine (hexagonal architecture)
├── frontend/        # Electron + Next.js 16 desktop app (FSD architecture)
├── spec/            # OpenAPI spec (single source of truth for shared types)
└── examples/        # Reference monolith + skill guides
```

Each sub-project has its own detailed `CLAUDE.md`:
- `server/CLAUDE.md` — hexagonal architecture rulebook, layer hierarchy, port/adapter patterns, threading model
- `frontend/CLAUDE.md` — Feature-Sliced Design rulebook, layer/segment/slice conventions, import contracts

## Commands

### Server (Python — run from `server/`)

| Command | Description |
|---|---|
| `make` | Full check: format + lint + mypy + tests |
| `uv run pytest` | Run all tests |
| `uv run pytest tests/unit/recorder/test_state_machine.py` | Single test file |
| `uv run pytest -k "test_name"` | Single test by name |
| `uv run ruff format .` | Format |
| `uv run ruff check . --fix` | Lint with auto-fix |
| `uv run mypy src/ --strict` | Type check (strict mode, zero errors required) |

### Frontend (TypeScript — run from `frontend/`)

| Command | Description |
|---|---|
| `bun dev` | Next.js dev server |
| `bun electron:dev` | Full Electron + Next.js dev |
| `bun build` | Production Next.js build |
| `bun electron:build` | Build distributable Electron app |
| `bun typecheck` | TypeScript type checking |
| `bun lint` | Biome linting |
| `bun lint:fix` | Biome lint with auto-fix |
| `bun format` | Biome format |
| `bun test` | Run tests (Bun test runner) |
| `bun generate` | Regenerate TS types from OpenAPI spec |
| `bun knip` | Detect unused exports/files |

### Packaging (release builds — produces three portable installers)

WinSTT ships in three flavors per release:

| Flavor | Size | ORT wheel | When to use |
|---|---|---|---|
| **DirectML** (default GPU) | ~200 MB | `onnxruntime-directml` | Any Windows GPU (AMD / Intel / NVIDIA via DirectX 12). This is the unmarked default download. |
| **CPU** | ~150 MB | `onnxruntime` | Servers, headless boxes, NPU-less laptops, or anyone who wants the smallest bundle. |
| **CUDA** (legacy) | ~2 GB | `onnxruntime-gpu` + 8 NVIDIA cu12 wheels | Power users on NVIDIA hardware who want the absolute minimum latency on long-form / batched workloads. |

All three wrap the same Electron app; only the bundled `stt-server.exe` differs. The runtime in `server/src/recorder/infrastructure/device.py` (`resolve_accelerator`) probes the active EP at startup and falls back to CPU when the requested GPU path isn't viable — a user who installs the CUDA build on a machine without a working CUDA stack still gets a functional app, and the DirectML build auto-degrades to CPU on hosts without a D3D12-capable GPU.

Benchmark notes (whisper-tiny q4, RTX 3080 Ti, idle, N=20, 5 warmup): DirectML p50=85 ms / p95=89 ms / stdev=3 ms vs CUDA p50=120 ms / p95=151 ms / stdev=37 ms. DirectML wins on consistency AND median while being ~10x lighter, hence the default-flip.

Run from the **repo root** — all `.exe` packaging lives under `packaging/`:

```
packaging/
├── electron-builder.yml
├── electron-builder.cpu.yml
├── electron-builder.directml.yml   # default GPU
├── electron-builder.gpu.yml        # legacy NVIDIA-only CUDA
└── stt-server-dist/
    ├── cpu/        # PyInstaller output (CPU flavor)
    ├── directml/   # PyInstaller output (DirectML flavor)
    └── gpu/        # PyInstaller output (CUDA flavor)
```

The final installer lands at `<repo>/dist/`.

| Command | Description |
|---|---|
| `pwsh server/packaging/build.ps1 -Flavor cpu` | Build the CPU `stt-server.exe` → `packaging/stt-server-dist/cpu/` |
| `pwsh server/packaging/build.ps1 -Flavor directml` | Build the DirectML `stt-server.exe` → `packaging/stt-server-dist/directml/` |
| `pwsh server/packaging/build.ps1 -Flavor gpu` | Build the CUDA `stt-server.exe` → `packaging/stt-server-dist/gpu/` |
| `bun run electron:build:cpu` | Build the CPU installer (root script; reads `packaging/electron-builder.cpu.yml`) |
| `bun run electron:build:directml` | Build the DirectML installer (default GPU; reads `packaging/electron-builder.directml.yml`) |
| `bun run electron:build:gpu` | Build the CUDA installer (legacy NVIDIA; reads `packaging/electron-builder.gpu.yml`) |

The release workflow `.github/workflows/electron-release.yml` runs the matrix on tag push, publishing all three installers to the same GitHub Release. Users see three download buttons:
- `WinSTT-Portable-<version>.exe` (DirectML — the unmarked default GPU build)
- `WinSTT-CPU-Portable-<version>.exe`
- `WinSTT-GPU-Portable-<version>.exe` (CUDA legacy)

To cut a release: `git tag v0.X.0 && git push --tags`. The PyInstaller spec at `server/packaging/stt-server.spec` auto-detects whether `nvidia` is in the venv (CUDA flavor) and bundles DLLs accordingly — the build script picks the right `[cpu]` / `[directml]` / `[gpu]` extra before invoking it.

## Architecture

### Type Contract: OpenAPI Spec

`spec/openapi.yaml` is the single source of truth for all shared types (WebSocket events, control commands, settings schemas, IPC payloads). Changes flow:

1. Edit `spec/openapi.yaml`
2. Run `bun generate` in `frontend/` to regenerate `spec/generated/ts/schema.d.ts`
3. Python server reads the same schemas via its domain events/config

### Server Architecture (Hexagonal / Ports & Adapters)

- **Domain ports** (`src/recorder/domain/ports/`): Pure ABCs — `IAudioSource`, `ITranscriber`, `IVoiceActivityDetector`, `IWakeWordDetector`
- **Infrastructure** (`src/recorder/infrastructure/`): Concrete adapters with `@override` on every method
- **Application** (`src/recorder/application/`): `RecorderService` (orchestrator) + `RecordingPipeline` (Worker thread)
- **Bootstrap** (`src/recorder/bootstrap.py`): Sole composition root (Kink DI container)
- **Facade** (`src/recorder/__init__.py`): `AudioToTextRecorder` — backward-compatible 100+ kwargs public API
- **WebSocket Server** (`src/stt_server/server.py`): Dual-channel (control JSON + binary audio data)

Dependencies point inward. Domain never imports infrastructure. Only bootstrap and facade instantiate concrete adapters.

### Frontend Architecture (Electron + Next.js + FSD)

- **Electron main process** (`electron/main.ts`): Owns the WebSocket connection to the STT server, spawns/kills the Python process, manages tray and windows
- **Preload bridge** (`electron/preload.ts`): Context bridge exposing IPC channels; strips `IpcRendererEvent` from callbacks
- **IPC handlers** (`electron/ipc/*.ts`): Modular handlers for settings, hotkey, audio-mute, stt-process, tray, file-transcribe, relay
- **WebSocket client** (`electron/ws/stt-client.ts`): Dual-channel client that relays events to renderer via IPC
- **Renderer** (`src/`): Next.js 16 static export with FSD layers — `app/ → views/ → widgets/ → features/ → entities/ → shared/`
- **Zero WebSocket code in renderer** — all server communication flows through Electron main process via IPC

FSD layer `views/` is used instead of `pages/` to avoid Next.js Pages Router conflict.

### Key Technology Choices

| Concern | Server | Frontend |
|---|---|---|
| Package manager | uv | Bun |
| Linter/formatter | ruff | Biome 2.x + ultracite |
| Type checker | mypy --strict | TypeScript strict |
| Test framework | pytest (100% coverage required) | Bun test runner |
| DI | Kink | — |
| State management | EventBus pub/sub | Zustand + TanStack Query |
| UI components | — | Base UI (baseui) + Styletron |
| Icons | — | @hugeicons/react + @hugeicons/core-free-icons |

## Critical Conventions

### Server
- `from __future__ import annotations` in every Python file
- `@override` decorator on all ABC method implementations
- `TYPE_CHECKING` guards for annotation-only imports
- ruff rules: `E W F I UP B SIM ANN RUF`, line-length 120
- Event-driven callbacks: legacy `on_*` kwargs are bridged to domain events via `wire_callback()` in bootstrap

### Frontend
- FSD import contract: layers only import from layers below (never sideways)
- Barrel files (`index.ts`) with named exports only (no `export *`)
- Path aliases: `@/*` → `src/`, `@spec/*` → `spec/`, `@electron/*` → `electron/`
- Biome: tabs, double quotes, 100-char width
- `output: "export"` — Next.js builds to static HTML loaded by Electron

### CUDA/PyTorch
Plain `"torch"` from PyPI is CPU-only. The server's `pyproject.toml` uses `[[tool.uv.index]]` with `explicit = true` pointing to `https://download.pytorch.org/whl/cu124` and `[tool.uv.sources]` to resolve CUDA-enabled torch. Don't change this without understanding the implications.
