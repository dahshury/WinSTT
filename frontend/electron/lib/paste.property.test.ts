/**
 * Property tests for the pure decision helpers in paste.ts.
 *
 * Targets the helpers that the bigger `tryClipboardThenTyping` (CRAP 12) relies
 * on. The full path is example-tested in paste.test.ts; this file pins down
 * invariants on the pure helpers — these survive mutation testing on the
 * fallback-reason / cooldown / pacing logic without spinning up the spawn
 * harness.
 *
 *   - formatCombinedFailureReason: total, deterministic, clip:_;type:_ shape.
 *   - isSlowPaste: monotone in both args; boundary at 250ms / 300ms.
 *   - computePaceWait: bounded by [0, 250]; monotone non-increasing in `now`.
 *   - coerceClipboardText: total, returns a string for every input.
 *   - decideSpawnTarget: null when in cooldown; same binPath when out of it.
 *
 * Spawn / electron / fs are mocked the same way as paste.test.ts so the
 * module imports cleanly into the bun:test process.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fc from "fast-check";
import { electronMock } from "../../test/mocks/electron";

mock.module("../ipc/hotkey", () => ({
	setPasteGuard: () => undefined,
}));

let lastClipboard = "";
const emptyImage = { isEmpty: () => true } as unknown as Electron.NativeImage;
mock.module("electron", () => {
	const base = electronMock();
	base.clipboard = {
		writeText: (text: string) => {
			lastClipboard = text;
		},
		readText: () => lastClipboard,
		clear: () => {
			lastClipboard = "";
		},
		readHTML: () => "",
		readRTF: () => "",
		readImage: () => emptyImage,
		write: (payload: { text?: string }) => {
			if (typeof payload.text === "string") {
				lastClipboard = payload.text;
			}
		},
	} as unknown as Electron.Clipboard;
	(base.app as unknown as { isPackaged: boolean }).isPackaged = false;
	return base;
});

import * as realFs from "node:fs";

mock.module("node:fs", () => ({
	...realFs,
	existsSync: () => true,
}));

// Use the existing paste.test.ts spawn stub idea, but spawn itself stays a
// no-op for this file — the helpers under test don't go through spawn.
mock.module("node:child_process", () => ({
	spawn: () => ({
		stdout: { on: () => undefined },
		stderr: { on: () => undefined },
		stdin: null,
		on: () => undefined,
		kill: () => undefined,
	}),
}));

const {
	formatCombinedFailureReason,
	isSlowPaste,
	computePaceWait,
	coerceClipboardText,
	decideSpawnTarget,
	__setCooldownUntilForTesting__,
	__getCooldownUntilForTesting__,
	__resetPasteForTesting__,
} = await import("./paste");

beforeEach(() => {
	__resetPasteForTesting__();
});

afterAll(() => {
	__resetPasteForTesting__();
});

// formatCombinedFailureReason -----------------------------------------------

describe("formatCombinedFailureReason (property)", () => {
	test("output always starts with 'clip:' and contains ';type:'", () => {
		fc.assert(
			fc.property(
				fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
				fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
				(clipReason, typeReason) => {
					const out = formatCombinedFailureReason(clipReason, typeReason);
					return out.startsWith("clip:") && out.includes(";type:");
				}
			),
			{ numRuns: 300 }
		);
	});

	test("substitutes 'unknown' for any undefined argument", () => {
		fc.assert(
			fc.property(
				fc.option(fc.string({ maxLength: 50 }), { nil: undefined }),
				fc.option(fc.string({ maxLength: 50 }), { nil: undefined }),
				(clipReason, typeReason) => {
					const out = formatCombinedFailureReason(clipReason, typeReason);
					const c = clipReason ?? "unknown";
					const t = typeReason ?? "unknown";
					return out === `clip:${c};type:${t}`;
				}
			),
			{ numRuns: 300 }
		);
	});

	test("deterministic: same inputs → same output across N calls", () => {
		// Snapshot first call so a fold-friendly self-compare doesn't tempt
		// an optimiser to elide the second invocation.
		fc.assert(
			fc.property(
				fc.option(fc.string({ maxLength: 50 }), { nil: undefined }),
				fc.option(fc.string({ maxLength: 50 }), { nil: undefined }),
				fc.integer({ min: 2, max: 5 }),
				(c, t, n) => {
					const first = formatCombinedFailureReason(c, t);
					for (let i = 0; i < n; i++) {
						if (formatCombinedFailureReason(c, t) !== first) {
							return false;
						}
					}
					return true;
				}
			),
			{ numRuns: 100 }
		);
	});
});

// isSlowPaste ---------------------------------------------------------------

describe("isSlowPaste (property)", () => {
	test("returns boolean for every (waitedMs, elapsed) pair", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 5000 }),
				fc.integer({ min: 0, max: 5000 }),
				(w, e) => typeof isSlowPaste(w, e) === "boolean"
			),
			{ numRuns: 300 }
		);
	});

	test("monotone in waitedMs: increasing waitedMs cannot flip true → false", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1000 }),
				fc.integer({ min: 0, max: 1000 }),
				fc.integer({ min: 0, max: 1000 }),
				(w1, deltaPos, e) => {
					const w2 = w1 + deltaPos;
					if (isSlowPaste(w1, e)) {
						return isSlowPaste(w2, e) === true;
					}
					return true; // can't fail the implication
				}
			),
			{ numRuns: 300 }
		);
	});

	test("monotone in elapsed: same direction", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1000 }),
				fc.integer({ min: 0, max: 1000 }),
				fc.integer({ min: 0, max: 1000 }),
				(w, e1, deltaPos) => {
					const e2 = e1 + deltaPos;
					if (isSlowPaste(w, e1)) {
						return isSlowPaste(w, e2) === true;
					}
					return true;
				}
			),
			{ numRuns: 300 }
		);
	});

	test("threshold sanity: (250, 300) → false; (251, 0) → true; (0, 301) → true", () => {
		expect(isSlowPaste(250, 300)).toBe(false);
		expect(isSlowPaste(251, 0)).toBe(true);
		expect(isSlowPaste(0, 301)).toBe(true);
	});
});

// computePaceWait -----------------------------------------------------------

describe("computePaceWait (property)", () => {
	test("output is always non-negative", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1_000_000_000 }),
				fc.integer({ min: 0, max: 1_000_000_000 }),
				(now, lastFinishedAt) => computePaceWait(now, lastFinishedAt) >= 0
			),
			{ numRuns: 300 }
		);
	});

	test("for now ≥ lastFinishedAt, wait ≤ 350ms (PASTE_MIN_GAP_MS)", () => {
		// FINDING: when `lastFinishedAt > now` (e.g. monotonic clock skew),
		// the function returns sinceLast-shifted values > 350. In production
		// `lastSpawnFinishedAt` is always assigned `Date.now()` so this
		// branch isn't reachable, but the source has no clamp — a switch to
		// `performance.now()` mid-process could regress this. Pin the
		// realistic precondition explicitly.
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 100_000 }),
				fc.integer({ min: 0, max: 100_000 }),
				(last, delta) => {
					const now = last + delta;
					return computePaceWait(now, last) <= 350;
				}
			),
			{ numRuns: 300 }
		);
	});

	test("monotone non-increasing in `now`: more elapsed → less (or equal) wait", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 100_000 }),
				fc.integer({ min: 0, max: 100_000 }),
				fc.integer({ min: 0, max: 1000 }),
				(lastFinishedAt, delta, extra) => {
					const now1 = lastFinishedAt + delta;
					const now2 = now1 + extra;
					return computePaceWait(now2, lastFinishedAt) <= computePaceWait(now1, lastFinishedAt);
				}
			),
			{ numRuns: 300 }
		);
	});

	test("wait is 0 when at least 350ms have elapsed since last finish", () => {
		// PASTE_MIN_GAP_MS = 350; once that many ms have passed since the last
		// spawn finished, no further pacing is required.
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 100_000 }),
				fc.integer({ min: 350, max: 5000 }),
				(last, delta) => computePaceWait(last + delta, last) === 0
			),
			{ numRuns: 200 }
		);
	});
});

// coerceClipboardText -------------------------------------------------------

describe("coerceClipboardText (property)", () => {
	test("returns a string for null, undefined, or any string input", () => {
		fc.assert(
			fc.property(
				fc.oneof(fc.string({ maxLength: 500 }), fc.constant(null), fc.constant(undefined)),
				(value) => typeof coerceClipboardText(value) === "string"
			),
			{ numRuns: 300 }
		);
	});

	test("identity on actual strings", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 500 }), (s) => coerceClipboardText(s) === s),
			{ numRuns: 200 }
		);
	});

	test("null / undefined collapse to the same fallback", () => {
		expect(coerceClipboardText(null)).toBe(coerceClipboardText(undefined));
	});
});

// decideSpawnTarget ---------------------------------------------------------

describe("decideSpawnTarget (property)", () => {
	test("returns null whenever cooldown is in the future", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 60_000 }), (delta) => {
				const now = Date.now();
				__setCooldownUntilForTesting__(now + delta);
				const result = decideSpawnTarget(now);
				__setCooldownUntilForTesting__(0);
				return result === null;
			}),
			{ numRuns: 100 }
		);
	});

	test("returns the same value (binPath or null) when cooldown has elapsed", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 5 }), () => {
				__setCooldownUntilForTesting__(0);
				const r1 = decideSpawnTarget(Date.now());
				const r2 = decideSpawnTarget(Date.now());
				return r1 === r2;
			}),
			{ numRuns: 50 }
		);
	});

	test("cooldown gate is monotone: once cooldown passes, never re-blocks for `now ≥ cooldownUntil`", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 100_000 }),
				fc.integer({ min: 1, max: 1000 }),
				(cooldown, delta) => {
					__setCooldownUntilForTesting__(cooldown);
					const blocked = decideSpawnTarget(cooldown - 1);
					const unblocked = decideSpawnTarget(cooldown + delta);
					__setCooldownUntilForTesting__(0);
					// `blocked` is null iff cooldown > now; `unblocked` MUST not be
					// null due to cooldown (it can still be null if binary is
					// missing, but we mocked existsSync=true above).
					if (cooldown > 0 && cooldown - 1 < cooldown) {
						return blocked === null && unblocked !== null;
					}
					return true;
				}
			),
			{ numRuns: 100 }
		);
	});
});

// cooldown setter / getter round-trip --------------------------------------

describe("cooldown getter/setter property", () => {
	test("set → get round-trips", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 10_000_000 }), (epoch) => {
				__setCooldownUntilForTesting__(epoch);
				const result = __getCooldownUntilForTesting__() === epoch;
				__setCooldownUntilForTesting__(0);
				return result;
			}),
			{ numRuns: 100 }
		);
	});
});
