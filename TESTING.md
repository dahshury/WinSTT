# Testing

This document describes the testing stack used by WinSTT — what each tool is for,
where the tests live, and how to run / extend them.

It does **not** duplicate the architecture rules in [`frontend/CLAUDE.md`](frontend/CLAUDE.md)
and [`server/CLAUDE.md`](server/CLAUDE.md). Read those first if you need layer or
import contracts.

---

## The Testing Stack

WinSTT uses five categories of tests. They escalate from cheapest-to-write
(unit) to most-expensive-to-maintain (E2E).

### 1. Unit Tests

Plain example-based tests that pin behaviour on a fixed input.

| Side       | Runner                              | Layout                                    |
| ---------- | ----------------------------------- | ----------------------------------------- |
| Frontend   | Bun test (`bun test`)               | `*.test.ts` / `*.test.tsx` colocated with source |
| Server     | pytest (`uv run pytest`)            | `server/tests/unit/**/test_*.py`          |

- Frontend preload + happy-DOM globals live in `frontend/test/preload.ts`
  (configured by [`frontend/bunfig.toml`](frontend/bunfig.toml)).
- Server unit tests must not touch I/O or threads — they consume Fake adapters
  from `server/tests/fakes/` and inject a `Clock.fixed_clock()` for deterministic time.

### 2. Property Tests

Property-based tests assert an **invariant over a generated input space** rather
than a single hand-picked example. Each property test file sits **next to** its
source and its example-based unit test:

```
src/shared/lib/format-bytes.ts
src/shared/lib/format-bytes.test.ts          # example-based
src/shared/lib/format-bytes.property.test.ts # property-based
```

| Side       | Library     | Filename suffix              |
| ---------- | ----------- | ---------------------------- |
| Frontend   | fast-check  | `*.property.test.ts`         |
| Server     | hypothesis  | `test_*_property.py`         |

Patterns we use, with one example per side:

| Pattern         | What it checks                                                                 |
| --------------- | ------------------------------------------------------------------------------ |
| Round-trip      | `decode(encode(x)) === x` for all valid `x`                                    |
| Idempotence     | `f(f(x)) === f(x)`                                                             |
| Invariant       | A structural property holds for every output (e.g. "always non-negative")      |
| Oracle          | A fast/clever implementation matches a slow/obvious reference                  |
| Model-based     | A stateful system stays consistent vs. a simpler in-memory model over actions  |

#### Frontend example — invariant + monotonicity

From `frontend/src/shared/lib/format-bytes.property.test.ts`:

```ts
import { describe, test } from "bun:test";
import fc from "fast-check";
import { formatBytes } from "./format-bytes";

const GIB = 1024 * 1024 * 1024;

describe("formatBytes property tests", () => {
  test("monotonic within the GB tier (a < b ⇒ rendered value non-decreasing)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: GIB, max: 100 * GIB }),
        fc.integer({ min: GIB, max: 100 * GIB }),
        (a, b) => {
          fc.pre(a < b);
          const outA = formatBytes(a, { gbDecimals: 3 });
          const outB = formatBytes(b, { gbDecimals: 3 });
          if (outA === null || outB === null) return false;
          return Number.parseFloat(outA) <= Number.parseFloat(outB);
        }
      ),
      { numRuns: 200 }
    );
  });
});
```

#### Server example — model-based / state-machine

From `server/tests/unit/recorder/test_state_machine_property.py`:

```python
from hypothesis import given, settings
from hypothesis import strategies as st

from src.recorder.domain.errors import InvalidStateTransition
from src.recorder.domain.state_machine import RecorderState, RecorderStateMachine


@settings(max_examples=200)
@given(st.lists(st.sampled_from(list(RecorderState)), max_size=20))
def test_abort_always_reaches_inactive(transitions: list[RecorderState]) -> None:
    sm = RecorderStateMachine()
    for target in transitions:
        try:
            sm.transition(target)
        except InvalidStateTransition:
            pass
    sm.abort()
    assert sm.state == RecorderState.INACTIVE
```

The property: no matter how many (legal or rejected) transitions you fire,
`abort()` always lands on `INACTIVE`. That single assertion replaces dozens of
hand-written cases.

### 3. Mutation Testing — Frontend Only

We run [Stryker](https://stryker-mutator.io/) against a curated set of
**pure-logic** modules. Configured in
[`frontend/stryker.conf.json`](frontend/stryker.conf.json):

- 19 files are mutated (see `mutate` array). Adding a mutant target also
  requires extending the `commandRunner.command` to run the matching tests.
- PR builds **do not** run Stryker — it would dominate the CI budget. The
  nightly workflow [`.github/workflows/mutation.yml`](.github/workflows/mutation.yml)
  runs at **06:00 UTC** daily on `windows-latest` and uploads the HTML report
  (`frontend/reports/mutation/`) as a 30-day artifact.
- Failure is informational: the job uses `continue-on-error`. Surviving
  mutants point at weak tests, not necessarily real bugs.

Server mutation testing is not set up yet — pytest + hypothesis cover the
domain layer well, and tooling for Python mutation (mutmut, cosmic-ray) hasn't
been worth the maintenance cost so far.

### 4. CRAP Analysis — Frontend Only

CRAP = `complexity² × (1 − coverage)³ + complexity`. A function with both high
cyclomatic complexity *and* poor coverage scores high.

- `frontend/scripts/crap.ts` produces `frontend/reports/crap.json` (per-function
  metrics) and a text summary.
- `frontend/scripts/crap-gate.ts` compares two reports and fails CI on
  regression (default tolerance: 0).

Workflow:

```
bun run scripts/crap.ts                              # refresh reports/crap.json
cp reports/crap.json reports/crap-baseline.json      # baseline once you're happy
bun run crap:gate                                    # fails if any function regressed
```

The CI job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs CRAP
with `--skip-coverage` (reusing the lcov produced by the test step) and uploads
`crap.json` as an artifact.

### 5. End-to-End — Playwright

Located in [`frontend/e2e/`](frontend/e2e/), configured by
[`frontend/playwright.config.ts`](frontend/playwright.config.ts).

| File                              | Project    | What it covers                              |
| --------------------------------- | ---------- | ------------------------------------------- |
| `smoke.e2e.ts`                    | chromium   | Static SPA boots, title/main region render  |
| `settings-window.e2e.ts`          | chromium   | Settings entry HTML                         |
| `tray-menu.e2e.ts`                | chromium   | Tray menu entry HTML                        |
| `overlay-pill.electron.e2e.ts`    | electron   | Real Electron — transparent overlay timing  |

The `chromium` project drives a static `vite preview` of `dist-renderer/`. The
`electron` project uses `playwright-core`'s `_electron.launch()` and bypasses
the web server (`PW_SKIP_WEBSERVER=1`).

---

## How to Run Tests

### Frontend (from `frontend/`)

| Command                       | What it runs                                              |
| ----------------------------- | --------------------------------------------------------- |
| `bun test`                    | All `*.test.ts` (units + property tests via Bun runner)   |
| `bun test <path>`             | Single file                                               |
| `bun test --watch`            | Watch mode                                                |
| `bun test --coverage`         | With lcov coverage to `coverage/lcov.info`                |
| `bun run test:e2e`            | Playwright `chromium` project (renderer)                  |
| `bun run test:e2e:electron`   | Playwright `electron` project (real Electron)             |
| `bunx stryker run`            | Mutation testing (slow — usually nightly only)            |
| `bun run scripts/crap.ts`     | Refresh CRAP report                                       |
| `bun run crap:gate`           | Compare CRAP report against baseline                      |

### Server (from `server/`)

| Command                                                   | What it runs                                 |
| --------------------------------------------------------- | -------------------------------------------- |
| `make`                                                    | Format + lint + mypy + tests (full check)    |
| `uv run pytest`                                           | All tests with coverage gate                 |
| `uv run pytest tests/unit/recorder/test_state_machine.py` | Single file                                  |
| `uv run pytest -k "test_abort"`                           | Single test by name across the suite         |
| `uv run pytest --hypothesis-seed=12345`                   | Reproduce a failed property test             |
| `uv run pytest --cov-fail-under=99`                       | Lenient gate (matches local-ci.ps1)          |

Server coverage gate is **100%** locally (`fail_under = 100` in
[`server/pyproject.toml`](server/pyproject.toml)). The CI job and the
`scripts/local-ci.ps1` helper both relax to **99%** — see
`memory/project_server_coverage_preexisting_gap.md` for the rationale.

---

## How to Add a Property Test

1. **Identify the invariant.** Examples: "the output is always sorted",
   "the function is idempotent on its outputs", "decode is the inverse of
   encode for all valid inputs", "the state machine never leaves INACTIVE
   after `abort()`".
2. **Create the file next to the source.** Frontend:
   `src/<layer>/<slice>/lib/<name>.property.test.ts`. Server:
   `tests/unit/<area>/test_<name>_property.py`.
3. **Write the test using the matching library.** Reuse the patterns from the
   examples above. Keep `numRuns` / `max_examples` sane (100–500 is plenty
   for pure logic; lower for tests that hit expensive computation).
4. **Run it locally** — `bun test src/.../foo.property.test.ts` or
   `uv run pytest tests/unit/.../test_foo_property.py`.
5. **(Frontend only) If the module is high-value pure logic**, add it to
   [`frontend/stryker.conf.json`](frontend/stryker.conf.json):
   - Append the source file path to `mutate`.
   - Append both the `*.test.ts` and `*.property.test.ts` paths to
     `commandRunner.command` so each mutant is killed by both.

---

## How to Investigate a Stryker Survivor

1. Go to the latest run of the
   [Mutation Testing workflow](.github/workflows/mutation.yml) on GitHub.
2. Download the `mutation-report` artifact.
3. Open `reports/mutation/mutation.html` in a browser.
4. Filter by **Survived** status and locate one of interest.
5. Read the mutant — it shows the original code, the mutated code, and the
   tests that ran against it.
6. Add (or strengthen) a test such that running it against the mutated code
   would **fail** but against the original passes. This usually means
   asserting a previously implicit branch outcome or boundary value.
7. Re-run locally: `bunx stryker run --mutate <path-to-mutated-file>` to
   confirm the survivor is now killed before opening a PR.

If a survivor is genuinely equivalent (the mutation produces semantically
identical behaviour), leave a `// Stryker disable next-line ...` directive
with a brief justification rather than silently ignoring it.

---

## What Is NOT Covered Yet

Be aware of the gaps before relying on green CI as a complete signal:

- **Visual regression.** No pixel-diff harness against the Electron windows.
  Playwright takes screenshots only on failure — they aren't compared to a
  baseline.
- **Contract tests.** [`spec/openapi.yaml`](spec/openapi.yaml) is the single
  source of truth for shared types, and `bun generate` produces compile-time
  TypeScript types from it. There is **no runtime validation** wired into the
  WebSocket dispatch path yet — a Python server change can silently break the
  contract until the renderer crashes on a missing field. An opt-in zod
  validator for the most-trafficked data-channel events lives at
  [`frontend/electron/ws/contract.ts`](frontend/electron/ws/contract.ts) (see
  also `contract.test.ts` + `contract.property.test.ts`); call sites can import
  `validateServerEvent` to enable runtime checks where desired.
- **Fuzzing.** Property tests cover invariants but no harness drives random
  bytes against the WebSocket parsers, IPC channels, or the PCM ingestion
  path.
- **Performance regression baselines.** Latency / throughput of the STT
  pipeline isn't tracked across commits. Manual perf checks via
  `server/scratch/` only.

These are tracked as ongoing work — contributions in any of the four are
welcome.

---

## Related Files

- [`frontend/CLAUDE.md`](frontend/CLAUDE.md) — frontend architecture rules
- [`server/CLAUDE.md`](server/CLAUDE.md) — server architecture rules
- [`frontend/bunfig.toml`](frontend/bunfig.toml) — Bun test config
- [`frontend/stryker.conf.json`](frontend/stryker.conf.json) — mutation targets
- [`frontend/playwright.config.ts`](frontend/playwright.config.ts) — E2E config
- [`server/pyproject.toml`](server/pyproject.toml) — pytest + coverage config
- [`scripts/local-ci.ps1`](scripts/local-ci.ps1) — run CI locally on Windows
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — PR pipeline
- [`.github/workflows/mutation.yml`](.github/workflows/mutation.yml) — nightly mutation
