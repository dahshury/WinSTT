# Testing Anti-Patterns

**Load this reference when:** writing or changing tests, adding mocks, or tempted to add test-only methods to production code.

## Overview

Tests must verify real behavior, not mock behavior. Mocks are a means to isolate, not the thing being tested.

**Core principle:** Test what the code does, not what the mocks do.

**Following strict TDD prevents these anti-patterns.**

## The Iron Laws

```
1. NEVER test mock behavior
2. NEVER add test-only methods to production classes
3. NEVER mock without understanding dependencies
```

## Anti-Pattern 1: Testing Mock Behavior

**The violation:**
```typescript
// ❌ BAD: Testing that the mock exists
test('renders sidebar', () => {
  render(<Page />);
  expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
});
```

**Why this is wrong:**
- You're verifying the mock works, not that the component works
- Test passes when mock is present, fails when it's not
- Tells you nothing about real behavior

**your human partner's correction:** "Are we testing the behavior of a mock?"

**The fix:**
```typescript
// ✅ GOOD: Test real component or don't mock it
test('renders sidebar', () => {
  render(<Page />);  // Don't mock sidebar
  expect(screen.getByRole('navigation')).toBeInTheDocument();
});

// OR if sidebar must be mocked for isolation:
// Don't assert on the mock - test Page's behavior with sidebar present
```

### Gate Function

```
BEFORE asserting on any mock element:
  Ask: "Am I testing real component behavior or just mock existence?"

  IF testing mock existence:
    STOP - Delete the assertion or unmock the component

  Test real behavior instead
```

## Anti-Pattern 2: Test-Only Methods in Production

**The violation:**
```typescript
// ❌ BAD: destroy() only used in tests
class Session {
  async destroy() {  // Looks like production API!
    await this._workspaceManager?.destroyWorkspace(this.id);
    // ... cleanup
  }
}

// In tests
afterEach(() => session.destroy());
```

**Why this is wrong:**
- Production class polluted with test-only code
- Dangerous if accidentally called in production
- Violates YAGNI and separation of concerns
- Confuses object lifecycle with entity lifecycle

**The fix:**
```typescript
// ✅ GOOD: Test utilities handle test cleanup
// Session has no destroy() - it's stateless in production

// In test-utils/
export async function cleanupSession(session: Session) {
  const workspace = session.getWorkspaceInfo();
  if (workspace) {
    await workspaceManager.destroyWorkspace(workspace.id);
  }
}

// In tests
afterEach(() => cleanupSession(session));
```

### Gate Function

```
BEFORE adding any method to production class:
  Ask: "Is this only used by tests?"

  IF yes:
    STOP - Don't add it
    Put it in test utilities instead

  Ask: "Does this class own this resource's lifecycle?"

  IF no:
    STOP - Wrong class for this method
```

## Anti-Pattern 3: Mocking Without Understanding

**The violation:**
```typescript
// ❌ BAD: Mock breaks test logic
test('detects duplicate server', () => {
  // Mock prevents config write that test depends on!
  vi.mock('ToolCatalog', () => ({
    discoverAndCacheTools: vi.fn().mockResolvedValue(undefined)
  }));

  await addServer(config);
  await addServer(config);  // Should throw - but won't!
});
```

**Why this is wrong:**
- Mocked method had side effect test depended on (writing config)
- Over-mocking to "be safe" breaks actual behavior
- Test passes for wrong reason or fails mysteriously

**The fix:**
```typescript
// ✅ GOOD: Mock at correct level
test('detects duplicate server', () => {
  // Mock the slow part, preserve behavior test needs
  vi.mock('MCPServerManager'); // Just mock slow server startup

  await addServer(config);  // Config written
  await addServer(config);  // Duplicate detected ✓
});
```

### Gate Function

```
BEFORE mocking any method:
  STOP - Don't mock yet

  1. Ask: "What side effects does the real method have?"
  2. Ask: "Does this test depend on any of those side effects?"
  3. Ask: "Do I fully understand what this test needs?"

  IF depends on side effects:
    Mock at lower level (the actual slow/external operation)
    OR use test doubles that preserve necessary behavior
    NOT the high-level method the test depends on

  IF unsure what test depends on:
    Run test with real implementation FIRST
    Observe what actually needs to happen
    THEN add minimal mocking at the right level

  Red flags:
    - "I'll mock this to be safe"
    - "This might be slow, better mock it"
    - Mocking without understanding the dependency chain
```

## Anti-Pattern 4: Incomplete Mocks

**The violation:**
```typescript
// ❌ BAD: Partial mock - only fields you think you need
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' }
  // Missing: metadata that downstream code uses
};

// Later: breaks when code accesses response.metadata.requestId
```

**Why this is wrong:**
- **Partial mocks hide structural assumptions** - You only mocked fields you know about
- **Downstream code may depend on fields you didn't include** - Silent failures
- **Tests pass but integration fails** - Mock incomplete, real API complete
- **False confidence** - Test proves nothing about real behavior

**The Iron Rule:** Mock the COMPLETE data structure as it exists in reality, not just fields your immediate test uses.

**The fix:**
```typescript
// ✅ GOOD: Mirror real API completeness
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' },
  metadata: { requestId: 'req-789', timestamp: 1234567890 }
  // All fields real API returns
};
```

### Gate Function

```
BEFORE creating mock responses:
  Check: "What fields does the real API response contain?"

  Actions:
    1. Examine actual API response from docs/examples
    2. Include ALL fields system might consume downstream
    3. Verify mock matches real response schema completely

  Critical:
    If you're creating a mock, you must understand the ENTIRE structure
    Partial mocks fail silently when code depends on omitted fields

  If uncertain: Include all documented fields
```

## Anti-Pattern 5: Shallow Bug Reproduction

**The violation:**
```python
# Bug: PortAudio segfaults when loopback start/stop interleave concurrently.
# Stack trace shows 3 capture threads stuck in pyaudiowpatch.read().

# ❌ BAD: "reproduces" the bug by testing helper methods with fakes
def test_clear_feed_buffer(self):
    service._feed_buffer = bytearray(b"\x01\x02\x03")
    service.clear_feed_buffer()
    assert len(service._feed_buffer) == 0

def test_set_external_audio_mode(self):
    service.set_external_audio_mode(True)
    assert service._external_audio_mode is True
```

**Why this is wrong:**
- **Tests verify helper methods, not the actual failure** — the segfault is in PortAudio's C library during concurrent stream operations, not in a Python bytearray
- **Zero chance of catching the real bug** — these pass whether or not the lock exists, whether or not `stop_stream()` is called before `join()`
- **Gives false confidence** — "all tests pass" means nothing when no test exercises the failure path
- **AI agents default to this** — they test what's easy (pure Python methods) not what's hard (real hardware, real concurrency)

**The fix:**
```python
# ✅ GOOD: Reproduces the EXACT conditions that caused the crash

@pytest.mark.skipif(DEVICE_INDEX is None, reason="No loopback device")
def test_rapid_start_stop_cycles(self):
    """Without the fix, this segfaults — 3 threads in pyaudiowpatch.read()."""
    lc = LoopbackCapture()      # Real LoopbackCapture
    stub = RecorderStub()       # Lightweight stub for recorder interface

    for i in range(10):
        lc.start(stub, DEVICE_INDEX)   # Real pyaudiowpatch, real PortAudio
        time.sleep(0.05)               # Minimal delay — the bug needs near-zero gaps
        lc.stop(stub)                  # Real stream close, real thread join
        assert not lc.is_active

def test_concurrent_start_stop_threads(self):
    """Worst-case race: start and stop from different threads simultaneously."""
    lc = LoopbackCapture()
    stub = RecorderStub()
    barrier = threading.Barrier(2)
    errors = []

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
    assert not errors
```

### The Depth Rule

When reproducing a bug, the test must exercise **the same code path that crashed**:

| Bug Location | Shallow (Wrong) | Deep (Right) |
|---|---|---|
| PortAudio C library segfault | Test Python buffer helper | Open real PortAudio streams, race start/stop |
| WebSocket connection drop | Mock WebSocket, assert call count | Real WebSocket server, kill connection mid-transfer |
| CUDA out-of-memory | Test tensor shape math | Load real model, feed real batch, measure VRAM |
| File lock contention | Test lock acquire/release | Open real file from 2 threads, race writes |
| SQL deadlock | Test query builder | Real database, concurrent transactions |

**Key insight:** If your test would pass even without the fix, it doesn't reproduce the bug.

### The Stub vs. Real Decision

Use **real** dependencies for the component that crashed. Use **stubs** only for components the crashing component *calls into* that are expensive but irrelevant to the failure:

```
Bug in: LoopbackCapture (PortAudio stream management)
  → LoopbackCapture: REAL (this is where the bug lives)
  → pyaudiowpatch: REAL (this is the library that segfaults)
  → AudioToTextRecorder: STUB (LoopbackCapture calls its methods,
    but the segfault has nothing to do with the recorder's internals)
```

The stub must implement the same interface the real component exposes — but only the methods actually called. Don't stub the thing that's broken. Don't use fakes for the layer where the crash occurs.

### Gate Function

```
BEFORE writing a bug reproduction test:
  Ask: "If I remove the fix, does this test FAIL or CRASH?"

  IF it still passes without the fix:
    STOP — You're testing helpers, not reproducing the bug.
    Go deeper: use real libraries, real hardware, real concurrency.

  IF it crashes/fails without the fix AND passes with it:
    ✓ You've reproduced the bug at the right depth.

  Ask: "Does this test exercise the EXACT code path from the stack trace?"

  IF no:
    STOP — Trace the stack, identify the real failure point,
    and write a test that hits that exact path.
```

## Anti-Pattern 6: Integration Tests as Afterthought

**The violation:**
```
✅ Implementation complete
❌ No tests written
"Ready for testing"
```

**Why this is wrong:**
- Testing is part of implementation, not optional follow-up
- TDD would have caught this
- Can't claim complete without tests

**The fix:**
```
TDD cycle:
1. Write failing test
2. Implement to pass
3. Refactor
4. THEN claim complete
```

## When Mocks Become Too Complex

**Warning signs:**
- Mock setup longer than test logic
- Mocking everything to make test pass
- Mocks missing methods real components have
- Test breaks when mock changes

**your human partner's question:** "Do we need to be using a mock here?"

**Consider:** Integration tests with real components often simpler than complex mocks

## TDD Prevents These Anti-Patterns

**Why TDD helps:**
1. **Write test first** → Forces you to think about what you're actually testing
2. **Watch it fail** → Confirms test tests real behavior, not mocks
3. **Minimal implementation** → No test-only methods creep in
4. **Real dependencies** → You see what the test actually needs before mocking

**If you're testing mock behavior, you violated TDD** - you added mocks without watching test fail against real code first.

## Quick Reference

| Anti-Pattern | Fix |
|--------------|-----|
| Assert on mock elements | Test real component or unmock it |
| Test-only methods in production | Move to test utilities |
| Mock without understanding | Understand dependencies first, mock minimally |
| Incomplete mocks | Mirror real API completely |
| Shallow bug reproduction | Use real libs/hardware for the crashing component |
| Tests as afterthought | TDD - tests first |
| Over-complex mocks | Consider integration tests |

## Red Flags

- Assertion checks for `*-mock` test IDs
- Methods only called in test files
- Mock setup is >50% of test
- Test fails when you remove mock
- Can't explain why mock is needed
- Mocking "just to be safe"
- Bug reproduction test still passes when fix is reverted
- Testing helper methods instead of the crashing code path
- Using fakes for the component that actually crashed
- "Can't test this because it needs real hardware" (yes you can — skip on CI if needed)

## The Bottom Line

**Mocks are tools to isolate, not things to test.**

If TDD reveals you're testing mock behavior, you've gone wrong.

Fix: Test real behavior or question why you're mocking at all.
