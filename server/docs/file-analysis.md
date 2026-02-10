# Top 10 Largest Source Files - Refactoring Analysis

**Generated**: 2026-02-10
**Scope**: `server/` (Python STT engine)
**Command Run**: `tokei server/ -f -s code`
**Total**: 80 Python files, 9,290 LOC (source only, excluding tests)

---

## Python

| Rank | File Path | Responsibilities | LOC | DRY | SoC | Mod | Avg | Effort | Priority Score | Key Refactoring Needs |
| ---- | --------- | ---------------- | --- | --- | --- | --- | --- | ------ | -------------- | --------------------- |
| 1 | `src/recorder/infrastructure/whisper_transcriber.py` | Whisper adapter with HF download progress interception | 211 | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | 3.3 | 🟢 Low | 6.7 | Extract `_intercept_hf_progress` to dedicated download module |
| 2 | `src/recorder/bootstrap.py` | DI composition root wiring ports to adapters | 225 | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 4.0 | 🟢 Low | 6.0 | Unify `_build_transcriber` and `_build_realtime_transcriber` |
| 3 | `src/recorder/domain/model_registry.py` | Registry of all known ASR models and metadata | 232 | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 4.0 | 🟢 Low | 6.0 | Extract common `ModelInfo` builder to reduce repetitive factory functions |
| 4 | `src/recorder/application/recorder_service.py` | Core orchestrator: lifecycle, threading, audio reading, realtime worker | 339 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 4.0 | 🟢 Low | 6.0 | Minor: extract `_realtime_worker` timing logic |
| 5 | `src/stt_server/loopback.py` | WASAPI loopback audio capture for system audio transcription | 165 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 4.3 | 🟢 Low | 5.7 | Minor: deduplicate device info dict construction in `list_devices` |
| 6 | `src/recorder/application/pipeline.py` | Worker thread: audio queue processing, VAD, state transitions, buffering | 186 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 4.7 | 🟢 Low | 5.3 | Well-structured; no significant refactoring needed |
| 7 | `src/recorder/domain/config.py` | Pydantic config hierarchy (Audio, VAD, Transcription, etc.) | 121 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 4.7 | 🟢 Low | 5.3 | Minor: `from_kwargs` routing could use a mapping dict |
| 8 | `src/recorder/client.py` | WebSocket client mirroring AudioToTextRecorder API for remote server | 735 | ⭐⭐ | ⭐⭐⭐ | ⭐⭐ | 2.3 | 🟡 Medium | 5.1 | Extract arg-building to config serializer; collapse callback dispatch |
| 9 | `src/recorder/__init__.py` | Backward-compatible facade (100+ kwargs), delegates to RecorderService | 593 | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | 2.7 | 🟡 Medium | 4.9 | Delegate `_ensure_service` bootstrap logic to `bootstrap.py` |
| 10 | `src/stt_server/server.py` | WebSocket STT server: CLI, control/data handlers, shutdown, file transcription | 1718 | ⭐ | ⭐ | ⭐ | 1.0 | ⚫ Critical | 2.3 | Split into modules: CLI parser, event relay, control handler, data handler |

---

## Detailed Analysis

### 1. `src/stt_server/server.py` (1718 LOC) - Server - WebSocket/CLI

**Responsibilities**: WebSocket STT server handling CLI argument parsing, dual-channel WebSocket control/data, audio resampling, file transcription, loopback management, settings persistence, and graceful shutdown orchestration.

**Purpose**: The entry point for the STT server process. Receives audio from Electron frontend via WebSocket, feeds it to the recorder, and broadcasts transcription events back to connected clients.

**Why It Exists**: This is the network boundary between the Electron frontend and the Python STT engine. It must translate WebSocket messages into recorder API calls and broadcast domain events as JSON.

**Violation Scores**:

- DRY Violations: ⭐ - Seven nearly identical `on_*` callback functions (lines 396-456) each follow the exact same pattern: `json.dumps({"type": ...})` + `asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)`. The `control_handler` has duplicated error response patterns (`json.dumps({"status": "error", "message": ...})`) appearing 8+ times. The `set_parameter` branch has 4 similar blocks each doing timestamp+print+send pattern.
- SoC Violations: ⭐ - Mixes 6+ distinct concerns: (1) CLI argument parsing (~530 lines), (2) WebSocket protocol handling, (3) audio resampling, (4) file transcription, (5) settings persistence, (6) shutdown management with watchdog threads, (7) loopback device management, (8) sentence detection/silence timing. All in a single 2070-line file.
- Modularity Violations: ⭐ - Heavy reliance on ~15 module-level mutable globals (`recorder`, `global_args`, `sentence_classifier`, `prev_text`, `stop_recorder`, etc.). `control_handler` is a 340-line nested if/elif chain. `parse_arguments` is 560 lines. Functions are tightly coupled through shared global state rather than explicit dependencies.

**Refactoring Effort**: ⚫ Critical (2+ weeks) - At 1718 LOC with global state threaded throughout, extracting modules requires careful dependency tracking. The Electron frontend depends on the exact WebSocket protocol, so changes must maintain backward compatibility. Signal handling and shutdown are intertwined with all other concerns.

**Analysis**:
This file is the single largest technical debt item in the server codebase. It's a direct port of the original monolith's server script and hasn't been decomposed to match the hexagonal architecture applied to the recorder engine. Every concern shares mutable global state, making it impossible to test any piece in isolation.

The CLI argument parser alone is ~530 lines and could be its own module returning a typed config object. The seven identical `on_*` callbacks could be collapsed into a single generic event relay function. The `control_handler`'s 340-line if/elif chain is a textbook candidate for a command dispatch pattern.

The most impactful refactoring would be extracting the control handler into a command router class, the data handler into a separate module, and the CLI parser into its own file. The event relay callbacks should be generified into a single function that maps event types to JSON message types.

**Critical Refactoring Blocks**:

1. **Lines 396-456** (~60 LOC)
   - Issue: DRY — 7 identical callback functions (`on_recording_start`, `on_recording_stop`, `on_vad_detect_start`, etc.) each doing the same `json.dumps` + `asyncio.run_coroutine_threadsafe` pattern
   - Suggestion: Replace with a single `_relay_event(event_type: str, loop: asyncio.AbstractEventLoop, **payload) -> None` factory function

2. **Lines 552-1113** (~560 LOC)
   - Issue: SoC/Modularity — `parse_arguments()` is an enormous function that defines 40+ CLI arguments with verbose help text, then applies persisted settings and sets 6 globals
   - Suggestion: Extract to `src/stt_server/cli.py` returning a frozen dataclass. Move default values to a config module.

3. **Lines 1358-1702** (~344 LOC)
   - Issue: SoC/Modularity — `control_handler()` is a monolithic async function with a deeply nested if/elif chain handling 10+ commands (`set_parameter`, `get_parameter`, `call_method`, `transcribe_file`, `list_models`, `list_loopback_devices`, `start_loopback`, `stop_loopback`, `cancel_download`)
   - Suggestion: Extract to a `CommandRouter` class with handler methods, one per command. Each handler receives the parsed JSON and returns a response dict.

4. **Lines 62-86** (~25 LOC) + scattered throughout
   - Issue: Modularity — 15+ module-level mutable globals (`recorder`, `global_args`, `sentence_classifier`, `prev_text`, `stop_recorder`, `_shutdown_requested_at`, `_download_state`, `_cancel_download_requested`, etc.)
   - Suggestion: Encapsulate in a `ServerState` dataclass or class, passed explicitly to handlers

5. **Lines 1250-1356** (~106 LOC)
   - Issue: SoC — `_handle_transcribe_file()` handles file validation, model access (reaching through `recorder._service._transcriber._model` — 3 levels of encapsulation violation), and result formatting
   - Suggestion: Extract to `src/stt_server/file_transcription.py`, expose a proper file-transcription method on RecorderService or the facade

---

### 2. `src/recorder/client.py` (735 LOC) - Client - WebSocket

**Responsibilities**: WebSocket client that mirrors the `AudioToTextRecorder` API but delegates all transcription to a remote STT server instead of running models locally.

**Purpose**: Allows applications to use the same API as the local recorder but connects to a remote server. Used for thin-client setups where the heavy GPU work runs on a separate machine.

**Why It Exists**: Enables the STT capability to be used as a client-server architecture, with the same programming interface as the local recorder facade.

**Violation Scores**:

- DRY Violations: ⭐⭐ - Constructor (lines 103-179) has 76 parameters that mirror the facade's constructor verbatim, then lines 183-263 assign each to `self.*` one by one. `start_server()` (lines 438-532) has ~60 lines of repetitive `if self.X: args += ["--flag", str(self.X)]` patterns. `on_data_message()` (lines 688-759) has a long elif chain dispatching to callbacks that follows a repeating `if self.on_X: self.on_X()` pattern.
- SoC Violations: ⭐⭐⭐ - Two main concerns mixed: WebSocket communication protocol and audio recording/streaming. The subprocess management (`start_server()`) adds a third concern. Acceptable for a client class but the subprocess launch could be extracted.
- Modularity Violations: ⭐⭐ - Constructor is 175 lines. `start_server()` is 94 lines of arg building. `on_data_message()` is 72 lines. High coupling to the server's exact WebSocket protocol. The `_BColors` class is duplicated from `server.py`.

**Refactoring Effort**: 🟡 Medium (3-4 days) - 735 LOC, standalone module with no internal dependents beyond examples. Protocol coupling with server means protocol changes require coordinated updates, but the client itself can be refactored freely.

**Analysis**:
The client is a faithful mirror of the facade API, which inherently means duplicating the 100+ parameter constructor. The most egregious DRY violation is `start_server()` which manually maps each parameter to a CLI flag through 60 lines of repetitive conditionals. This should serialize from a config object.

The `on_data_message` method is a 72-line elif chain dispatching WebSocket messages to callbacks. This could use a dispatch table mapping message types to handler methods, similar to the server's control handler issue.

The `_BColors` class at line 58 is an exact duplicate of `bcolors` in `server.py` — both files define the same ANSI color codes independently. This should be a shared utility.

**Critical Refactoring Blocks**:

1. **Lines 438-532** (~94 LOC)
   - Issue: DRY — `start_server()` has ~60 repetitive `if self.X: args += ["--flag", str(self.X)]` lines
   - Suggestion: Build args from a config dict or use a serialization helper that maps config fields to CLI flags automatically

2. **Lines 103-263** (~160 LOC)
   - Issue: DRY — 76-parameter constructor mirrors facade, then mechanically assigns each to self
   - Suggestion: Accept a `RecorderConfig` (or a client-specific config dataclass) instead of flat kwargs

3. **Lines 688-759** (~72 LOC)
   - Issue: DRY/Modularity — `on_data_message` elif chain with repeating `if self.on_X: self.on_X()` pattern
   - Suggestion: Use a dispatch table: `{"recording_start": self.on_recording_start, ...}`

4. **Lines 58-69** (~12 LOC)
   - Issue: DRY — `_BColors` class duplicated from `server.py`'s `bcolors`
   - Suggestion: Extract to shared utility in `building_blocks/` or `stt_server/colors.py`

---

### 3. `src/recorder/__init__.py` (593 LOC) - Facade - Public API

**Responsibilities**: Backward-compatible public facade accepting 100+ constructor kwargs. Delegates to `RecorderService` via lazy initialization. Handles model hot-swapping in a background thread.

**Purpose**: The single entry point for the STT engine. Preserves the monolith's API so all 16 example scripts and the WebSocket server work without modification.

**Why It Exists**: Architectural boundary between the hexagonal internals and external consumers. Accepts flat kwargs, builds config, wires dependencies, and delegates method calls.

**Violation Scores**:

- DRY Violations: ⭐⭐ - `_ensure_service()` (lines 262-447, ~185 LOC) duplicates transcriber-building logic that already exists in `bootstrap.py`'s `_build_transcriber()`. The `model` property setter's `_swap()` closure (lines 579-648, ~70 LOC) duplicates this again. Download progress callback wiring is tripled across facade, bootstrap, and swap.
- SoC Violations: ⭐⭐⭐ - The facade role is correct (delegation layer), but `_ensure_service()` does full bootstrap work (building VAD, audio source, transcriber) instead of calling `bootstrap_di()`. This conflates facade with composition root.
- Modularity Violations: ⭐⭐⭐ - `_ensure_service()` at 185 lines is oversized. `model` setter contains a 70-line nested function. Otherwise, delegation methods are clean one-liners.

**Refactoring Effort**: 🟡 Medium (3-4 days) - 593 LOC. Refactoring `_ensure_service` to call `bootstrap_di` would touch both files but reduce ~150 LOC of duplication. The model swap logic would need careful testing due to threading.

**Analysis**:
The facade is well-designed in principle — every public method is a thin delegation to `RecorderService`. The problem is that `_ensure_service()` grew into a second composition root, duplicating the entire bootstrap process. This happened because the facade needs download progress callbacks and cancel checks that `bootstrap_di()` doesn't currently accept.

The fix is straightforward: extend `bootstrap_di()` to accept optional download/cancel callbacks, then replace `_ensure_service()`'s 185 lines of adapter construction with a single `bootstrap_di()` call. The model setter's `_swap()` function should similarly delegate to a shared transcriber-builder.

The `_BoolFlag` helper class (lines 39-64) is a nice backward-compat shim and is well-contained. The property accessors for `post_speech_silence_duration`, `model`, `language`, etc. are clean delegation.

**Critical Refactoring Blocks**:

1. **Lines 262-447** (~185 LOC)
   - Issue: DRY/SoC — `_ensure_service()` duplicates all of `bootstrap.py`'s adapter construction logic inline
   - Suggestion: Extend `bootstrap_di()` to accept download callbacks, then call it here. Reduces to ~20 lines.

2. **Lines 579-648** (~70 LOC)
   - Issue: DRY — `model` setter's `_swap()` closure duplicates transcriber construction from both `_ensure_service` and `bootstrap.py`
   - Suggestion: Extract a `build_transcriber(model, config, on_progress, cancel_check)` factory in `bootstrap.py` and call it from `_swap()`

3. **Lines 341-348** + **604-614** (~20 LOC)
   - Issue: DRY — Download progress callback wiring (`_on_download_progress` closure) appears twice with identical logic
   - Suggestion: Extract to a shared factory function in `bootstrap.py`

---

### 4. `src/recorder/application/recorder_service.py` (339 LOC) - Application - Orchestrator

**Responsibilities**: Core orchestrator owning the recording lifecycle — manages pipeline, audio reader thread, realtime transcription worker, microphone toggle, and transcriber hot-swap.

**Purpose**: The application-layer service that coordinates all domain ports (audio source, VAD, transcriber) and the recording pipeline. Single point of control for start/stop/text operations.

**Why It Exists**: Hexagonal architecture requires an application service to orchestrate domain objects without coupling to infrastructure. This is that service.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐⭐ - Minimal duplication. The only notable pattern is `self._clock.get_current_time()` called frequently, but that's idiomatic.
- SoC Violations: ⭐⭐⭐⭐ - Clean primary concern (lifecycle orchestration) with minor cross-cutting: `_preprocess_output` (text formatting) could live elsewhere but is only 6 lines. `_realtime_worker` handles its own timing/sleep logic which is appropriate.
- Modularity Violations: ⭐⭐⭐⭐ - Well-modularized. All methods are under 50 lines. Clear port-based dependencies via constructor injection. `swap_transcriber` is thread-safe with a lock.

**Refactoring Effort**: 🟢 Low (< 1 day) - 339 LOC, clean architecture, minimal coupling. Any changes would be minor refinements.

**Analysis**:
This is one of the best-structured files in the codebase. Constructor injection of all ports, clean delegation to the pipeline, thread management in dedicated methods. The `text()` method clearly shows the listen-wait-transcribe-publish flow.

The `_realtime_worker` (lines 308-361) uses busy-wait patterns with `time.sleep(0.001)` and `time.sleep(0.01)` which is functional but could use `threading.Event` waits for more efficient CPU usage. This is a minor improvement.

**Critical Refactoring Blocks**:

1. **Lines 308-361** (~53 LOC)
   - Issue: Modularity (minor) — `_realtime_worker` uses tight sleep loops with `time.sleep(0.001)` for timing
   - Suggestion: Use `threading.Event.wait(timeout=interval)` for more efficient CPU usage

2. **Lines 387-393** (~6 LOC)
   - Issue: SoC (minor) — `_preprocess_output` mixes text formatting into the service
   - Suggestion: Could be a static utility, but small enough to leave in place

---

### 5. `src/recorder/domain/model_registry.py` (232 LOC) - Domain - Data Registry

**Responsibilities**: Static registry of all supported ASR models (Whisper, NeMo, GigaAM, Kaldi, T-One) with metadata (backend, languages, sizes).

**Purpose**: Single source of truth for model metadata used by the frontend model selector, backend routing, and ONNX model name resolution.

**Why It Exists**: The server supports multiple ASR backends (faster-whisper, onnx-asr). This registry maps model IDs to their backend, capabilities, and display information.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐ - Five factory functions (`_whisper_models`, `_nemo_models`, `_gigaam_models`, `_kaldi_models`, `_tone_models`) follow similar patterns of building `ModelInfo` from tuples. The Whisper function iterates twice (multilingual + English-only). `to_dicts()` manually maps all 10 fields.
- SoC Violations: ⭐⭐⭐⭐⭐ - Pure data registry with no side effects. Single, well-defined concern.
- Modularity Violations: ⭐⭐⭐⭐ - Good interface. `to_dicts()` could use `dataclasses.asdict()` with a custom serializer for enums, but the manual approach is explicit and readable.

**Refactoring Effort**: 🟢 Low (< 1 day) - Self-contained data module with no external dependencies. Changes are purely structural.

**Analysis**:
This file is a clean data registry. The repetitive factory functions are a reasonable trade-off for readability — each model family has different tuple shapes and construction logic, so a fully generic builder would sacrifice clarity.

The main improvement opportunity is `to_dicts()` (lines 239-256) which manually maps every field of `ModelInfo` to a dict. Since `ModelInfo` is a frozen dataclass, `dataclasses.asdict()` would work, except the `backend` enum needs `.value` conversion. A small custom serializer would eliminate this 17-line method.

**Critical Refactoring Blocks**:

1. **Lines 239-256** (~17 LOC)
   - Issue: DRY — `to_dicts()` manually maps all 10 `ModelInfo` fields to a dict
   - Suggestion: Use `dataclasses.asdict()` with a post-processing step for enum serialization

2. **Lines 26-72** + **75-129** (~100 LOC)
   - Issue: DRY (moderate) — `_whisper_models()` and `_nemo_models()` share similar tuple→ModelInfo construction patterns
   - Suggestion: A generic `_build_models(entries, backend, family, **defaults)` helper could reduce boilerplate, but would sacrifice readability — consider leaving as-is

---

### 6. `src/recorder/bootstrap.py` (225 LOC) - Bootstrap - DI Composition Root

**Responsibilities**: Sole composition root for the hexagonal architecture. Wires all ports to concrete adapters, registers in Kink DI container, builds `RecorderService`.

**Purpose**: The only place in the codebase that imports both domain ports and infrastructure adapters. Assembles the full dependency graph.

**Why It Exists**: Hexagonal architecture requires a single composition root where dependencies are resolved. This file fulfills that role.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐ - `_build_transcriber()` (lines 97-132) and `_build_realtime_transcriber()` (lines 135-162) share ~70% of their logic: backend resolution via `ModelCatalog`, ONNX vs Whisper branching, similar constructor kwargs. The callback wiring loop in `bootstrap_di()` is also duplicated in `_ensure_service()` in the facade.
- SoC Violations: ⭐⭐⭐⭐⭐ - Perfect separation. This is exactly what a composition root should do.
- Modularity Violations: ⭐⭐⭐⭐ - Clean functions with clear responsibilities. Good use of the CALLBACK_EVENT_MAP constant for declarative wiring.

**Refactoring Effort**: 🟢 Low (< 1 day) - 225 LOC. Unifying the two transcriber builders is straightforward.

**Analysis**:
This file correctly implements the composition root pattern. The `CALLBACK_EVENT_MAP` dict (lines 42-60) is a clean declarative mapping. The `wire_callback*` family of functions handles the type-specific event→callback bridging cleanly.

The main DRY issue is the two transcriber builder functions. They could be unified into a single `_build_transcriber(model_name, config, *, is_realtime=False)` that handles both cases. The ONNX branch is identical; only the Whisper branch differs (WhisperTranscriber vs RealtimeTranscriber, different config fields for beam_size/batch_size).

**Critical Refactoring Blocks**:

1. **Lines 97-162** (~65 LOC)
   - Issue: DRY — `_build_transcriber` and `_build_realtime_transcriber` share backend resolution, catalog lookup, and ONNX construction
   - Suggestion: Unify into `_build_transcriber(model_name, config, is_realtime=False)` with a branch for Whisper vs Realtime class selection

2. **Lines 165-189** (~25 LOC)
   - Issue: DRY — Callback wiring loop in `bootstrap_di()` is duplicated in `__init__.py`'s `_ensure_service()`
   - Suggestion: Export the wiring as a public function (already partially done via `wire_callback` exports) and have the facade call `bootstrap_di()` directly

---

### 7. `src/recorder/infrastructure/whisper_transcriber.py` (211 LOC) - Infrastructure - Transcription Adapter

**Responsibilities**: Concrete `ITranscriber` implementation using faster-whisper. Includes a context manager for intercepting HuggingFace download progress via tqdm monkey-patching.

**Purpose**: Loads Whisper models, runs inference, and reports download progress. The download interception is necessary because faster-whisper bypasses HuggingFace's tqdm with its own `disabled_tqdm`.

**Why It Exists**: The hexagonal architecture requires a concrete adapter for each domain port. This adapts the faster-whisper library to the `ITranscriber` interface.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐⭐ - Minimal duplication within the file. The `_emit` helper is called consistently.
- SoC Violations: ⭐⭐⭐ - Two concerns: (1) download progress interception via tqdm monkey-patching (~130 LOC), and (2) actual Whisper transcription (~80 LOC). The download interception is a cross-cutting infrastructure concern that could be its own module.
- Modularity Violations: ⭐⭐⭐ - `_intercept_hf_progress` is a 130-line context manager with complex module-patching logic. It's self-contained but dominates the file. Could be reused by other transcribers that use HuggingFace downloads.

**Refactoring Effort**: 🟢 Low (1-2 days) - 211 LOC. Extracting the progress interceptor to its own module is mechanical. The transcriber class is clean and independent.

**Analysis**:
The `WhisperTranscriber` class itself (lines 166-270) is a clean port implementation with `@override` on all three methods. The `transcribe` method handles normalization, kwargs building, and error recovery well.

The `_intercept_hf_progress` context manager (lines 32-163) is complex but necessarily so — it solves a genuine technical challenge (see MEMORY.md notes on tqdm interception). However, it accounts for 62% of the file and is conceptually independent of Whisper. Extracting it to `infrastructure/download_progress.py` would improve both files' cohesion and allow `OnnxAsrTranscriber` to reuse it.

**Critical Refactoring Blocks**:

1. **Lines 32-163** (~130 LOC)
   - Issue: SoC — Download progress interception is a cross-cutting concern, not specific to Whisper
   - Suggestion: Extract to `infrastructure/download_progress.py` as a reusable context manager. `WhisperTranscriber` and `OnnxAsrTranscriber` can both import it.

2. **Lines 86-125** (~40 LOC)
   - Issue: Modularity — `_TrackedTqdm.update()` has complex aggregate tracking logic with multiple concerns (cancellation check, byte tracking, bar aggregation, threshold filtering, monotonic progress)
   - Suggestion: Could extract the aggregation logic to a separate `ProgressAggregator` class, but the complexity is inherent to the tqdm interception problem — may not be worth splitting further

---

### 8. `src/recorder/application/pipeline.py` (186 LOC) - Application - Audio Processing Worker

**Responsibilities**: Worker thread processing the audio queue: reads chunks, runs VAD detection, manages state transitions, buffers audio, computes audio levels.

**Purpose**: The core audio processing loop. Decides when speech starts/stops based on VAD results and silence duration, drives the state machine.

**Why It Exists**: Separates the real-time audio processing concern from the higher-level orchestration in `RecorderService`. Runs on its own thread for responsiveness.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐⭐ - Minor: VAD `detect(chunk)` is called in both `_process_recording` and `_process_not_recording`, but the usage is different (onset vs offset detection) so this is not true duplication.
- SoC Violations: ⭐⭐⭐⭐⭐ - Single, well-defined concern: audio chunk processing and state transitions.
- Modularity Violations: ⭐⭐⭐⭐⭐ - Excellent. All methods under 40 lines. Clean separation between recording/not-recording paths. Clear constructor injection. Extends `Worker` ABC properly.

**Refactoring Effort**: 🟢 Low (< 1 day) - 186 LOC, clean architecture, isolated concern. No significant refactoring needed.

**Analysis**:
This is arguably the best-structured file in the top 10. The `_run()` method (lines 148-165) is a clean event loop. The split between `_process_recording` and `_process_not_recording` makes the state-dependent logic clear. Event publishing is consistent and uses proper domain events.

No significant refactoring blocks identified. This file exemplifies the target quality for the rest of the codebase.

---

### 9. `src/stt_server/loopback.py` (165 LOC) - Infrastructure - WASAPI Loopback

**Responsibilities**: Manages WASAPI loopback audio capture for transcribing system/desktop audio. Handles device enumeration, stream lifecycle, AGC normalization, and recorder integration.

**Purpose**: Enables transcribing audio from any application (e.g., browser, media player) by capturing the system's speaker output via WASAPI loopback.

**Why It Exists**: A feature requirement — users need to transcribe not just microphone input but also desktop audio.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐⭐ - Minor: `list_devices()` builds device info dicts in two places (lines 59-70 for loopback match, lines 72-80 for fallback) with similar but not identical structures.
- SoC Violations: ⭐⭐⭐⭐⭐ - Single concern: loopback capture lifecycle management. Clean separation of device enumeration, start/stop, and capture loop.
- Modularity Violations: ⭐⭐⭐⭐ - Well-encapsulated with a lock for thread safety. Clean start/stop lifecycle. AGC constants are module-level and well-documented.

**Refactoring Effort**: 🟢 Low (< 1 day) - 165 LOC, self-contained, no internal dependents.

**Analysis**:
Clean, focused module. The lock-based thread safety in `start()`/`stop()` with inner `_*_locked()` methods is a good pattern. AGC normalization in the capture loop is straightforward and well-parameterized.

The only notable improvement would be deduplicating the device info dict construction in `list_devices()`, where the loopback-found and loopback-not-found paths build similar dicts. A small helper function could unify this.

**Critical Refactoring Blocks**:

1. **Lines 52-81** (~30 LOC)
   - Issue: DRY (minor) — Device info dict construction appears twice with similar structure
   - Suggestion: Extract a `_build_device_info(dev, loopback=None, is_default=False)` helper

---

### 10. `src/recorder/domain/config.py` (121 LOC) - Domain - Configuration

**Responsibilities**: Pydantic-based configuration hierarchy defining all recorder settings across 7 sub-configs: Audio, VAD, Transcription, Realtime, WakeWord, Endpoint, UI.

**Purpose**: Type-safe, validated configuration objects replacing the monolith's 100+ loose instance attributes.

**Why It Exists**: The hexagonal architecture needs a structured, validated config object rather than raw kwargs spread across constructors.

**Violation Scores**:

- DRY Violations: ⭐⭐⭐⭐ - Minor: `from_kwargs()` (lines 106-147) has 7 repetitive blocks building field sets and routing kwargs. The pattern is mechanical but explicit.
- SoC Violations: ⭐⭐⭐⭐⭐ - Pure configuration concern. Each sub-config has a single domain area.
- Modularity Violations: ⭐⭐⭐⭐⭐ - Clean composition of sub-configs. `StrictMutableModel` base provides consistent behavior. `from_kwargs()` is the only complex method and it's a factory.

**Refactoring Effort**: 🟢 Low (< 1 day) - 121 LOC, self-contained data classes.

**Analysis**:
Well-structured configuration module. The Pydantic models provide validation (e.g., `silero_sensitivity` has `ge=0.0, le=1.0`), type checking, and clear field documentation through defaults.

The `from_kwargs()` factory (lines 106-147) is the only area that could be improved. The 7-block routing pattern could use a mapping of field-sets to config classes, iterating rather than repeating. However, the explicit approach has the advantage of being easy to debug and modify.

**Critical Refactoring Blocks**:

1. **Lines 106-147** (~42 LOC)
   - Issue: DRY (minor) — 7 repetitive field-set routing blocks in `from_kwargs()`
   - Suggestion: Build a `{ConfigClass: set(fields)}` mapping and iterate, reducing to ~15 lines. Trade-off: slightly less explicit.

---

## Summary

### Key Findings

| Severity | Files | Action |
|----------|-------|--------|
| ⚫ Critical | `server.py` | Needs architectural decomposition into 4-5 modules. Highest debt but highest effort. |
| 🟡 Medium | `client.py`, `__init__.py` | Moderate DRY violations from duplicated bootstrap/config logic. Fix by centralizing builders. |
| 🟢 Low | All others (7 files) | Minor improvements only. Architecture is clean. |

### Top 3 Actions by Impact

1. **Extract `server.py` CLI parser** (~530 LOC reduction, immediate readability win, 🟡 effort)
2. **Unify facade and bootstrap transcriber building** (eliminate ~200 LOC of duplication across `__init__.py` and `bootstrap.py`)
3. **Genericize server event relay callbacks** (collapse 7 identical functions into 1, ~50 LOC reduction)

### Architecture Health

The hexagonal core (`domain/`, `application/`, `infrastructure/`) is well-structured with clean separation. The technical debt is concentrated at the boundaries: `server.py` (network layer) and `__init__.py` / `client.py` (public API facades). The domain layer (`config.py`, `pipeline.py`) and infrastructure adapters (`whisper_transcriber.py`, `loopback.py`) are in good shape.
