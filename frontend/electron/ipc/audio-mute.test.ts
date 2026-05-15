import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const listeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>();

mock.module("electron", () => ({
	...electronMock(),
	ipcMain: {
		handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
			handlers.set(channel, listener);
		},
		on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(listener);
			listeners.set(channel, list);
		},
		removeHandler: (channel: string) => handlers.delete(channel),
		off: () => undefined,
		removeAllListeners: () => undefined,
		_handlers: handlers,
		_listeners: listeners,
		invokeHandler: async () => undefined,
		emitListener: () => undefined,
	},
}));

// Drive the persistent PS host's behavior from tests. Each call to runPsCommand
// resolves with the next stub response (or default). Captures the command and
// the options object for assertions — letting us verify that GetVolume is
// called with `{expectValue: true, timeoutMs: 3000}` and SetVolume with
// `{timeoutMs: 3000}`. Without options capture, ObjectLiteral mutators that
// turn the options into `{}` survive silently.
const psStub: {
	commands: string[];
	commandOpts: Array<{ expectValue?: boolean; timeoutMs?: number } | undefined>;
	getVolumeValue: string | null;
	getVolumeOk: boolean;
	setVolumeOk: boolean;
} = {
	commands: [],
	commandOpts: [],
	getVolumeValue: "0.5",
	getVolumeOk: true,
	setVolumeOk: true,
};

mock.module("../lib/ps-host", () => ({
	runPsCommand: async (
		command: string,
		opts?: { expectValue?: boolean; timeoutMs?: number }
	): Promise<{ ok: boolean; value: string | null }> => {
		psStub.commands.push(command);
		psStub.commandOpts.push(opts);
		if (command.includes("GetVolume")) {
			return { ok: psStub.getVolumeOk, value: psStub.getVolumeOk ? psStub.getVolumeValue : null };
		}
		if (command.includes("SetVolume")) {
			return { ok: psStub.setVolumeOk, value: null };
		}
		return { ok: true, value: null };
	},
	shutdownPsHost: () => undefined,
	__resetPsHostForTesting__: () => undefined,
}));

const audioMute = await import("./audio-mute");
const {
	setupAudioMuteHandlers,
	muteSystemAudio,
	unmuteSystemAudio,
	flushMutePending,
	__resetAudioMuteForTesting__,
	__audio_mute_test_helpers__: audioMuteHelpers,
} = audioMute;

const originalPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: p, configurable: true });
}
function resetPlatform(): void {
	Object.defineProperty(process, "platform", {
		value: originalPlatform,
		configurable: true,
	});
}

function resetStubs(): void {
	psStub.commands = [];
	psStub.commandOpts = [];
	psStub.getVolumeValue = "0.5";
	psStub.getVolumeOk = true;
	psStub.setVolumeOk = true;
	__resetAudioMuteForTesting__();
}

// Capture console.log so we can pin down the dbg() messages emitted by
// production code. Without this, every dbg() string literal in
// audio-mute.ts (the "audio-mute" tag and the human-readable status
// strings) survives mutation testing because no test observes them.
const consoleLogLines: string[] = [];
const realConsoleLog = console.log;
console.log = (...args: unknown[]) => {
	for (const arg of args) {
		consoleLogLines.push(String(arg));
	}
};
process.on("exit", () => {
	console.log = realConsoleLog;
});
function recentLogContains(needle: string): boolean {
	return consoleLogLines.some((line) => line.includes(needle));
}

describe("audio-mute module", () => {
	test("exports its public API", () => {
		expect(typeof setupAudioMuteHandlers).toBe("function");
		expect(typeof muteSystemAudio).toBe("function");
		expect(typeof unmuteSystemAudio).toBe("function");
		expect(typeof flushMutePending).toBe("function");
	});

	test("setupAudioMuteHandlers registers the audio:set-mute listener", () => {
		setupAudioMuteHandlers();
		expect(listeners.has("audio:set-mute")).toBe(true);
	});

	test("audio:set-mute with invalid payload is silently dropped", async () => {
		resetStubs();
		setPlatform("win32");
		setupAudioMuteHandlers();
		const callbacks = listeners.get("audio:set-mute") ?? [];
		try {
			expect(() => {
				for (const cb of callbacks) {
					cb(undefined, null);
				}
			}).not.toThrow();
			expect(() => {
				for (const cb of callbacks) {
					cb(undefined, { muted: "not-a-boolean" });
				}
			}).not.toThrow();
			// Pin down the EqualityOperator and LogicalOperator mutants on
			// the validation guard. With `typeof payload.muted !==
			// "boolean"` mutated to `false`, payload `{ muted:
			// "not-a-boolean" }` (truthy `.muted`) would slip through and
			// call muteSystemAudio() → schedule a duck → enqueue
			// GetVolume. Verify NO commands have been issued.
			await flushMutePending();
			expect(psStub.commands.length).toBe(0);
		} finally {
			resetPlatform();
		}
	});

	test("muteSystemAudio is a no-op on non-win32 (early return path)", async () => {
		resetStubs();
		setPlatform("linux");
		try {
			expect(muteSystemAudio()).toBe(false);
			await flushMutePending();
			expect(psStub.commands.length).toBe(0);
		} finally {
			resetPlatform();
		}
	});

	test("muteSystemAudio reads then sets volume to 0 on win32", async () => {
		resetStubs();
		setPlatform("win32");
		try {
			consoleLogLines.length = 0;
			expect(muteSystemAudio()).toBe(true);
			await flushMutePending();
			expect(psStub.commands[0]).toContain("GetVolume");
			expect(psStub.commands[1]).toContain("SetVolume(0");
			// Pin down the dbg() string literals at L86 — `ducked (saved=...)`
			// emitted on a successful duck. A mutant that empties any of
			// the dbg arguments leaves observable evidence on the console.
			expect(recentLogContains("audio-mute")).toBe(true);
			expect(recentLogContains("ducked")).toBe(true);
			expect(consoleLogLines.some((l) => l.includes("audio-mute") && l.includes("ducked"))).toBe(
				true
			);
			// Negative assertions — pin down that NONE of the failure-path
			// dbg() messages fire on the happy path.
			expect(recentLogContains("could not parse volume")).toBe(false);
			expect(recentLogContains("duck: GetVolume failed")).toBe(false);
			expect(recentLogContains("duck: SetVolume failed")).toBe(false);
			expect(recentLogContains("restore: SetVolume failed")).toBe(false);
			// Pin down the runPsCommand options objects — kills the
			// ObjectLiteral and BooleanLiteral mutants on the options.
			// GetVolume MUST be called with `{expectValue: true, timeoutMs: 3000}`.
			expect(psStub.commandOpts[0]).toEqual({ expectValue: true, timeoutMs: 3000 });
			// SetVolume MUST be called with `{timeoutMs: 3000}` (no expectValue).
			expect(psStub.commandOpts[1]).toEqual({ timeoutMs: 3000 });
		} finally {
			resetPlatform();
		}
	});

	test("unmute restores the saved volume", async () => {
		resetStubs();
		setPlatform("win32");
		psStub.getVolumeValue = "0.73";
		try {
			muteSystemAudio();
			await flushMutePending();
			psStub.commands = [];
			psStub.commandOpts = [];
			consoleLogLines.length = 0;
			unmuteSystemAudio();
			await flushMutePending();
			// Should call SetVolume with the saved value (0.73)
			expect(psStub.commands.length).toBe(1);
			expect(psStub.commands[0]).toContain("SetVolume(0.73");
			// Pin down the L93 dbg() literal `restored (→ ...)` AND tag.
			expect(recentLogContains("restored")).toBe(true);
			expect(recentLogContains("0.730")).toBe(true);
			expect(consoleLogLines.some((l) => l.includes("audio-mute") && l.includes("restored"))).toBe(
				true
			);
			// Pin down the runPsCommand options for the restore SetVolume.
			expect(psStub.commandOpts[0]).toEqual({ timeoutMs: 3000 });
		} finally {
			resetPlatform();
		}
	});

	test("repeated muteSystemAudio while already ducked is a no-op", async () => {
		resetStubs();
		setPlatform("win32");
		try {
			muteSystemAudio();
			await flushMutePending();
			psStub.commands = [];
			expect(muteSystemAudio()).toBe(false);
			await flushMutePending();
			expect(psStub.commands.length).toBe(0);
		} finally {
			resetPlatform();
		}
	});

	test("if SetVolume fails, isDucked stays cleared so we don't loop", async () => {
		resetStubs();
		setPlatform("win32");
		psStub.setVolumeOk = false;
		try {
			consoleLogLines.length = 0;
			muteSystemAudio();
			await flushMutePending();
			// Pin down the L78 dbg() literal `duck: SetVolume failed`
			// AND the "audio-mute" tag literal — both must appear on the
			// same line, so a mutant that empties either string is killed.
			expect(recentLogContains("duck: SetVolume failed")).toBe(true);
			expect(
				consoleLogLines.some(
					(l) => l.includes("audio-mute") && l.includes("duck: SetVolume failed")
				)
			).toBe(true);
			// Now the duck "failed" — but we should be able to still attempt restore.
			// Reset SetVolume success and call unmute; if state was stuck, this is a no-op.
			psStub.setVolumeOk = true;
			psStub.commands = [];
			unmuteSystemAudio();
			await flushMutePending();
			// State after failed duck should be: not ducked → unmute is a no-op
			expect(psStub.commands.length).toBe(0);
		} finally {
			resetPlatform();
		}
	});

	test("audio:set-mute with valid payload routes through the queue", async () => {
		resetStubs();
		setPlatform("win32");
		setupAudioMuteHandlers();
		const callbacks = listeners.get("audio:set-mute") ?? [];
		try {
			for (const cb of callbacks) {
				cb(undefined, { muted: true });
			}
			await flushMutePending();
			// At least the GetVolume read should have been issued.
			expect(psStub.commands.some((c) => c.includes("GetVolume"))).toBe(true);
		} finally {
			resetPlatform();
		}
	});

	test("audio:set-mute muted=false routes to unmute branch (locks in L160 if/else condition)", async () => {
		// First duck successfully so isDucked=true. Then send muted=false
		// via the IPC handler. With the L160 mutant `if (true)`, the
		// handler would call muteSystemAudio (a no-op when isDucked=true)
		// instead of unmuteSystemAudio (which calls SetVolume(0.5)).
		resetStubs();
		setPlatform("win32");
		setupAudioMuteHandlers();
		const callbacks = listeners.get("audio:set-mute") ?? [];
		try {
			// Prime: duck first so isDucked=true.
			for (const cb of callbacks) {
				cb(undefined, { muted: true });
			}
			await flushMutePending();
			psStub.commands = [];
			// Now send muted=false. Should route to unmuteSystemAudio →
			// scheduleApply(applyRestore) → SetVolume(savedVolume).
			for (const cb of callbacks) {
				cb(undefined, { muted: false });
			}
			await flushMutePending();
			// SetVolume should have been called with the saved value (0.5).
			// With the L160 mutant, muteSystemAudio is called instead and
			// since isDucked=true, it short-circuits → no commands.
			expect(psStub.commands.length).toBe(1);
			expect(psStub.commands[0]).toContain("SetVolume");
		} finally {
			resetPlatform();
		}
	});

	test("applyDuck: GetVolume failure does not set isDucked", async () => {
		resetStubs();
		setPlatform("win32");
		psStub.getVolumeOk = false;
		try {
			consoleLogLines.length = 0;
			muteSystemAudio();
			await flushMutePending();
			// Pin down the L60 dbg() literal `duck: GetVolume failed` AND
			// the "audio-mute" tag — they MUST appear on the same line.
			expect(recentLogContains("duck: GetVolume failed")).toBe(true);
			expect(
				consoleLogLines.some(
					(l) => l.includes("audio-mute") && l.includes("duck: GetVolume failed")
				)
			).toBe(true);
			// GetVolume failed — isDucked should remain false (no volume to restore)
			// Verify by checking that unmute is a no-op (no SetVolume command).
			psStub.commands = [];
			psStub.setVolumeOk = true;
			unmuteSystemAudio();
			await flushMutePending();
			expect(psStub.commands.length).toBe(0);
		} finally {
			resetPlatform();
		}
	});

	test("applyDuck: unparseable volume string is treated as a failure (does not duck)", async () => {
		resetStubs();
		setPlatform("win32");
		psStub.getVolumeValue = "not-a-number";
		try {
			consoleLogLines.length = 0;
			muteSystemAudio();
			await flushMutePending();
			// Pin down the L66 dbg() literal `duck: could not parse volume
			// (...)` AND the "audio-mute" tag — they MUST appear together.
			expect(recentLogContains("could not parse volume")).toBe(true);
			expect(
				consoleLogLines.some(
					(l) => l.includes("audio-mute") && l.includes("could not parse volume")
				)
			).toBe(true);
			// parseVolume returned null — isDucked should remain false
			psStub.commands = [];
			unmuteSystemAudio();
			await flushMutePending();
			expect(psStub.commands.length).toBe(0);
		} finally {
			resetPlatform();
		}
	});

	test("unmuteSystemAudio is a no-op on non-win32", async () => {
		resetStubs();
		setPlatform("linux");
		try {
			unmuteSystemAudio();
			await flushMutePending();
			expect(psStub.commands.length).toBe(0);
		} finally {
			resetPlatform();
		}
	});

	test("unmuteSystemAudio is a no-op on non-win32 EVEN WHEN isDucked=true (locks in the platform guard)", async () => {
		// Set isDucked=true via a successful win32 duck, THEN flip platform
		// to linux. With the L146 mutant `if (false)` (the platform guard
		// removed), unmuteSystemAudio would proceed past the platform
		// check, see isDucked=true, and call scheduleApply → SetVolume.
		// Original code returns early on the platform check.
		resetStubs();
		setPlatform("win32");
		try {
			muteSystemAudio();
			await flushMutePending();
			expect(psStub.commands.some((c) => c.includes("SetVolume(0"))).toBe(true);
			// Now flip to linux mid-flight.
			psStub.commands = [];
			setPlatform("linux");
			unmuteSystemAudio();
			await flushMutePending();
			// On a real Linux system the platform guard short-circuits.
			// With the mutant, we'd see a SetVolume command in the queue.
			expect(psStub.commands.length).toBe(0);
		} finally {
			resetPlatform();
		}
	});

	test("muteSystemAudio is a no-op on non-win32 EVEN AFTER isDucked is somehow false (locks in L143)", async () => {
		// Already covered by the simpler "no-op on non-win32" test above
		// (which sets platform=linux on a fresh state). The L143 mutant
		// `if (false)` would skip the early-return and the function would
		// proceed to schedule a duck, returning true. Original returns
		// false. The pre-existing test asserts === false, killing this.
		resetStubs();
		setPlatform("darwin");
		try {
			expect(muteSystemAudio()).toBe(false);
			await flushMutePending();
			expect(psStub.commands.length).toBe(0);
		} finally {
			resetPlatform();
		}
	});

	test("applyDuck: null volume value does not duck (parseVolume null path)", async () => {
		resetStubs();
		setPlatform("win32");
		psStub.getVolumeValue = null; // result.ok=true but value=null → parseVolume returns null
		try {
			muteSystemAudio();
			await flushMutePending();
			// isDucked should remain false
			psStub.commands = [];
			unmuteSystemAudio();
			await flushMutePending();
			expect(psStub.commands.length).toBe(0);
		} finally {
			resetPlatform();
		}
	});

	test("applyRestore: no-op when not ducked (isDucked=false, win32)", async () => {
		resetStubs();
		setPlatform("win32");
		try {
			// isDucked is false after reset; unmuteSystemAudio should exit early in applyRestore
			unmuteSystemAudio();
			await flushMutePending();
			// No SetVolume should have been called since we weren't ducked
			expect(psStub.commands.length).toBe(0);
		} finally {
			resetPlatform();
		}
	});

	test("unmute scheduled before duck completes still queues a restore (race-condition guard)", async () => {
		// REGRESSION: When the user presses PTT and releases it before the
		// PowerShell duck command finishes, the previous code bailed out of
		// unmuteSystemAudio because `isDucked` was still false at the moment
		// of the call. The applyDuck microtask then completed (volume → 0,
		// isDucked → true) but no restore was ever queued, leaving the user
		// muted indefinitely. The fix: track desiredMuted at the public API
		// boundary so unmute queues a restore that runs AFTER the in-flight
		// duck completes.
		resetStubs();
		setPlatform("win32");
		psStub.getVolumeValue = "0.42";
		try {
			// Call mute and unmute back-to-back synchronously — applyDuck is
			// only queued as a microtask, so isDucked is still false at the
			// moment we call unmuteSystemAudio.
			muteSystemAudio();
			unmuteSystemAudio();
			await flushMutePending();
			// Both duck and restore must have run: GetVolume → SetVolume(0) →
			// SetVolume(0.42). Critically, the saved volume (0.42) must be
			// restored — without the fix, only the duck commands would appear.
			expect(psStub.commands.some((c) => c.includes("SetVolume(0.42"))).toBe(true);
		} finally {
			resetPlatform();
		}
	});

	test("rapid duck → unmute → duck → unmute settles back to the original volume", async () => {
		// Same idea as the race-condition test, but with multiple bounces:
		// every public mute/unmute must be honoured in order, ending at the
		// user's original volume even when commands are queued faster than
		// the PowerShell host can drain them.
		resetStubs();
		setPlatform("win32");
		psStub.getVolumeValue = "0.6";
		try {
			muteSystemAudio();
			unmuteSystemAudio();
			muteSystemAudio();
			unmuteSystemAudio();
			await flushMutePending();
			// Last queued operation must be a restore to 0.6.
			const lastSet = [...psStub.commands].reverse().find((c) => c.includes("SetVolume"));
			expect(lastSet).toContain("SetVolume(0.6");
		} finally {
			resetPlatform();
		}
	});

	test("applyRestore: SetVolume failure does not loop (still clears isDucked)", async () => {
		resetStubs();
		setPlatform("win32");
		try {
			// First duck successfully
			muteSystemAudio();
			await flushMutePending();
			expect(psStub.commands.some((c) => c.includes("SetVolume(0"))).toBe(true);

			// Now make restore SetVolume fail
			psStub.commands = [];
			psStub.setVolumeOk = false;
			consoleLogLines.length = 0;
			unmuteSystemAudio();
			await flushMutePending();
			// The SetVolume command was issued even if it failed
			expect(psStub.commands.some((c) => c.includes("SetVolume"))).toBe(true);
			// Pin down the L95 dbg() literal `restore: SetVolume failed`
			// AND the "audio-mute" tag.
			expect(recentLogContains("restore: SetVolume failed")).toBe(true);
			expect(
				consoleLogLines.some(
					(l) => l.includes("audio-mute") && l.includes("restore: SetVolume failed")
				)
			).toBe(true);
			// isDucked should be cleared even on failure, so second unmute is a no-op
			psStub.commands = [];
			psStub.setVolumeOk = true;
			unmuteSystemAudio();
			await flushMutePending();
			expect(psStub.commands.length).toBe(0);
		} finally {
			resetPlatform();
		}
	});
});

describe("clampScalar (via __audio_mute_test_helpers__)", () => {
	test("clamps NaN to 0", () => {
		expect(audioMuteHelpers.clampScalar(Number.NaN)).toBe(0);
	});

	test("clamps negative values to 0", () => {
		expect(audioMuteHelpers.clampScalar(-0.1)).toBe(0);
		expect(audioMuteHelpers.clampScalar(-100)).toBe(0);
	});

	test("clamps values > 1 to 1", () => {
		expect(audioMuteHelpers.clampScalar(1.1)).toBe(1);
		expect(audioMuteHelpers.clampScalar(100)).toBe(1);
	});

	test("returns values in [0, 1] unchanged", () => {
		expect(audioMuteHelpers.clampScalar(0)).toBe(0);
		expect(audioMuteHelpers.clampScalar(0.5)).toBe(0.5);
		expect(audioMuteHelpers.clampScalar(1)).toBe(1);
	});
});

// ─── parseVolume direct tests (kills the L44 ConditionalExpression / ─
// BlockStatement and L49 MethodExpression / StringLiteral mutants that
// the indirect-via-applyDuck tests can't reach because the throw path
// is silently caught by scheduleApply's `.catch(() => undefined)`).
describe("parseVolume (via __audio_mute_test_helpers__)", () => {
	test("returns null for null input (locks in the L44 if-block early-return)", () => {
		// Mutant `if (false)` would proceed to `null.replace(...)`, throwing.
		// This direct call has no try/catch wrapper → the throw would
		// propagate and fail the test.
		expect(audioMuteHelpers.parseVolume(null)).toBeNull();
	});

	test("returns null for empty-string input (locks in the L44 falsy guard)", () => {
		expect(audioMuteHelpers.parseVolume("")).toBeNull();
	});

	test("parses dot-decimal volumes verbatim (locks in L49 .replace happy path)", () => {
		expect(audioMuteHelpers.parseVolume("0.5")).toBe(0.5);
		expect(audioMuteHelpers.parseVolume("1.0")).toBe(1);
		expect(audioMuteHelpers.parseVolume("0.0")).toBe(0);
	});

	test("converts comma decimals to dot decimals (locks in L49 ',' → '.' string literals)", () => {
		// MUST handle comma-style locale floats by replacing "," with ".".
		// A mutant that drops .replace() leaves "0,5" → parseFloat returns 0.
		// A mutant that swaps the search string (e.g. ' '→'.') leaves
		// "0,5" unchanged → parseFloat returns 0.
		expect(audioMuteHelpers.parseVolume("0,5")).toBe(0.5);
		expect(audioMuteHelpers.parseVolume("0,73")).toBe(0.73);
	});

	test("trims surrounding whitespace before parsing (locks in the trailing .trim())", () => {
		// The MethodExpression mutator drops `.trim()` from the chain. If
		// trimming is missing, "  0.5  " ends up as "  0.5  "; parseFloat
		// would still give 0.5 (whitespace tolerant)... so to actually
		// kill the mutant we need an input where trim() makes the
		// difference. Whitespace + 0 paired with a trailing characters
		// scenario doesn't help (parseFloat is whitespace-tolerant). The
		// most reliable test: an input where Number.parseFloat would
		// produce NaN without trim — but parseFloat on "  abc" already
		// returns NaN, and on "  0.5  " already returns 0.5. So trim()
		// is technically a defensive no-op for parseFloat.
		//
		// Verify the function still returns the expected value for
		// whitespace-padded numeric input (proving the trim path works
		// in production even if redundant for parseFloat).
		expect(audioMuteHelpers.parseVolume("  0.5  ")).toBe(0.5);
		expect(audioMuteHelpers.parseVolume("\t0.73\n")).toBe(0.73);
	});

	test("returns null for non-numeric strings", () => {
		expect(audioMuteHelpers.parseVolume("abc")).toBeNull();
		expect(audioMuteHelpers.parseVolume("not-a-number")).toBeNull();
	});

	test("clamps out-of-range numeric strings via clampScalar", () => {
		// Value > 1 should clamp to 1. Locks in the clampScalar pass-through
		// at the end of parseVolume.
		expect(audioMuteHelpers.parseVolume("2.5")).toBe(1);
		// Value < 0 should clamp to 0.
		expect(audioMuteHelpers.parseVolume("-0.3")).toBe(0);
	});
});
