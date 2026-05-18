# WinSTT

Windows speech-to-text desktop application with optional AI text enhancement and text-to-speech. A Python backend (WebSocket STT server) paired with an Electron frontend. **All transcription runs locally** — audio never leaves your machine, no usage analytics. Optional LLM cleanup runs locally via Ollama, or via OpenRouter if you opt in. Anonymized crash reports (Sentry) are on by default and can be disabled in settings.

## Features

- **Real-time transcription** — live preview while you speak (fast model) plus an accurate final pass (main model)
- **30+ STT models** — Whisper, Lite-Whisper, NVIDIA NeMo (Parakeet/Canary), GigaAM, Vosk/Kaldi, T-One — all ONNX, switchable from the UI
- **Four recording modes** — push-to-talk, toggle, **listen** (passive loopback capture), and **wake word** (Porcupine)
- **LLM text enhancement** — clean up dictation or run custom hotkey-triggered transforms via local Ollama or OpenRouter
- **Text-to-speech** — read selected text aloud with the bundled Kokoro-82M ONNX voice model
- **File transcription** — drop audio files, export plain text or SRT subtitles
- **Custom dictionary & snippets** — fuzzy-match term correction and trigger-based text expansion
- **Transcription history dashboard** — local log of every dictation with stats, an activity heatmap, and search
- **Localized UI** — English, Spanish, French, Chinese, Hindi, Arabic
- **CPU or GPU** — ships as two installers; GPU build bundles the full CUDA stack and falls back to CPU automatically

## Download (end users)

Each release publishes two NSIS installers on the [GitHub Releases](https://github.com/dahshury/winstt2/releases) page:

| Installer | Size | Use when |
|-----------|------|----------|
| `WinSTT-CPU-Setup-<version>.exe` | ~150 MB | No NVIDIA GPU, or you want the smaller download |
| `WinSTT-GPU-Setup-<version>.exe` | ~2 GB | You have an NVIDIA GPU + recent driver (bundles CUDA; falls back to CPU if unavailable) |

Both wrap the same Electron app and a bundled `stt-server.exe` — no Python or extra setup required for end users. The sections below are for **development** only.

## Prerequisites (development)

| Tool | Install |
|------|---------|
| [Git](https://git-scm.com/) | Required to clone the repo and the `onnx-asr` dependency |
| [uv](https://docs.astral.sh/uv/) | Python package manager — installs Python and server deps |
| [Bun](https://bun.sh/) | JavaScript runtime — installs frontend deps |
| NVIDIA GPU + recent driver | Optional — enables CUDA-accelerated inference (`gpu` extra) |
| [Ollama](https://ollama.com) | Optional — enables local LLM cleanup / custom transforms |

> The transcription stack is **ONNX-only**. There is no PyTorch or faster-whisper dependency. PyTorch is pulled in *only* for the optional `sentence-classifier` extra (Smart Endpoint).

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

Pick a GPU story via the `cpu` or `gpu` extra:

```bash
cd server
uv sync --extra cpu          # CPU-only ONNX Runtime (~small)
# or
uv sync --extra gpu          # onnxruntime-gpu + full NVIDIA CUDA wheels (~2 GB)
```

Optional extras can be combined: `--extra tts` (Kokoro text-to-speech), `--extra sentence-classifier` (Smart Endpoint, pulls PyTorch).

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

The app connects to the server over dual WebSocket channels (control JSON on 8011, binary audio on 8012 by default).

## Project Structure

```
WinSTT/
├── server/          Python STT + TTS engine (hexagonal architecture)
├── frontend/        Electron + Next.js desktop app (FSD architecture)
│   └── packages/    Internal packages (e.g. model-picker)
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

## Packaging (release builds)

WinSTT ships in two flavors per release. Build the server first, then the matching installer:

| Command | Description |
|---------|-------------|
| `pwsh server/packaging/build.ps1 -Flavor cpu` | Build the CPU `stt-server.exe` → `frontend/stt-server-dist-cpu/` |
| `pwsh server/packaging/build.ps1 -Flavor gpu` | Build the GPU `stt-server.exe` → `frontend/stt-server-dist-gpu/` |
| `bun run electron:build:cpu` | Build the CPU installer |
| `bun run electron:build:gpu` | Build the GPU installer |

Tagging a release (`git tag v0.X.0 && git push --tags`) runs the CPU + GPU jobs as a matrix and publishes both installers to the same GitHub Release.

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
| `bun generate` | Regenerate TS types from OpenAPI spec |
</content>
</invoke>
