import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { computeIslandSize } from "./OverlayPage";

// Property tests for the dynamic-island width state machine. The function
// maps four booleans (isRecordingActive, isSpeaking, isThinking, hasShownText)
// to one of: "empty", "compact", "compactMedium", "long".
//
// Invariants:
//   1. isThinking resolves first — "long" when captioned text is also shown,
//      otherwise "compactMedium" (the compact recording footprint), never
//      "empty"/"compact".
//   2. Monotone escalation: turning ON a flag never *decreases* the size
//      below where it was (with respect to the ordering empty < compact <
//      compactMedium < long).
//   3. Idempotent / deterministic — same input → same output.

type Args = Parameters<typeof computeIslandSize>[0];

const SIZE_RANK: Record<string, number> = {
	empty: 0,
	compact: 1,
	compactMedium: 2,
	long: 3,
};

function rank(size: string): number {
	const r = SIZE_RANK[size];
	if (r === undefined) {
		throw new Error(`unknown size: ${size}`);
	}
	return r;
}

const argsArb: fc.Arbitrary<Args> = fc.record({
	isRecordingActive: fc.boolean(),
	isSpeaking: fc.boolean(),
	isThinking: fc.boolean(),
	hasShownText: fc.boolean(),
});

describe("computeIslandSize properties", () => {
	test("isThinking resolves first: 'long' iff captioned text is shown, else 'compactMedium'", () => {
		fc.assert(
			fc.property(argsArb, (args) => {
				const a = { ...args, isThinking: true };
				expect(computeIslandSize(a)).toBe(
					a.hasShownText ? "long" : "compactMedium",
				);
			}),
			{ numRuns: 300 },
		);
	});

	test("idempotent / deterministic: same input → same output", () => {
		fc.assert(
			fc.property(argsArb, (args) => {
				const a = computeIslandSize({ ...args });
				const b = computeIslandSize({ ...args });
				expect(a).toBe(b);
			}),
			{ numRuns: 300 },
		);
	});

	test("turning isThinking on never decreases the size", () => {
		fc.assert(
			fc.property(argsArb, (args) => {
				const off = computeIslandSize({ ...args, isThinking: false });
				const on = computeIslandSize({ ...args, isThinking: true });
				expect(rank(on)).toBeGreaterThanOrEqual(rank(off));
			}),
			{ numRuns: 300 },
		);
	});

	test("when recording is active and not thinking, size escalates compact → compactMedium → long with flags", () => {
		fc.assert(
			fc.property(fc.boolean(), fc.boolean(), (isSpeaking, hasShownText) => {
				const base = computeIslandSize({
					isRecordingActive: true,
					isSpeaking: false,
					isThinking: false,
					hasShownText: false,
				});
				const withFlags = computeIslandSize({
					isRecordingActive: true,
					isSpeaking,
					isThinking: false,
					hasShownText,
				});
				// Base is always "compact"; flipping on speaking and/or text
				// can only move the size up (or keep it).
				expect(base).toBe("compact");
				expect(rank(withFlags)).toBeGreaterThanOrEqual(rank(base));
			}),
			{ numRuns: 300 },
		);
	});

	test("output is always one of the four allowed presets", () => {
		fc.assert(
			fc.property(argsArb, (args) => {
				const result = computeIslandSize(args);
				expect(["empty", "compact", "compactMedium", "long"]).toContain(result);
			}),
			{ numRuns: 300 },
		);
	});

	test("not recording and not thinking → always 'empty' regardless of other flags", () => {
		fc.assert(
			fc.property(fc.boolean(), fc.boolean(), (isSpeaking, hasShownText) => {
				expect(
					computeIslandSize({
						isRecordingActive: false,
						isSpeaking,
						isThinking: false,
						hasShownText,
					}),
				).toBe("empty");
			}),
			{ numRuns: 200 },
		);
	});
});
