import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { electronStoreMock } from "@test/mocks/electron-store";

// Mock the underlying `electron-store` package (same approach as
// store.test.ts) so the REAL `./store` module loads cleanly. We don't
// mock `./store` directly — that would conflict with store.test.ts's
// own setup under bun's process-global mock.module registry.
mock.module("electron-store", () => electronStoreMock());

const { store } = await import("./store");
const {
	notifyHotkeyPressed,
	consumeRecordingStart,
	notifyRecordingStop,
	debugRecordingState,
	__resetRecordingStateForTesting__,
} = await import("./recording-state");

// Capture the AS-CONSTRUCTED module state BEFORE any beforeEach runs.
// Locks in the L21 (`signaledIntent = false`) and L22 (`recordingActive
// = false`) module-level let initializers; once
// `__resetRecordingStateForTesting__` runs in beforeEach, mutated
// defaults (e.g. `true`) are overwritten and indistinguishable from
// the original.
const INITIAL_MODULE_STATE = debugRecordingState();

function setMode(mode: "ptt" | "toggle" | "listen"): void {
	store.set("general.recordingMode", mode);
}

beforeEach(() => {
	setMode("ptt");
	__resetRecordingStateForTesting__();
});

// The `./store` singleton is shared across test files in bun's process.
// Reset to the schema default after our tests so store.test.ts (which
// asserts the default value) isn't poisoned by our mutations.
afterAll(() => {
	setMode("ptt");
	__resetRecordingStateForTesting__();
});

describe("recording-state gate (PTT mode)", () => {
	test("press → start: legitimate first start is honoured", () => {
		notifyHotkeyPressed();
		expect(consumeRecordingStart()).toBe(true);
	});

	test("press → start → stop → STRAY START: the duplicate is REJECTED", () => {
		// This is the user's exact bug: the pill hides correctly then a
		// stray server-emitted `recording_start` arrives later and
		// re-shows it. The gate must reject the second start.
		notifyHotkeyPressed();
		expect(consumeRecordingStart()).toBe(true);
		notifyRecordingStop();
		expect(consumeRecordingStart()).toBe(false);
	});

	test("brief press (release before start arrives) is still honoured", () => {
		// User taps PTT very briefly: the press signals intent, then the
		// user releases. The server-emitted `recording_start` arrives
		// after the release. The intent flag survives until consumed.
		notifyHotkeyPressed();
		expect(consumeRecordingStart()).toBe(true);
	});

	test("two rapid presses each authorise their own start", () => {
		notifyHotkeyPressed();
		expect(consumeRecordingStart()).toBe(true);
		notifyRecordingStop();
		notifyHotkeyPressed();
		expect(consumeRecordingStart()).toBe(true);
		notifyRecordingStop();
	});

	test("two presses BEFORE any start: only one start is honoured (single-shot)", () => {
		notifyHotkeyPressed();
		notifyHotkeyPressed();
		expect(consumeRecordingStart()).toBe(true);
		expect(consumeRecordingStart()).toBe(false);
	});

	test("recording_start with no preceding press is rejected", () => {
		expect(consumeRecordingStart()).toBe(false);
	});
});

describe("recording-state gate (toggle mode)", () => {
	test("first press signals intent; recording_start is honoured", () => {
		setMode("toggle");
		notifyHotkeyPressed();
		expect(consumeRecordingStart()).toBe(true);
	});

	test("second press (the 'stop press') does NOT refresh intent", () => {
		setMode("toggle");
		notifyHotkeyPressed();
		expect(consumeRecordingStart()).toBe(true);
		notifyHotkeyPressed(); // user pressed to stop
		notifyRecordingStop();
		expect(consumeRecordingStart()).toBe(false);
	});
});

describe("recording-state gate (listen mode)", () => {
	test("recording_start is always honoured (no hotkey involved)", () => {
		setMode("listen");
		expect(consumeRecordingStart()).toBe(true);
		notifyRecordingStop();
		expect(consumeRecordingStart()).toBe(true);
	});

	// Locks in L56 `recordingActive = true` in the listen-mode branch of
	// consumeRecordingStart. A mutant that sets it to `false` would mean
	// the next call to debugRecordingState() reports active=false even
	// though we just consumed a start in listen mode.
	test("listen-mode consumeRecordingStart sets recordingActive=true (locks in L56)", () => {
		setMode("listen");
		expect(consumeRecordingStart()).toBe(true);
		// Now check that recordingActive is in the "true" state.
		// debugRecordingState() returns { active, pendingIntent }.
		expect(debugRecordingState().active).toBe(true);
	});
});

// ─── Module-init defaults (BEFORE beforeEach runs) ───────────────────
describe("recording-state module-init defaults", () => {
	test("signaledIntent and recordingActive both default to false at construction", () => {
		// Captured BEFORE any beforeEach() __reset, so this sees the actual
		// L21/L22 module-level initializers.
		expect(INITIAL_MODULE_STATE.pendingIntent).toBe(false);
		expect(INITIAL_MODULE_STATE.active).toBe(false);
	});
});

// ─── notifyRecordingStop hard contract ──────────────────────────────
// Locks in L71 (function body) and L72 (`recordingActive = false`).
// Without this assertion, an empty-body mutant or a `true` mutant on
// the recordingActive assignment would leak through because no test
// checks the post-stop state when both fields were previously true.
describe("notifyRecordingStop clears module state to false", () => {
	test("clears recordingActive to false after a successful start (locks in L72)", () => {
		setMode("listen");
		consumeRecordingStart(); // active=true
		expect(debugRecordingState().active).toBe(true);
		notifyRecordingStop();
		// recordingActive MUST be false after stop. A `recordingActive =
		// true` mutant would leave it at true.
		expect(debugRecordingState().active).toBe(false);
	});

	test("clears signaledIntent to false (PTT scenario where intent never consumed)", () => {
		setMode("ptt");
		notifyHotkeyPressed(); // signaledIntent=true (never consumed)
		expect(debugRecordingState().pendingIntent).toBe(true);
		notifyRecordingStop();
		// signaledIntent MUST be false. An empty-body mutant for the
		// function would leave it true.
		expect(debugRecordingState().pendingIntent).toBe(false);
	});

	test("notifyRecordingStop is idempotent (calling twice still leaves both false)", () => {
		setMode("listen");
		consumeRecordingStart();
		notifyRecordingStop();
		notifyRecordingStop();
		const s = debugRecordingState();
		expect(s.active).toBe(false);
		expect(s.pendingIntent).toBe(false);
	});
});

// ─── notifyHotkeyPressed mode-discriminator coverage ─────────────────
//
// Lock in the L30 conditional (`if (mode === "ptt")`) and the L37
// compound `mode === "toggle" && !recordingActive`. With mutants that
// turn either to `if (true)`, the toggle-mode "second press doesn't
// refresh intent" guarantee breaks: a 2nd press while recording would
// re-arm signaledIntent, allowing a stray subsequent recording_start
// to be honoured before notifyRecordingStop fires.
describe("recording-state mode discriminator (PTT vs toggle vs listen)", () => {
	test("toggle mode: 2nd press DOES NOT re-arm signaledIntent while recording is active (locks in L30/L37)", () => {
		setMode("toggle");
		notifyHotkeyPressed();
		expect(consumeRecordingStart()).toBe(true); // recordingActive=true, signaledIntent=false
		expect(debugRecordingState().pendingIntent).toBe(false);

		// Second press — should NOT refresh intent because we're recording.
		notifyHotkeyPressed();
		// pendingIntent must still be false. With the L30 mutant
		// `if (true)` the press would have set signaledIntent=true.
		expect(debugRecordingState().pendingIntent).toBe(false);

		// Without notifyRecordingStop, a stray recording_start MUST be
		// rejected. With the mutant, signaledIntent would be true and
		// consumeRecordingStart would honour it.
		expect(consumeRecordingStart()).toBe(false);
	});

	test("listen mode: notifyHotkeyPressed never sets pendingIntent (locks in L30 branching)", () => {
		setMode("listen");
		notifyHotkeyPressed();
		// In listen mode, hotkey is not involved — pendingIntent stays false.
		// With the L30 mutant `if (true)` (the PTT branch always taken),
		// pendingIntent would become true even in listen mode.
		expect(debugRecordingState().pendingIntent).toBe(false);
	});

	test("PTT mode: pressing while a recording is in flight STILL refreshes intent (PTT has no recordingActive guard)", () => {
		setMode("ptt");
		notifyHotkeyPressed();
		expect(consumeRecordingStart()).toBe(true);
		// recordingActive is now true; a second press in PTT mode SHOULD
		// still refresh signaledIntent (PTT mode has no recordingActive
		// guard, unlike toggle).
		notifyHotkeyPressed();
		expect(debugRecordingState().pendingIntent).toBe(true);
	});
});

// ─── shouldSignalIntent predicate coverage (via notifyHotkeyPressed) ──
//
// After the CRAP refactor, `notifyHotkeyPressed` delegates the
// mode/recording decision to a private `shouldSignalIntent(mode,
// recording)` predicate. The predicate body is:
//
//     mode === "ptt" || (mode === "toggle" && !recording)
//
// This block exhaustively walks every (mode, recordingActive) pair via
// the public surface so coverage stays at 100% AND every short-circuit
// branch in the predicate is hit. Without these, a 1-line uncovered gap
// (e.g. the toggle-mode-WITHOUT-recording branch when only the
// recording-IN-PROGRESS branch is exercised) would pull CRAP back above
// 4 for any future regression that re-raises CC.
describe("shouldSignalIntent predicate (via notifyHotkeyPressed)", () => {
	test("ptt + recording=false: signals intent (LHS of `||` true)", () => {
		setMode("ptt");
		// recordingActive is false from beforeEach reset.
		notifyHotkeyPressed();
		expect(debugRecordingState().pendingIntent).toBe(true);
	});

	test("ptt + recording=true: STILL signals intent (PTT skips the recording guard)", () => {
		setMode("ptt");
		notifyHotkeyPressed();
		// Promote recordingActive to true via consume.
		expect(consumeRecordingStart()).toBe(true);
		expect(debugRecordingState().active).toBe(true);
		// Second press while recording — PTT's `mode === "ptt"` LHS of
		// the `||` short-circuits to true REGARDLESS of recordingActive.
		notifyHotkeyPressed();
		expect(debugRecordingState().pendingIntent).toBe(true);
	});

	test("toggle + recording=false: signals intent (RHS of `||`, both clauses true)", () => {
		setMode("toggle");
		// recordingActive is false from beforeEach reset.
		notifyHotkeyPressed();
		expect(debugRecordingState().pendingIntent).toBe(true);
	});

	test("toggle + recording=true: does NOT signal intent (RHS short-circuits via `!recording`)", () => {
		setMode("toggle");
		notifyHotkeyPressed();
		// Promote recordingActive to true via consume (also clears intent).
		expect(consumeRecordingStart()).toBe(true);
		expect(debugRecordingState().active).toBe(true);
		expect(debugRecordingState().pendingIntent).toBe(false);
		// Second press while recording — toggle's `&& !recording` clause
		// is false, so the whole predicate returns false. Intent stays
		// cleared.
		notifyHotkeyPressed();
		expect(debugRecordingState().pendingIntent).toBe(false);
	});

	test("listen + recording=false: does NOT signal intent (predicate falls through)", () => {
		setMode("listen");
		// recordingActive is false from beforeEach reset.
		notifyHotkeyPressed();
		// Neither LHS (mode==="ptt") nor RHS (mode==="toggle") matches.
		expect(debugRecordingState().pendingIntent).toBe(false);
	});

	test("listen + recording=true: STILL does not signal intent (no PTT/toggle match)", () => {
		setMode("listen");
		// Promote recordingActive to true via a listen-mode consume.
		expect(consumeRecordingStart()).toBe(true);
		expect(debugRecordingState().active).toBe(true);
		notifyHotkeyPressed();
		// Listen mode never sets pendingIntent.
		expect(debugRecordingState().pendingIntent).toBe(false);
	});

	test("notifyHotkeyPressed is a no-op for pendingIntent when predicate is false (locks in early-return shape)", () => {
		// Set up: signaledIntent is false, recordingActive is true,
		// mode is toggle. notifyHotkeyPressed MUST NOT mutate
		// signaledIntent. This guards against a mutant that drops the
		// `if (shouldSignalIntent(...))` guard and unconditionally
		// assigns signaledIntent = true.
		setMode("toggle");
		notifyHotkeyPressed();
		consumeRecordingStart(); // recordingActive=true, signaledIntent=false
		const before = debugRecordingState();
		expect(before.active).toBe(true);
		expect(before.pendingIntent).toBe(false);

		notifyHotkeyPressed();

		const after = debugRecordingState();
		// pendingIntent MUST still be false. active is unchanged.
		expect(after.pendingIntent).toBe(false);
		expect(after.active).toBe(true);
	});
});
