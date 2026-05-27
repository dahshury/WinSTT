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
  building_blocks/      # Cross-cutting primitives (Clock, EventBus, Worker, types, errors, terminal)
  recorder/
    domain/
      ports/            # 6 abstract interfaces (IAudioSource, ITranscriber, IVAD, IWakeWord,
                        #                       IDiarizer, ISentenceClassifier)
      state_machine.py  # RecorderState transitions
      config.py         # Pydantic config hierarchy
      events.py         # 30+ frozen dataclass domain events
      errors.py         # DomainError hierarchy
      audio_buffer.py   # Pre-roll + recording frame buffer
      catalog.json      # Single source of truth for the STT model catalog (7 families)
      model_registry.py # Catalog accessor + overlay
      custom_models.py  # Custom-user-model schema
      speaker_timeline.py
      swap_errors.py
    application/
      recorder_service.py    # Orchestrator — owns lifecycle & threads
      pipeline.py            # RecordingPipeline (Worker) — VAD loop & state machine
      realtime_stabilizer.py # Commonprefix monotonic safetext + tail-merge (RealtimeSTT port)
      diarization_stream.py  # Real-time diarized subtitle stream
      vad_calibrator.py      # Adaptive sensitivity calibration
      wav_writer.py          # Optional WAV persistence (gated by HistoryConfig.save_wav)
      swap_benchmark.py      # Model-swap latency benchmarking
      dto.py                 # Data transfer objects
    infrastructure/   # ~22 concrete adapters (PyAudio, WebRTC, Silero, OnnxAsr, Remote, Porcupine,
                      #  OWW, Composite*, OnnxAsrDiarizer, DistilbertClassifier, FileAudioSource,
                      #  device resolver, model cache, custom-model scanner, onnx fp16 patcher,
                      #  fit assessment, live resources, seed cache, system_info, model_state)
    bootstrap.py      # Reusable adapter/callback builders (NOT a Kink container — see §8)
    __init__.py       # AudioToTextRecorder facade (100+ kwargs, lazy init, sole composition root)
  synthesizer/        # TTS sibling — Kokoro-ONNX, same hexagonal split (port + adapter + facade)
  stt_server/         # WebSocket STT server (control + data channels)
```

### Import Contract

| Layer | May Import From |
|---|---|
| domain/ports | building_blocks, stdlib only |
| domain (events, config, state_machine, model_registry, …) | building_blocks, domain/ports |
| application | domain, building_blocks |
| infrastructure | domain, building_blocks (NEVER application) |
| bootstrap | everything (helpers shared between facade and live model swaps) |
| facade (`__init__.py`) | everything (public API, hides architecture) |

**Invalid imports that break the architecture:**
- Domain importing infrastructure (`from infrastructure.pyaudio_source import ...`)
- Infrastructure importing application (`from application.pipeline import ...`)
- Port importing another port (`from ports.vad import ...` inside `ports/audio_source.py`)

---

## 2. Ports (Abstract Interfaces)

All ports are ABCs in `domain/ports/`. Prefix: `I`. Multiple adapters per port where it makes sense.

| Port | Methods | Adapters |
|---|---|---|
| `IAudioSource` | `setup()`, `read_chunk() → AudioChunk`, `cleanup()`, `is_active()`, `switch_device(idx)`, `pause()`, `resume()`, `is_capturing()`, `sample_rate`, `buffer_size` | `PyAudioSource`, `FileAudioSource` |
| `ITranscriber` | `transcribe(audio, lang) → TranscriptionResult`, `is_ready()`, `shutdown()` | `OnnxAsrTranscriber` (local), `RemoteTranscriber` (cloud — OpenAI / ElevenLabs RPC) |
| `IVoiceActivityDetector` | `detect(chunk) → VADResult`, `reset()` | `WebRtcVad`, `SileroVad`, `CompositeVad` |
| `IWakeWordDetector` | `detect(chunk) → WakeWordResult`, `cleanup()` | `PorcupineDetector`, `OwwDetector`, `CompositeWakeWord` |
| `IDiarizer` | `diarize(audio) → tuple[SpeakerSegment, …]`, `reset()`, `shutdown()` | `OnnxAsrDiarizer` |
| `ISentenceClassifier` | `classify(text) → float`, `is_available()`, `shutdown()` | `DistilbertClassifier` (gated on the `[sentence-classifier]` extra) |

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

Frozen dataclasses inheriting `RecorderEvent(timestamp)`. Published via `EventBus`, never called directly. ~30 event classes total — grouped below.

```
Recording lifecycle: RecordingStarted, RecordingStopped, NoAudioDetected,
                     AudioChunkRecorded(chunk)
Transcription:       TranscriptionStarted(audio), TranscriptionCompleted(text, wav_path),
                     RealtimeTranscriptionUpdate(text),
                     RealtimeTranscriptionStabilized(text)
VAD / turn:          VADStarted, VADStopped, VADDetectStarted, VADDetectStopped,
                     TurnDetectionStarted, TurnDetectionStopped
Wake word:           WakeWordDetectionStarted, WakeWordDetected(word_index, word),
                     WakeWordTimeout
Model lifecycle:     ModelDownloadStarted, ModelDownloadProgress, ModelDownloadCompleted,
                     ModelSwapStarted, ModelSwapCompleted, ModelSwapFailed
Diarization:         DiarizationToggleStarted, DiarizationToggleCompleted,
                     SpeakerSegmentsDetected
Audio devices:       DeviceSwitchStarted, DeviceSwitchCompleted,
                     VadSensitivityChanged
```

`TranscriptionCompleted.wav_path` is populated only when `HistoryConfig.save_wav` is true; the Electron history relay subscribes and inserts the matching SQLite row.

**Rule:** Legacy callbacks (e.g., `on_recording_start`) are bridged to events in `bootstrap.py` via `wire_callback()` / `wire_callback_with_text()` / `wire_callback_with_level()` / `wire_callback_with_audio()` / `wire_callback_with_device_switch()` / `wire_callback_with_model_swap()` / `wire_callback_with_diarization_toggle()` / `wire_callback_with_vad_sensitivity()` / `wire_callback_with_speaker_segments()`. Application code consumes events, not raw callbacks.

**Adding a new `on_*` recorder callback requires 4 coordinated edits** — facade signature + dict, `CallbackMap` union in `building_blocks/types.py`, `bootstrap.py` wiring, and a new wire helper if the payload shape is novel. Missing the facade leaves the server booting without a recorder. See `memory/project_facade_callback_kwarg_registry.md`.

---

## 5. State Machine

Five states, explicit edge table in `domain/state_machine.py`:

```
INACTIVE  → LISTENING | WAKEWORD
LISTENING → RECORDING | WAKEWORD | INACTIVE
WAKEWORD  → LISTENING | INACTIVE
RECORDING → TRANSCRIBING | INACTIVE
TRANSCRIBING → INACTIVE | LISTENING   (LISTENING re-entry powers toggle-continuous mode)
```

- `RecorderStateMachine.transition(new_state)` — raises `InvalidStateTransition` if edge doesn't exist
- `abort()` — force to INACTIVE from any state
- `is_recording` / `is_inactive` convenience properties
- Only `RecordingPipeline` drives transitions (single-threaded access)

---

## 6. Application Layer

### RecorderService (Orchestrator)
- Owns: `RecordingPipeline`, audio reader thread, realtime worker thread, optional `DiarizationStream`
- `text(callback) → str` — blocking: listen → wait → transcribe → return
- `start()` / `stop()` — manual recording control
- `set_microphone(bool)` — toggle mic; silence frames injected when off (PTT pattern)
- `wait_audio() → bool` — blocks until pipeline produces audio; `False` on timeout
- Constructor injection: all ports + config + event_bus + clock

### RecordingPipeline (Worker Thread)
- Processes audio queue: read chunk → VAD → state transition → buffer
- `request_listen()` → enter LISTENING, enable VAD onset detection (and 3-chunk speech-onset debounce that gates the pill/wakes Whisper for non-PTT modes)
- `request_start()` → force RECORDING (bypasses VAD — used by PTT)
- `request_stop()` → RECORDING → TRANSCRIBING, enqueue for transcription
- `post_speech_silence_duration` — settable at runtime (PTT sets 9999 during hold, 0.15 on release)

### RealtimeStabilizer
Ported from RealtimeSTT — `commonprefix` monotonic safetext accumulator with tail-match merge. Powers the live preview, since Whisper itself isn't streaming. See `memory/project_realtime_stabilizer_port.md`.

### DiarizationStream
Real-time diarized subtitles built on a decoupled continuous-timeline design (utterr principle via the vendored `onnx_asr` fork). Runtime-toggleable, idempotent for in-flight sessions.

### VadCalibrator / WavWriter / SwapBenchmark
Sensitivity calibration, optional WAV persistence (history hook), and model-swap latency benchmarking respectively.

---

## 7. Facade (`AudioToTextRecorder`)

The public API. Backward-compatible with monolith's 100+ kwargs.

- **Lazy init:** `_ensure_service()` builds everything on first use (double-checked lock)
- **Callback wiring:** Constructor kwargs like `on_recording_start=fn` are stored in `CallbackMap`, bridged to events during init
- **Delegates everything** to `RecorderService` methods
- `_create_with_service()` — test factory for injecting a pre-built service

---

## 8. DI & Bootstrap

The facade (`recorder/__init__.py`, `AudioToTextRecorder._ensure_service`) is the **sole composition root**. `bootstrap.py` is a helpers module — it exports reusable builders (`build_transcriber`, `build_realtime_transcriber`, `build_diarizer`, `DownloadCallbacks`), the callback bridge (`wire_callback*` family, `wire_all_callbacks`, `CALLBACK_EVENT_MAP`), the wake-word backend registry (`WAKE_WORD_BACKENDS`), and the language-compatibility guard (`_validate_language_against_model`).

**Note on Kink:** the `kink` package is installed and present in `pyproject.toml`, but the actual composition is done directly by the facade via the helper builders rather than through a Kink container. Treat bootstrap as "builder helpers shared between facade init and live model swaps", not as a DI framework.

The facade composes:

1. Create EventBus + Clock
2. Wire callbacks → events via `wire_all_callbacks`
3. Build adapters (audio source, VAD, transcriber, optional realtime transcriber, optional diarizer, wake word, optional sentence classifier) using the bootstrap helpers
4. Construct `RecorderService` with the wired dependencies

**Rule:** Only the facade instantiates infrastructure. Application/domain never `import` concrete adapters; helpers in `bootstrap.py` are the canonical place for adapter construction logic shared between live composition and model swaps.

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
| `tests/fakes/` | `FakeAudioSource`, `FakeTranscriber`, `FakeVAD`, `FakeWakeWord`, `FakeDiarizer`, `FakeSentenceClassifier` | Domain ports only |

- **63 test files** across unit + integration (use `find tests -name 'test_*.py' | wc -l` to recount)
- **100 % coverage** required (`fail_under = 100`); coverage `omit` list (see `pyproject.toml`):
  - `tests/*`
  - `src/building_blocks/terminal.py`
  - `src/recorder/infrastructure/*` (integration-level)
  - `src/recorder/bootstrap.py`
  - `src/recorder/client.py`
  - `src/stt_server/*`
  - `src/synthesizer/infrastructure/*`, `src/synthesizer/bootstrap.py`, `src/synthesizer/__init__.py`
- **Property tests via `hypothesis`** (declared in `[dependency-groups].dev`)
- **Clock injection:** Tests use `Clock.fixed_clock()` for deterministic time
- **No real hardware:** `FakeAudioSource` feeds synthetic PCM; `FakeTranscriber` returns canned text

> **Pre-existing-gap caveat:** the 100 % gate can fail at ~99.5 % on `model_registry.py` (catalog/overlay branches) in some envs even when your files are 100 %. See `memory/project_server_coverage_preexisting_gap.md` — don't chase it if your changes are clean.

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
