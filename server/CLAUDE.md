# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

| Command | Description |
|---|---|
| `make` or `make all` | Format + lint + mypy + tests (full check) |
| `uv run pytest` | Run all tests |
| `uv run pytest tests/unit/recorder/test_state_machine.py` | Single test file |
| `uv run pytest tests/unit/ -k "test_name"` | Single test by name |
| `uv run ruff format .` | Format code |
| `uv run ruff check . --fix` | Lint with auto-fix |
| `uv run mypy src/ --strict` | Type check |

---

# Hexagonal Architecture Rulebook

> **Core:** `src/` follows Ports & Adapters. Dependencies point **inward**. Domain knows nothing about infrastructure.

---

## 1. Layer Hierarchy

```
src/
  building_blocks/      # Cross-cutting primitives (Clock, EventBus, Worker, types, errors)
  recorder/
    domain/
      ports/            # Abstract interfaces (IAudioSource, ITranscriber, IVAD, IWakeWord)
      state_machine.py  # RecorderState transitions
      config.py         # Pydantic config hierarchy
      events.py         # Frozen dataclass domain events
      errors.py         # DomainError hierarchy
      audio_buffer.py   # Pre-roll + recording frame buffer
    application/
      recorder_service.py  # Orchestrator — owns lifecycle & threads
      pipeline.py          # RecordingPipeline (Worker) — VAD loop & state machine
      dto.py               # Data transfer objects
    infrastructure/     # Concrete adapters (PyAudio, WebRTC, Silero, Whisper, etc.)
    bootstrap.py        # DI wiring (Kink container)
    __init__.py         # AudioToTextRecorder facade (100+ kwargs, lazy init)
    client.py           # WebSocket client
  stt_server/           # WebSocket STT server (control + data channels)
```

### Import Contract

| Layer | May Import From |
|---|---|
| domain/ports | building_blocks, stdlib only |
| domain (events, config, state_machine) | building_blocks, domain/ports |
| application | domain, building_blocks |
| infrastructure | domain, building_blocks (NEVER application) |
| bootstrap | everything (sole exception — wires DI) |
| facade (`__init__.py`) | everything (public API, hides architecture) |

**Invalid imports that break the architecture:**
- Domain importing infrastructure (`from infrastructure.pyaudio_source import ...`)
- Infrastructure importing application (`from application.pipeline import ...`)
- Port importing another port (`from ports.vad import ...` inside `ports/audio_source.py`)

---

## 2. Ports (Abstract Interfaces)

All ports are ABCs in `domain/ports/`. Prefix: `I`. Multiple adapters per port.

| Port | Methods | Adapters |
|---|---|---|
| `IAudioSource` | `setup()`, `read_chunk() → AudioChunk`, `cleanup()`, `is_active`, `sample_rate`, `buffer_size` | PyAudioSource, FileAudioSource |
| `ITranscriber` | `transcribe(audio, lang) → TranscriptionResult`, `is_ready()`, `shutdown()` | WhisperTranscriber, RealtimeTranscriber |
| `IVoiceActivityDetector` | `detect(chunk) → VADResult`, `reset()` | WebRTCVAD, SileroVAD, CompositeVAD |
| `IWakeWordDetector` | `detect(chunk) → WakeWordResult`, `cleanup()` | PorcupineDetector, OWWDetector |

**Rule:** New adapters implement the port ABC with `@override` on every method.

---

## 3. Building Blocks

Shared by all layers. No domain-specific logic here.

| Module | Purpose |
|---|---|
| `types.py` | `AudioChunk = bytes`, `AudioArray = NDArray[float32]`, `SampleRate`, `BufferSize` (NewType), `SimpleCallback`, `TextCallback`, `ChunkCallback`, `CallbackMap` |
| `errors.py` | `DomainError` base → `AudioError`, `TranscriptionError`, `VADError`, `ConfigurationError`, `PipelineError`, `WakeWordError` |
| `event_bus.py` | Thread-safe pub/sub. `subscribe(type, handler)`, `publish(event)`. Handlers run on publisher's thread. |
| `worker.py` | `Worker(ABC)` — daemon thread with `start()`, `stop()`, `should_stop` flag. Subclass implements `_run()`. |
| `clock.py` | `Clock.system_clock()` for production, `Clock.fixed_clock(t)` for tests. All time access via `clock.get_current_time()`. |

---

## 4. Domain Events

Frozen dataclasses inheriting `RecorderEvent(timestamp)`. Published via `EventBus`, never called directly.

```
RecordingStarted, RecordingStopped
TranscriptionStarted, TranscriptionCompleted(text)
VADStarted, VADStopped, VADDetectStarted, VADDetectStopped
TurnDetectionStarted, TurnDetectionStopped
WakeWordDetected(word_index, word), WakeWordTimeout
RealtimeTranscriptionUpdate(text), RealtimeTranscriptionStabilized(text)
AudioChunkRecorded(chunk)
```

**Rule:** Legacy callbacks (e.g., `on_recording_start`) are bridged to events in `bootstrap.py` via `wire_callback()` / `wire_callback_with_text()`. Application code uses events, not raw callbacks.

---

## 5. State Machine

```
INACTIVE → LISTENING → RECORDING → TRANSCRIBING → INACTIVE
              ↕
          WAKEWORD
```

- `RecorderStateMachine.transition(new_state)` — raises `InvalidStateTransition` if edge doesn't exist
- `abort()` — force to INACTIVE from any state
- Only `RecordingPipeline` drives transitions (single-threaded access)

---

## 6. Application Layer

### RecorderService (Orchestrator)
- Owns: `RecordingPipeline`, audio reader thread, realtime worker thread
- `text(callback) → str` — blocking: listen → wait → transcribe → return
- `start()` / `stop()` — manual recording control
- `set_microphone(bool)` — toggle mic; silence frames injected when off (PTT pattern)
- `wait_audio() → bool` — blocks until pipeline produces audio; `False` on timeout
- Constructor injection: all ports + config + event_bus + clock

### RecordingPipeline (Worker Thread)
- Processes audio queue: read chunk → VAD → state transition → buffer
- `request_listen()` → enter LISTENING, enable VAD onset detection
- `request_start()` → force RECORDING (bypasses VAD — used by PTT)
- `request_stop()` → RECORDING → TRANSCRIBING, enqueue for transcription
- `post_speech_silence_duration` — settable at runtime (PTT sets 9999 during hold, 0.15 on release)

---

## 7. Facade (`AudioToTextRecorder`)

The public API. Backward-compatible with monolith's 100+ kwargs.

- **Lazy init:** `_ensure_service()` builds everything on first use (double-checked lock)
- **Callback wiring:** Constructor kwargs like `on_recording_start=fn` are stored in `CallbackMap`, bridged to events during init
- **Delegates everything** to `RecorderService` methods
- `_create_with_service()` — test factory for injecting a pre-built service

---

## 8. DI & Bootstrap

**Kink container.** `bootstrap.py` is the single composition root.

```python
bootstrap_di(config, callbacks) → RecorderService
```

1. Create EventBus + Clock
2. Wire callbacks → events
3. Build adapters (audio source, VAD, transcriber, wake word)
4. Register in `di[IPort] = adapter`
5. Create & return RecorderService

**Rule:** Only `bootstrap.py` and the facade instantiate infrastructure. Application/domain never `import` concrete adapters.

---

## 9. Threading Model

| Thread | Owner | Purpose |
|---|---|---|
| Main | Caller | `text()` blocks here; facade init |
| Audio reader | `RecorderService` | Reads PyAudio → feeds pipeline queue |
| Pipeline worker | `RecordingPipeline` | VAD checks, state transitions, buffering |
| Realtime worker | `RecorderService` | Periodic transcription for live display |

**Synchronization:** `_audio_queue` and `_transcription_queue` (thread-safe `Queue`). `AudioBuffer` accessed only by pipeline thread. `EventBus.publish()` holds internal lock.

---

## 10. Testing

| Directory | What | Dependencies |
|---|---|---|
| `tests/unit/` | Pure domain logic | Zero — no I/O, no threads |
| `tests/integration/` | Multi-component (service, pipeline, facade, e2e) | Fakes, fixed clocks |
| `tests/fakes/` | `FakeAudioSource`, `FakeTranscriber`, `FakeVAD`, `FakeWakeWord` | Domain ports only |

- **100% coverage** required (`fail_under = 100`); infrastructure/server/client excluded via `omit`
- **Clock injection:** Tests use `Clock.fixed_clock()` for deterministic time
- **No real hardware:** `FakeAudioSource` feeds synthetic PCM; `FakeTranscriber` returns canned text

---

## 11. Code Standards

- **Python 3.11+**, `from __future__ import annotations` in every file
- **mypy --strict** with Pydantic plugin; `[[tool.mypy.overrides]]` for untyped libs
- **ruff**: line-length 120, rules `E W F I UP B SIM ANN RUF`
- **`@override`** on all ABC method implementations (from `typing` or `typing_extensions`)
- **TYPE_CHECKING guards** for annotation-only imports (prevents ruff F401 with `__future__` annotations)
- All function signatures fully annotated; no `Any` escape hatches except legacy facade kwargs

---

## 12. Monolith Reference

Original: `examples/RealtimeSTT/RealtimeSTT/audio_recorder.py`. Key differences from our refactor:

| Aspect | Monolith | Hexagonal |
|---|---|---|
| VAD | WebRTC pre-check → async Silero in background thread | CompositeVAD: synchronous AND of WebRTC + Silero |
| Callbacks | Direct function calls from audio thread | EventBus pub/sub, bridged in bootstrap |
| Config | 100+ instance attributes | Pydantic hierarchy (AudioConfig, VADConfig, etc.) |
| Threading | Manual thread management | `Worker` base class, daemon threads |
| State | Implicit flags (`is_recording`, `is_silero_speech_active`) | Explicit `RecorderStateMachine` with guarded transitions |
