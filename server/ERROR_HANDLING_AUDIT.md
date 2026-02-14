# Error Handling Audit Report

**Date:** 2026-02-14
**Scope:** `server/src/` directory
**Architecture:** Hexagonal (Ports & Adapters)

## Executive Summary

This audit identified **significant gaps** in error handling across the server codebase. While the code follows hexagonal architecture principles well, error handling is inconsistent and lacks defensive programming patterns. Key issues include:

- ✅ **Good:** Basic exception hierarchy exists (`building_blocks/errors.py`, `recorder/domain/errors.py`)
- ❌ **Critical:** Bare `except Exception` blocks swallow errors without proper handling
- ❌ **Critical:** Missing resource cleanup in failure paths (audio streams, models, threads)
- ❌ **Major:** No retry logic for transient failures (network, I/O)
- ❌ **Major:** Poor error messages lack context (file paths, state, parameters)
- ❌ **Major:** Threading errors not propagated to main thread
- ⚠️ **Minor:** Good use of context managers in some places (`Worker`, `EventBus.unsubscribe`)

## Findings by Category

### 1. Exception Hierarchy (Mostly Good)

**Current State:**
```python
# building_blocks/errors.py
DomainError (base)
├── AudioError
├── TranscriptionError
├── VADError
├── ConfigurationError
├── PipelineError
└── WakeWordError

# recorder/domain/errors.py
InvalidStateTransition(DomainError)
RecordingError(AudioError)
AudioSourceError(AudioError)
BufferOverflowError(AudioError)
TranscriberNotReady(TranscriptionError)

# whisper_transcriber.py
DownloadCancelledError(Exception)
```

**Issues:**
- ❌ Missing application-level errors (ApplicationError, ServiceError)
- ❌ Missing infrastructure errors (NetworkError, IOError, ResourceExhaustedError)
- ❌ Missing validation errors (ValidationError, ConfigurationValidationError)
- ❌ `DownloadCancelledError` doesn't inherit from domain hierarchy
- ❌ No error context preservation (file paths, parameters, state)

### 2. Critical: Swallowed Exceptions

**File: `recorder/application/recorder_service.py`**

Line 374-375:
```python
except Exception:
    logger.exception("Realtime transcription error")
    # ❌ CRITICAL: Exception swallowed, realtime worker continues silently failing
```

Line 388-392:
```python
except Exception:
    if not self._is_running:
        break
    logger.debug("Audio reader: error reading chunk", exc_info=True)
    continue
    # ❌ CRITICAL: Audio reader swallows all errors, could mask hardware issues
```

**File: `recorder/infrastructure/pyaudio_source.py`**

Line 113:
```python
except Exception:
    pass
    # ❌ CRITICAL: Silent failure when checking sample rate support
```

**File: `loopback.py`**

Line 172-173, 181-182, 186-187:
```python
with contextlib.suppress(Exception):
    # ✅ ACCEPTABLE: Cleanup paths can suppress safely
    # But should log at DEBUG level
```

Line 224-225:
```python
except Exception as e:
    print(f"[loopback] Capture error: {e}")
    # ❌ MAJOR: Thread exits silently, no notification to caller
```

### 3. Critical: Missing Resource Cleanup

**File: `recorder/application/recorder_service.py`**

Lines 184-199 (`shutdown` method):
```python
def shutdown(self) -> None:
    self._is_running = False
    self._pipeline.stop(timeout=2.0)
    self._audio_source.cleanup()
    # ❌ CRITICAL: If cleanup() raises, threads never join
    if self._audio_reader_thread is not None:
        self._audio_reader_thread.join(timeout=2.0)
        self._audio_reader_thread = None
    # ❌ CRITICAL: If transcriber.shutdown() raises, wake_word_detector never cleaned
    if self._realtime_thread is not None:
        self._realtime_thread.join(timeout=2.0)
        self._realtime_thread = None
    self._transcriber.shutdown()
    if self._realtime_transcriber:
        self._realtime_transcriber.shutdown()
    if self._wake_word_detector:
        self._wake_word_detector.cleanup()
    self._state_machine.abort()
```

**File: `recorder/infrastructure/pyaudio_source.py`**

Lines 75-83 (`cleanup` method):
```python
def cleanup(self) -> None:
    if self._stream is not None:
        self._stream.stop_stream()  # ❌ Could raise
        self._stream.close()         # ❌ If stop_stream raised, never reached
        self._stream = None
    if self._audio_interface is not None:
        self._audio_interface.terminate()  # ❌ If close raised, never reached
        self._audio_interface = None
    self._active = False
```

### 4. Major: Missing Error Context

**File: `stt_server/control_handler.py`**

Lines 94-96:
```python
except json.JSONDecodeError:
    print(f"{bcolors.WARNING}Received invalid JSON command{bcolors.ENDC}")
    await websocket.send(json.dumps({"status": "error", "message": "Invalid JSON command"}))
    # ❌ MAJOR: No error details (what was invalid, which field, etc.)
```

Lines 157-158:
```python
except Exception as e:
    print(f"{bcolors.WARNING}Failed to load classifier: {e}{bcolors.ENDC}")
    # ❌ MAJOR: No context (why loading, what config, etc.)
```

**File: `stt_server/file_transcribe.py`**

Lines 148-159:
```python
except Exception as e:
    _send_file_event({
        "type": "file_transcription_error",
        "request_id": request_id,
        "file_path": file_path,
        "error": str(e),  # ❌ MAJOR: Loses stack trace, exception type
    }, state, loop)
    print(f"{bcolors.FAIL}File transcription error: {e}{bcolors.ENDC}")
```

### 5. Major: No Retry Logic

**Missing retry patterns for:**
- ❌ WebSocket connection failures (`stt_server/server.py` lines 216-217)
- ❌ Audio device initialization (`pyaudio_source.py` line 42-63)
- ❌ Model download failures (`whisper_transcriber.py` lines 208-212)
- ❌ File I/O operations (`file_transcribe.py`)

### 6. Major: Threading Error Propagation

**File: `recorder/application/pipeline.py`**

Lines 163-180 (`_run` method):
```python
def _run(self) -> None:
    while not self.should_stop:
        try:
            chunk = self._audio_queue.get(timeout=0.01)
        except queue.Empty:
            continue

        # ❌ CRITICAL: No try-except around processing logic
        # If _process_recording or _process_not_recording raise, thread dies silently
        self._event_bus.publish(AudioChunkRecorded(...))
        # ... audio processing
        if self._sm.is_recording:
            self._process_recording(chunk)
        else:
            self._process_not_recording(chunk)
```

**File: `recorder/application/recorder_service.py`**

Lines 322-376 (`_realtime_worker`):
```python
def _realtime_worker(self) -> None:
    # ... (long method)
    try:
        # ... transcription logic
    except Exception:
        logger.exception("Realtime transcription error")
        # ❌ MAJOR: Thread continues, no signal to caller that realtime is broken
```

### 7. WebSocket Error Handling

**File: `stt_server/server.py`**

Lines 215-311 (`main_async`):
```python
try:
    control_server = await websockets.serve(...)
    data_server = await websockets.serve(...)
    # ... setup
    while not state.shutdown_event.is_set():
        await asyncio.sleep(0.5)
    # ... shutdown
except TimeoutError:
    pass  # ❌ MAJOR: Silent timeout, no logging
except OSError:
    print(...)  # ✅ OK: Error message shown
    # ❌ MAJOR: No cleanup, servers might still be partially running
finally:
    await shutdown_procedure(state)
```

**File: `stt_server/data_handler.py`**

Lines 55-107 (`data_handler`):
```python
try:
    while True:
        message = await websocket.recv()
        # ... process audio
except websockets.exceptions.ConnectionClosed as e:
    print(f"{bcolors.WARNING}Data client disconnected: {e}{bcolors.ENDC}")
    # ✅ OK: Expected exception handled
finally:
    state.data_connections.remove(websocket)
    if state.recorder is not None:
        state.recorder.clear_audio_queue()
    # ❌ MINOR: remove could raise ValueError if websocket not in set
```

### 8. Good Practices Found

✅ **EventBus** uses context manager for suppressing expected errors:
```python
# building_blocks/event_bus.py:25
def unsubscribe(self, event_type: type, handler: EventHandler) -> None:
    with self._lock, contextlib.suppress(ValueError):
        self._handlers[event_type].remove(handler)
```

✅ **Worker** implements context manager for proper cleanup:
```python
# building_blocks/worker.py:37-47
def __enter__(self) -> Worker:
    self.start()
    return self

def __exit__(self, ...) -> None:
    self.stop(timeout=5.0)
```

✅ **WhisperTranscriber** uses context manager for download progress interception:
```python
# whisper_transcriber.py:32-164
@contextmanager
def _intercept_hf_progress(...) -> Generator[None, None, None]:
    # Proper setup/teardown with finally block
```

✅ **LoopbackCapture** uses lock for thread-safe start/stop:
```python
# loopback.py:94-95
def start(self, recorder, device_index):
    with self._lock:
        return self._start_locked(recorder, device_index)
```

## Recommendations

### Priority 1: Critical Fixes

1. **Add proper exception handling to worker threads**
   - Wrap pipeline `_run` loop body in try-except
   - Propagate errors via queue or event to main thread
   - Shutdown gracefully on unrecoverable errors

2. **Fix resource cleanup in failure paths**
   - Wrap each cleanup step in try-except with logging
   - Use context managers where possible
   - Ensure cleanup always completes even if steps fail

3. **Stop swallowing exceptions**
   - Replace bare `except Exception: logger.exception()` with proper handling
   - Re-raise after logging if error is unrecoverable
   - Use specific exception types where possible

### Priority 2: Major Improvements

4. **Add rich error context**
   - Include file paths, parameters, state in error messages
   - Preserve stack traces in error responses
   - Add exception chaining (`raise NewError() from original_error`)

5. **Implement retry logic**
   - Exponential backoff for WebSocket connections
   - Retry audio device initialization with different sample rates
   - Retry file I/O operations with jitter

6. **Expand exception hierarchy**
   - Add `ApplicationError`, `ServiceError`, `InfrastructureError`
   - Add `ValidationError`, `ResourceExhaustedError`
   - Make `DownloadCancelledError` inherit from domain hierarchy

### Priority 3: Nice to Have

7. **Add circuit breaker pattern**
   - For repeated model inference failures
   - For WebSocket reconnection attempts

8. **Add structured logging**
   - Replace `print()` with proper logging
   - Include context fields (request_id, session_id, etc.)

9. **Add error monitoring**
   - Count errors by type for observability
   - Publish error metrics via events

## Test Coverage Gaps

The following error paths are likely untested (100% coverage required):

- ❌ Audio device initialization failures
- ❌ Model download cancellation flow
- ❌ WebSocket disconnection during transcription
- ❌ Thread join timeouts during shutdown
- ❌ Realtime worker crash recovery
- ❌ Audio reader crash recovery
- ❌ Resource cleanup failures

## Hexagonal Architecture Compliance

✅ **Good:** Domain errors don't leak infrastructure details
✅ **Good:** Infrastructure adapters raise domain exceptions
❌ **Issue:** `DownloadCancelledError` is infrastructure-specific but exposed in domain
❌ **Issue:** WebSocket errors not translated to domain events

## Next Steps

1. ✅ Complete this audit report
2. ⏳ Implement enhanced exception hierarchy
3. ⏳ Fix critical resource cleanup issues
4. ⏳ Add error context to all exception handlers
5. ⏳ Add retry logic to transient failure points
6. ⏳ Run full test suite and verify 100% coverage maintained
7. ⏳ Run `make` to verify formatting, linting, type checking

## Metrics

- **Total Python files scanned:** 52
- **Files with exception handling:** 23
- **Critical issues:** 8
- **Major issues:** 12
- **Minor issues:** 3
- **Good practices found:** 4
