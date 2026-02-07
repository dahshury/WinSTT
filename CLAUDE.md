# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WinSTT is a real-time Speech-to-Text system with a Python backend (`server/`) and a frontend (`frontend/`). The server is a hexagonal-architecture refactor of the monolith at `examples/RealtimeSTT/RealtimeSTT/audio_recorder.py`.

## Commands

### Server (working directory: `server/`)

| Command | Description |
|---|---|
| `make` or `make all` | Run format + lint + mypy + tests (the full check) |
| `uv run pytest` | Run all tests |
| `uv run pytest tests/unit/recorder/test_state_machine.py` | Run a single test file |
| `uv run pytest tests/unit/ -k "test_name"` | Run a specific test by name |
| `uv run ruff format .` | Format code |
| `uv run ruff check . --fix` | Lint with auto-fix |
| `uv run mypy src` | Type check (strict mode) |

### Frontend (working directory: `frontend/`)

| Command | Description |
|---|---|
| `bun typecheck` | TypeScript type checking (NOT `npx tsc`) |
| `bun dev` | Start development server |
| `bun build` | Production build |
| `bun lint` | ESLint |

## Server Architecture

### Hexagonal Architecture (Ports & Adapters)

```
server/src/
├── building_blocks/          # Shared primitives: Clock, EventBus, Worker, types, errors
├── recorder/
│   ├── domain/
│   │   ├── ports/            # Abstract interfaces (IAudioSource, ITranscriber, IVoiceActivityDetector, IWakeWordDetector)
│   │   ├── state_machine.py  # RecorderState: INACTIVE → LISTENING/WAKEWORD → RECORDING → TRANSCRIBING → INACTIVE
│   │   ├── config.py         # Pydantic config hierarchy (AudioConfig, VADConfig, TranscriptionConfig, etc.)
│   │   ├── events.py         # Domain events (frozen dataclasses)
│   │   └── errors.py         # Domain error hierarchy (extends DomainError)
│   ├── application/
│   │   ├── recorder_service.py  # Orchestrator - wires ports together
│   │   ├── pipeline.py          # RecordingPipeline (Worker thread for audio processing)
│   │   └── dto.py               # Data transfer objects
│   ├── infrastructure/       # Adapters: PyAudioSource, FileAudioSource, WebRTCVAD, SileroVAD, CompositeVAD,
│   │                         #   WhisperTranscriber, RealtimeTranscriber, PorcupineDetector, OWWDetector
│   ├── bootstrap.py          # DI wiring via Kink container
│   ├── client.py             # AudioToTextRecorderClient (WebSocket client)
│   └── __init__.py           # AudioToTextRecorder facade (backward-compatible with monolith's 100+ kwargs)
└── stt_server/               # WebSocket STT server (control + data channels)
```

### Key Patterns

- **Ports**: ABCs in `domain/ports/` define contracts (`IAudioSource`, `ITranscriber`, `IVoiceActivityDetector`, `IWakeWordDetector`). Multiple adapters per port (e.g., WebRTC + Silero for VAD, Picovoice + OpenWakeWord for wake words).
- **DI**: Kink container. `bootstrap.py` wires all dependencies. Constructor injection throughout.
- **Events**: Thread-safe `EventBus` pub/sub. Domain events decouple components. Legacy callbacks are bridged to events during bootstrap.
- **State Machine**: Enforces valid `RecorderState` transitions; invalid transitions raise `InvalidStateTransition`.
- **Threading**: `Worker` base class for background threads. Pipeline runs audio reader + VAD + transcription in separate thread.
- **Clock**: Abstracted for testability (`Clock.system_clock()` vs `Clock.fixed()`).
- **Types**: `AudioChunk = bytes`, `AudioArray = NDArray[np.float32]`, `SampleRate`, `BufferSize` (NewType wrappers).

### Testing

- `tests/unit/` — pure domain logic with mocked deps
- `tests/integration/` — multi-component collaboration (bootstrap, pipeline, facade, e2e)
- `tests/fakes/` — test doubles: `FakeAudioSource`, `FakeTranscriber`, `FakeVAD`, `FakeWakeWord`
- 100% coverage required (`fail_under = 100`), with infrastructure/server/client excluded via `omit`

## Server Code Standards

- **Python 3.11+**, `from __future__ import annotations` in all files
- **mypy --strict** with Pydantic plugin; overrides for untyped libs (pyaudio, torch, faster_whisper, etc.)
- **ruff**: line-length 120, rules: E, W, F, I, UP, B, SIM, ANN, RUF
- **Pre-commit hooks**: trailing-whitespace, ruff format/check, mypy --strict
- All function signatures must have type annotations

## Frontend Architecture

Uses **Feature-Sliced Design (FSD)**: `app/ → pages/ → widgets/ → features/ → entities/ → shared/`. Each layer may only import from layers below. Every slice exposes a single `index.ts` public API. See `frontend/CLAUDE.md` for the full FSD rulebook.

## Monolith Reference

The original monolith lives at `examples/RealtimeSTT/`. The `AudioToTextRecorder` facade in `server/src/recorder/__init__.py` preserves backward compatibility with its 100+ kwargs API, so demo scripts in `server/examples/` (17 scripts) work with minimal changes.
