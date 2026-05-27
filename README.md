# WinSTT

**A free, open-source, local-first Windows speech-to-text app with optional AI text enhancement and text-to-speech.**

WinSTT pairs a Python STT server with an Electron frontend. **All transcription runs locally** — audio never leaves your machine, no usage analytics. Optional LLM cleanup runs locally via Ollama or remotely via OpenRouter (opt-in). Anonymized crash reports (Sentry) are on by default and can be disabled in settings.

## How It Works

1. **Press** a configurable hotkey to start recording — push-to-talk, toggle, passive loopback, or wake-word.
2. **Speak.** A live transcription preview appears as you go.
3. **Stop** — release the hotkey, press it again, or just stop talking. Voice-activity detection ends the turn for you.
4. **Get** the polished transcription pasted directly into whichever app you were typing into.

The pipeline is entirely local: PortAudio → WebRTC + Silero VAD → ONNX Runtime (Whisper / NeMo / Lite-Whisper / Moonshine / Cohere / GigaAM / Vosk / T-One) → optional Ollama / OpenRouter / Apple Intelligence cleanup → clipboard paste.

## Why WinSTT

- **Local-first by design** — audio is processed in-memory and discarded; the only outbound signal is opt-out Sentry crash reports.
- **30+ models, one engine** — Whisper, Lite-Whisper, NVIDIA NeMo (Parakeet/Canary), Moonshine, Cohere, GigaAM, Vosk/Kaldi, T-One. All ONNX, all swappable from the UI without a restart.
- **No PyTorch in the hot path** — the transcription stack is ONNX-only. Torch is pulled in only by the optional Smart Endpoint extra.
- **Two installers, no Python required** — the bundled `stt-server.exe` is a PyInstaller artifact. End users don't install Python, uv, or any model files.
- **Open source** — every line is auditable. You can verify exactly what runs on your machine.

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
- **CPU, DirectML, or OpenVINO** — three portable installers; each bundles its matching ONNX Runtime EP and falls back to CPU automatically when the GPU path isn't viable

## Download (end users)

Each release publishes three portable installers on the [GitHub Releases](https://github.com/dahshury/WinSTT/releases) page:

| Installer | Size | Use when |
|-----------|------|----------|
| `WinSTT-Portable-<version>.exe` | ~200 MB | **Default GPU build.** Any D3D12-capable GPU (AMD / Intel / NVIDIA). Bundles `onnxruntime-directml`. Falls back to CPU if no GPU. |
| `WinSTT-CPU-Portable-<version>.exe` | ~150 MB | No GPU, or you want the smallest download. CPU-only ORT. |
| `WinSTT-OpenVINO-Portable-<version>.exe` | ~250 MB | Intel ARC dGPU or recent Iris Xe / Arc iGPU. ~10-30 % faster than DirectML on Intel silicon (Intel-published benchmarks). |

All three wrap the same Electron app and a bundled `stt-server.exe` — no Python or extra setup required for end users. The sections below are for **development** only.

> No CUDA installer is shipped on Windows — DirectML is faster and 10× lighter than CUDA on our workload (see the EP benchmark in `server/src/recorder/infrastructure/device.py`). The `[gpu]` extra exists for the future Linux NVIDIA build only.

## Prerequisites (development)

| Tool | Install |
|------|---------|
| [Git](https://git-scm.com/) | Required to clone the repo and the `onnx-asr` dependency |
| [uv](https://docs.astral.sh/uv/) | Python package manager — installs Python and server deps |
| [Bun](https://bun.sh/) | JavaScript runtime — installs frontend deps |
| D3D12-capable GPU | Optional — enables DirectML inference (`directml` extra, recommended default) |
| Intel ARC / Iris Xe / Arc GPU | Optional — enables OpenVINO inference (`openvino` extra) |
| NVIDIA GPU + recent driver | Optional — enables CUDA inference (`gpu` extra; Linux build path only) |
| [Ollama](https://ollama.com) | Optional — enables local LLM cleanup / custom transforms |

> The transcription stack is **ONNX-only**. There is no PyTorch or faster-whisper dependency. PyTorch is pulled in *only* for the optional `sentence-classifier` extra (Smart Endpoint).

## Quick Start (One-Click)

Run the setup script from the repo root:

```bat
setup-dev.bat
```

This installs uv (if missing), Python 3.11, all server + frontend deps. It picks the DirectML flavor by default (works on every modern Windows GPU); override with `setup-dev.bat --flavor cpu`, `--flavor openvino`, or `--flavor gpu` (NVIDIA / Linux only).

## Manual Setup

### 1. Install uv

```powershell
irm https://astral.sh/uv/install.ps1 | iex
```

Add `C:\Users\<you>\.local\bin` to your PATH, then restart your terminal.

### 2. Install server dependencies

`onnx-asr` is fetched directly from `github.com/dahshury/onnx-asr` (pinned commit in `server/pyproject.toml`); no separate clone step needed. Pick a runtime story via one of the mutually-exclusive extras:

```bash
cd server
uv sync --extra cpu           # CPU-only ONNX Runtime (~smallest)
uv sync --extra directml      # AMD / Intel / NVIDIA via DirectX 12 (recommended default)
uv sync --extra openvino      # Intel ARC dGPU or recent Iris Xe / Arc iGPU
uv sync --extra gpu           # onnxruntime-gpu + full NVIDIA CUDA wheels (~2 GB; Linux-only path)
```

Optional extras can be combined: `--extra tts` (Kokoro text-to-speech), `--extra sentence-classifier` (Smart Endpoint, pulls PyTorch).

### 3. Install frontend dependencies

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
uv run stt-server -m tiny.en           # smaller model, faster startup
uv run stt-server --device cpu          # force CPU (regardless of installed EP)
uv run stt-server --accelerator openvino  # pin OpenVINO; auto by default
uv run stt-server -c 8011 -d 8012       # custom WebSocket ports
uv run stt-server --help                # all options
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
├── frontend/        Electron + Vite multi-page React 19 desktop app (FSD architecture)
│   └── packages/    Internal packages (e.g. model-picker)
├── packaging/       electron-builder configs (cpu / directml / openvino) + PyInstaller staging
├── docs/            Fumadocs documentation site
├── spec/            OpenAPI 3.1 spec (shared type contract)
├── examples/        Reference repos used by the rewrite (read-only)
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

WinSTT ships in three flavors per release. Build the server first, then the matching installer:

Run from the **repo root**. All packaging configs and intermediate bundles live under `packaging/` (`electron-builder.{cpu,directml,openvino}.yml`, `stt-server-dist/{cpu,directml,openvino}/`); the final installer lands at `<repo>/dist/`.

| Command | Description |
|---------|-------------|
| `pwsh server/packaging/build.ps1 -Flavor cpu` | Build the CPU `stt-server.exe` → `packaging/stt-server-dist/cpu/` |
| `pwsh server/packaging/build.ps1 -Flavor directml` | Build the DirectML GPU `stt-server.exe` → `packaging/stt-server-dist/directml/` |
| `pwsh server/packaging/build.ps1 -Flavor openvino` | Build the OpenVINO `stt-server.exe` → `packaging/stt-server-dist/openvino/` |
| `bun run electron:build:cpu` | Build the CPU installer (output: `<repo>/dist/`) |
| `bun run electron:build:directml` | Build the DirectML GPU installer (output: `<repo>/dist/`) |
| `bun run electron:build:openvino` | Build the OpenVINO installer (output: `<repo>/dist/`) |

Tagging a release (`git tag v0.X.0 && git push --tags`) runs the three jobs as a matrix and publishes all three installers to the same GitHub Release. DirectML is the unmarked default GPU build because it's lighter (~200 MB vs the retired CUDA build's ~2 GB), faster on our workload, and vendor-agnostic (AMD / Intel / NVIDIA via DirectX 12). OpenVINO is the Intel-tuned alternative — auto-picked ahead of DirectML on Intel silicon when its EP is registered (see `device.py::_AUTO_PRIORITY`).

### macOS-only: Apple Intelligence CLI

When packaging the Electron app for macOS, compile the bundled Apple Intelligence bridge BEFORE running `electron-builder`:

```bash
bash tools/apple-intelligence-cli/build.sh
```

This emits `frontend/electron/resources/macos/winstt-apple-llm` — a tiny Swift binary that the Electron main process spawns to call Apple's on-device `FoundationModels` framework (macOS 15+ Apple Silicon). The script no-ops on Windows/Linux so it's safe to leave in pre-package hook chains; production macOS CI jobs run it explicitly. See `tools/apple-intelligence-cli/main.swift` for the stdin/stdout JSON contract. The corresponding renderer-side provider option is hidden on non-Apple-Silicon platforms.

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
| `bun electron:dev` | Electron + Vite dev mode (alias: `bun dev`) |
| `bun electron:build` | Build distributable |
| `bun typecheck` | TypeScript check (via `tsgo`) |
| `bun lint` | Biome linting |
| `bun test` | Run tests (Bun test runner; e2e via `bun test:e2e`) |
| `bun generate` | Regenerate TS types + Zod schemas from OpenAPI spec |
| `bun check:fsd` | Audit FSD layer/import violations (~123 rules) |
| `bun check:i18n` | Verify locale-key parity across `messages/*.json` |

## System Requirements

**CPU build (`WinSTT-CPU-Portable-*.exe`, ~150 MB):**
- Windows 10 1903+ or Windows 11
- 64-bit x86 CPU with AVX2 (any modern Intel / AMD, ~2015 onwards)
- 4 GB RAM for `tiny`/`base` Whisper, 8 GB+ for Whisper-Turbo / Parakeet
- ~1 GB free disk for the install + ~500 MB per downloaded model

**DirectML build (`WinSTT-Portable-*.exe`, ~200 MB) — default GPU:**
- Same as CPU, plus a D3D12-capable GPU (AMD / Intel / NVIDIA)
- Auto-falls-back to CPU when no compatible GPU is present, so it's safe to install everywhere
- On a 3080 Ti the DirectML EP runs Whisper-tiny-q4 at ~85 ms p50 — roughly 30% faster than CUDA on the same hardware

**OpenVINO build (`WinSTT-OpenVINO-Portable-*.exe`, ~250 MB) — Intel:**
- Same as CPU, plus Intel ARC dGPU, recent Iris Xe iGPU, or any Arc GPU
- ~10-30 % uplift over DirectML on Intel silicon per Intel-published benchmarks
- Auto-falls-back to CPU when no Intel accelerator is present
- Tune the EP target via the `OPENVINO_DEVICE` env var (`AUTO` / `GPU` / `GPU.0` / `CPU`; default `AUTO`)

**Microphone:** any device PortAudio can open. For Listen mode you also need a loopback / monitor device (e.g. VB-Audio Virtual Cable).

**Optional:**
- [Ollama](https://ollama.com) for local LLM cleanup / custom hotkey-triggered transforms
- An OpenRouter API key for cloud LLM cleanup (opt-in)
- macOS 15+ Apple Silicon for the bundled Apple Intelligence provider

## Known Issues

We try to surface issues openly. The current ones, with workarounds where they exist:

- **First-launch CUDA model download** — the GPU build still ships the NVIDIA cu12 wheels for the optional Linux build path; first launch may stall a few seconds while ONNX Runtime probes the device. Force CPU with `--device cpu` if you want a faster startup on machines without a working CUDA stack.
- **Whisper `large-v3-turbo` on 4 GB GPUs** — ONNX Runtime fails to create the session at load time. Pick a smaller variant or fall back to CPU. The picker doesn't pre-check VRAM for custom-dropped models.
- **Listen mode on Bluetooth audio** — some BT stacks expose only a mono 16 kHz endpoint when in headset mode; switch to A2DP or use a wired headset.
- **uiohook-napi global hotkeys on locked-down corporate boxes** — group policies that block low-level keyboard hooks will disable PTT entirely. Use Toggle mode (uses a single key event) or run as Administrator.
- **OneDrive-controlled `%APPDATA%`** — if your AppData is redirected into OneDrive and OneDrive is paused, the HF model cache and `debug.log` can stall. Resume OneDrive or move WinSTT's user data to a local path.

For per-issue diagnostics see [Debug Mode](https://winstt.dahshury.com/docs/debug-mode) and the consolidated [Troubleshooting](https://winstt.dahshury.com/docs/troubleshooting) docs page.

## Roadmap

Actively in progress. Order is rough.

- **Linux build** — the hexagonal server already runs on Linux; what remains is packaging (AppImage / deb / rpm) and the Wayland-friendly CLI hooks (the `cli.mdx` page anticipates this).
- **macOS build** — Electron side is portable; we need the Apple Intelligence CLI hookup hardened in CI and a Metal-aware ONNX Runtime extra.
- **Listen-mode diarization** — real-time speaker labels for meeting transcripts; phase 1 (continuous timeline + stream worker) is shipped, phases 2–6 to follow.
- **More locales** — currently 6 (ar/en/es/fr/hi/zh); target 20+ with a CI lint that fails on hardcoded JSX strings.
- **Opt-in usage analytics** — Sentry crash reports are already opt-out; we want clearly separated, opt-**in** anonymous usage events for feature health.
- **In-app docs viewer** — the docs site is great for the web but offline-first users deserve an Electron-side render.

> **Recently shipped:** STT model unload-on-idle daemon (`server/src/recorder/application/recorder_service.py`); OpenVINO EP for Intel ARC / Iris Xe; OpenAPI 3.1 single-source contract.

If something on this list matters to you, weigh in on [Discussions](https://github.com/dahshury/WinSTT/discussions).

## Troubleshooting

Common issues and fixes live in the docs:

- [Debug Mode](https://winstt.dahshury.com/docs/debug-mode) — how to gather logs and a diagnostic bundle for bug reports.
- [Troubleshooting](https://winstt.dahshury.com/docs/troubleshooting) — blank window, slow transcription, audio device problems, model download failures.
- [Manual Model Install](https://winstt.dahshury.com/docs/manual-model-install) — offline / proxy / firewalled installs of the built-in models.
- [FAQ](https://winstt.dahshury.com/docs/faq).

Bug reports live at [github.com/dahshury/WinSTT/issues](https://github.com/dahshury/WinSTT/issues). Feature ideas live in [Discussions](https://github.com/dahshury/WinSTT/discussions). See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## Verify Release Signatures

Every installer ships a [minisign](https://jedisct1.github.io/minisign/) sidecar (`.minisig`) so you can verify the download offline — in addition to the Authenticode signature Windows already validates. Walkthrough lives in the docs: [Verify Release Signatures](https://winstt.dahshury.com/docs/verify-releases). The public key is `docs/winstt.pub` in this repo.

## Related Projects

- **[onnx-asr](https://github.com/dahshury/onnx-asr)** — the ONNX inference library WinSTT ships. WinSTT depends on a [WinSTT-side fork](https://github.com/dahshury/onnx-asr) (pinned commit in `server/pyproject.toml`) that adds Moonshine / Cohere tokenizers, the Lite-Whisper FP16 patch, and the merged-decoder cache path.
- **[winstt-assets](https://github.com/dahshury/winstt-assets)** — public asset host for the on-demand TTS pack and any future side-loaded resources.
- **[examples/RealtimeSTT](examples/RealtimeSTT)** — the upstream Python monolith WinSTT's hexagonal refactor was derived from. Kept in-tree as a reference for behavioral parity.

## Contributing

Bug fixes, doc improvements, and new STT model adapters are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, code style, and how to file an issue or open a PR.

## License

MIT — see [LICENSE](LICENSE). Third-party model and library licenses are catalogued in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Acknowledgments

WinSTT stands on a lot of open-source work. In no particular order:

- **OpenAI Whisper** and the **whisper.cpp / onnx-community** maintainers who keep ONNX exports current
- **NVIDIA NeMo** for Parakeet and Canary
- **Lite-Whisper** authors for the compressed Whisper variants
- **Moonshine** (Useful Sensors) and **Cohere** for their open ASR models
- **GigaAM**, **Vosk/Kaldi**, **T-One** — Russian-language ASR families
- **Silero** for the lightweight VAD
- **Picovoice Porcupine** for free-tier wake words
- **Kokoro-82M** for the bundled ONNX TTS voice
- **ONNX Runtime** + **DirectML** + **PyTorch** teams
- **Electron**, **Next.js**, **Vite**, **Bun**, and the **Tauri / Handy** project — the latter inspired several sections of this README and the docs structure
- **Fumadocs** for the docs site framework
- **uv**, **ruff**, **mypy**, **Biome** — toolchain that makes a dual-language repo bearable
</content>
</invoke>
