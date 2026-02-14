# WinSTT

Windows speech-to-text desktop application with optional AI-powered text enhancement. Python backend (WebSocket STT server) + Electron frontend. All processing runs locally — no cloud APIs, no telemetry.

## Prerequisites

| Tool | Install |
|------|---------|
| [Git](https://git-scm.com/) | Required to clone the repo and the `onnx-asr` dependency |
| [uv](https://docs.astral.sh/uv/) | Python package manager — installs Python and server deps |
| [Bun](https://bun.sh/) | JavaScript runtime — installs frontend deps |
| NVIDIA GPU + [CUDA 12.4](https://developer.nvidia.com/cuda-toolkit) | Optional but recommended for fast inference |
| [Ollama](https://ollama.com) | Optional — enables LLM post-processing of transcriptions |

## Quick Start (One-Click)

Run the setup script from the repo root:

```bat
setup-dev.bat
```

This installs uv (if missing), Python 3.11, clones the `onnx-asr` dependency, and installs all packages for both server and frontend.

## Manual Setup

### 1. Install uv

```powershell
irm https://astral.sh/uv/install.ps1 | iex
```

Add `C:\Users\<you>\.local\bin` to your PATH, then restart your terminal.

### 2. Clone onnx-asr (local dependency)

```bash
mkdir examples
git clone https://github.com/istupakov/onnx-asr.git examples/onnx-asr
```

### 3. Install server dependencies

```bash
cd server
uv sync
```

This installs Python 3.11 (if missing), CUDA-enabled PyTorch, Whisper, and all other server packages into a local `.venv`.

### 4. Install frontend dependencies

```bash
cd frontend
bun install
```

## Running

### Start the STT server

```bash
cd server
uv run stt-server
```

Common flags:

```bash
uv run stt-server -m tiny.en          # smaller model, faster startup
uv run stt-server --device cpu         # force CPU (no CUDA)
uv run stt-server -c 8011 -d 8012     # custom WebSocket ports
uv run stt-server --help               # all options
```

### Start the Electron app

In a separate terminal:

```bash
cd frontend
bun electron:dev
```

The app connects to the server over WebSocket (ports 8011/8012 by default).

## Project Structure

```
WinSTT/
├── server/          Python STT engine (hexagonal architecture)
├── frontend/        Electron + Next.js desktop app (FSD architecture)
├── docs/            Fumadocs documentation site
├── spec/            OpenAPI spec (shared type contract)
├── examples/        Local dependencies (gitignored)
│   └── onnx-asr/    ONNX ASR library (cloned during setup)
├── setup-dev.bat    One-click dev environment setup
└── CLAUDE.md        AI assistant instructions
```

## Docs Site

```bash
cd docs
bun install
bun dev
```

Opens at http://localhost:3000.

## Useful Commands

### Server (`server/`)

| Command | Description |
|---------|-------------|
| `uv run stt-server` | Start the STT server |
| `uv run pytest` | Run tests |
| `uv run ruff format .` | Format code |
| `uv run ruff check . --fix` | Lint with auto-fix |
| `uv run mypy src/ --strict` | Type check |
| `make` | All of the above |

### Frontend (`frontend/`)

| Command | Description |
|---------|-------------|
| `bun electron:dev` | Electron + Next.js dev mode |
| `bun electron:build` | Build distributable |
| `bun typecheck` | TypeScript check |
| `bun lint` | Biome linting |
| `bun test` | Run tests |
