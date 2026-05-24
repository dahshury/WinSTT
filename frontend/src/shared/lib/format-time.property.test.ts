import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { formatTime } from "./format-time";

describe("formatTime property tests", () => {
	test("seconds field is always zero-padded to exactly 2 digits", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 60 * 60 * 24 * 1000 }), (ms) => {
				const out = formatTime(ms);
				const parts = out.split(":");
				const secondsField = parts.at(-1) ?? "";
				return /^\d{2}$/.test(secondsField);
			}),
			{ numRuns: 300 }
		);
	});

	test("minutes field (when not the leading field) is zero-padded to 2 digits", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 100 * 60 * 60 * 1000 }), (ms) => {
				const out = formatTime(ms);
				const parts = out.split(":");
				if (parts.length !== 3) {
					return true; // no hours tier, minutes is the leading field
				}
				const minutesField = parts[1] ?? "";
				return /^\d{2}$/.test(minutesField);
			}),
			{ numRuns: 300 }
		);
	});

	test("sub-second equivalence: formatTime(n*1000) === formatTime(n*1000 + r) for 0<=r<1000", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 60 * 60 * 24 }),
				fc.integer({ min: 0, max: 999 }),
				(n, r) => formatTime(n * 1000) === formatTime(n * 1000 + r)
			),
			{ numRuns: 300 }
		);
	});

	test("monotonic within a fixed-width tier (no hours): larger ms => larger string lex-compare", () => {
		// Stay below the 1-hour threshold so the output width is fixed at M:SS / MM:SS.
		// To make lex compare meaningful, hold the minutes-digit-count constant by
		// staying below 10 minutes (single-digit minutes).
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 9 * 60 * 1000 - 1 }),
				fc.integer({ min: 0, max: 9 * 60 * 1000 - 1 }),
				(a, b) => {
					const secA = Math.floor(a / 1000);
					const secB = Math.floor(b / 1000);
					fc.pre(secA !== secB);
					const cmp = formatTime(a).localeCompare(formatTime(b));
					return secA < secB ? cmp < 0 : cmp > 0;
				}
			),
			{ numRuns: 300 }
		);
	});

	test("output matches one of the two expected shapes (M(M..):SS or H(H..):MM:SS)", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 1000 * 60 * 60 * 100 }), (ms) => {
				const out = formatTime(ms);
				return /^\d+:\d{2}$/.test(out) || /^\d+:\d{2}:\d{2}$/.test(out);
			}),
			{ numRuns: 300 }
		);

		// Spot-check the boundary explicitly.
		expect(formatTime(59 * 60 * 1000 + 59 * 1000)).toMatch(/^\d+:\d{2}$/);
		expect(formatTime(60 * 60 * 1000)).toMatch(/^\d+:\d{2}:\d{2}$/);
	});
});
