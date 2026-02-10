# Deep Bug Reproduction via TDD

You are fixing a bug. Your job is to write a test that **reproduces the exact failure** before writing any fix. Not a test that verifies a helper method. Not a test that passes whether or not the fix exists. A test that **crashes, segfaults, deadlocks, or fails in the same way the production code did**.

## The Depth Mandate

AI agents default to shallow tests: they test pure-Python helpers, in-memory stubs, and mock behavior. These tests pass with or without the fix and prove nothing. You must go deeper.

**The litmus test:** If you revert the fix, does the test fail? If not, you have not reproduced the bug. Go deeper.

## Workflow

### 1. Analyze the failure

Read the error log, stack trace, or user report. Identify:
- **The exact code path** that crashed (file, function, line)
- **The trigger** (what user action or sequence caused it)
- **The environment** (threads, hardware, libraries, timing)

### 2. Classify the depth

| Bug Type | Shallow (WRONG) | Deep (RIGHT) |
|---|---|---|
| Native library crash (segfault, access violation) | Test Python/TS wrapper method | Use the real native library, trigger the race |
| Concurrency bug (race condition, deadlock) | Test single-threaded logic | Spawn real threads, use barriers to force interleaving |
| Hardware interaction (audio, GPU, filesystem) | Mock the hardware interface | Open real device, exercise real I/O |
| Network failure (timeout, disconnect) | Mock HTTP client | Real server/client, kill connection mid-operation |
| State corruption (stale data, leaked resources) | Assert initial state is clean | Run N cycles rapidly, check state after each |

### 3. Write the test FIRST (Red)

```
DO:
  - Use the REAL library/device/hardware for the component that crashed
  - Use lightweight stubs ONLY for components the crashing code calls into
    that are expensive but irrelevant to the failure
  - Reproduce the exact trigger sequence (rapid cycling, concurrent access, etc.)
  - Use pytest.mark.skipif for hardware-dependent tests so CI doesn't break
  - Name the test after what it reproduces: test_rapid_start_stop_segfault

DO NOT:
  - Stub/fake/mock the component that crashed
  - Test helper methods that support the fix instead of the failure itself
  - Write a test that passes immediately
  - Skip writing the test because "it needs real hardware"
```

### 4. Run the test — watch it FAIL (Verify Red)

The test must fail in the same way as production:
- Segfault → process crashes with signal 139/access violation
- Race condition → assertion failure or hang
- Resource leak → measurable resource exhaustion

**If the test passes:** You are not at the right depth. Go deeper:
- Are you using fakes where you should use real libraries?
- Are you testing a wrapper instead of the actual crashing function?
- Is the timing/concurrency realistic?

### 5. Write the minimal fix (Green)

Now — and only now — write the fix. Run the test. It should pass.

### 6. Verify the fix catches the bug (Critical)

Mentally (or actually) revert the fix. The test must fail again. If it passes with or without the fix, the test is shallow and worthless. Delete it and write a deeper one.

### 7. Run all tests (Refactor)

Ensure no regressions.

## Real Example: What Happened Today

**Bug:** Server segfaults when rapidly switching between Listen and PTT modes.

**Stack trace:** 3 concurrent threads stuck in `pyaudiowpatch.read()` — PortAudio access violation.

**Shallow attempt (WRONG):**
```python
# Tests helper methods — passes with or without the fix
def test_clear_feed_buffer(self):
    service._feed_buffer = bytearray(b"\x01\x02\x03")
    service.clear_feed_buffer()
    assert len(service._feed_buffer) == 0
```
This test tells you the bytearray resets. It tells you nothing about whether PortAudio will segfault.

**Deep reproduction (RIGHT):**
```python
@pytest.mark.skipif(DEVICE_INDEX is None, reason="No loopback device")
def test_rapid_start_stop_cycles(self):
    """Without the fix, this segfaults with 3 threads in pyaudiowpatch.read()."""
    lc = LoopbackCapture()      # Real LoopbackCapture
    stub = RecorderStub()       # Stub only for the recorder interface

    for i in range(10):
        lc.start(stub, DEVICE_INDEX)   # Real pyaudiowpatch, real PortAudio
        time.sleep(0.05)               # Near-zero gap — the crash condition
        lc.stop(stub)
        assert not lc.is_active

def test_concurrent_start_stop_threads(self):
    """Start and stop racing from different threads — worst-case scenario."""
    lc = LoopbackCapture()
    stub = RecorderStub()
    barrier = threading.Barrier(2)

    def start_worker():
        barrier.wait()
        for _ in range(5):
            lc.start(stub, DEVICE_INDEX)
            time.sleep(0.02)

    def stop_worker():
        barrier.wait()
        for _ in range(5):
            lc.stop(stub)
            time.sleep(0.02)

    t1 = threading.Thread(target=start_worker)
    t2 = threading.Thread(target=stop_worker)
    t1.start(); t2.start()
    t1.join(); t2.join()
```

**Result:** First test run → segfault (exit code 139). Proved the bug exists. After fix → 6/6 pass.

**Root cause found through the test:** The lock alone wasn't enough. The real test revealed that `_stop_locked` was calling `stream.close()` while the capture thread was blocked in `stream.read()`. The join timed out, the old thread kept running, and `_start_locked` replaced `self._stream` — causing two threads to read from the same stream. Fix required: (1) call `stop_stream()` before joining to unblock read, (2) pass stream as a local to the capture thread.

The shallow tests would never have found this. The deep test crashed immediately and pointed straight at the root cause.

## The Stub Decision

Stub components **called by** the crashing code, not the crashing code itself:

```
Bug in: LoopbackCapture (PortAudio stream management)
  → LoopbackCapture: REAL ← this is broken, must be real
  → pyaudiowpatch:   REAL ← this is the library that segfaults
  → Recorder:        STUB ← LoopbackCapture calls its methods but
                            the crash has nothing to do with recorder internals
```

The stub only needs to implement methods the crashing code actually calls. Keep it minimal:
```python
class RecorderStub:
    def __init__(self):
        self.post_speech_silence_duration = 0.5
    def set_microphone(self, on): pass
    def set_external_audio_mode(self, active): pass
    def clear_feed_buffer(self): pass
    def wakeup(self): pass
    def feed_audio(self, chunk, original_sample_rate=16000): pass
```

## Checklist

Before claiming the bug is reproduced:

- [ ] Test uses the REAL library/component that crashed
- [ ] Test triggers the EXACT failure condition (concurrency, timing, hardware)
- [ ] Test FAILS (crashes/errors) before the fix is applied
- [ ] Test PASSES after the fix is applied
- [ ] Stubs are used ONLY for components irrelevant to the crash
- [ ] Test is named after what it reproduces, not what it verifies
- [ ] Hardware-dependent tests have skip markers for CI
- [ ] Root cause was identified through the test failure, not guessed from code reading
