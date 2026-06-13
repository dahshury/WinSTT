import { describe, expect, test } from "bun:test";
import type { TranscriptionHistoryEntry } from "../model/history-store";
import { computeStreak } from "./streak";

function entryOn(
	year: number,
	month: number,
	day: number,
): TranscriptionHistoryEntry {
	// month is 1-based here for readability; Date wants 0-based.
	return {
		id: `${year}-${month}-${day}`,
		timestamp: new Date(year, month - 1, day, 12, 0, 0).getTime(),
		text: "hello",
		wordCount: 1,
		durationMs: 1000,
	};
}

const NOW = new Date(2026, 5, 13, 9, 0, 0).getTime(); // 2026-06-13 (a Saturday)

describe("computeStreak", () => {
	test("empty history has no streak", () => {
		expect(computeStreak([], NOW)).toEqual({ current: 0, longest: 0 });
	});

	test("a single transcription today is a one-day streak", () => {
		expect(computeStreak([entryOn(2026, 6, 13)], NOW)).toEqual({
			current: 1,
			longest: 1,
		});
	});

	test("consecutive days ending today count toward the current streak", () => {
		const entries = [
			entryOn(2026, 6, 11),
			entryOn(2026, 6, 12),
			entryOn(2026, 6, 13),
		];
		expect(computeStreak(entries, NOW)).toEqual({ current: 3, longest: 3 });
	});

	test("multiple entries on the same day count once", () => {
		const entries = [entryOn(2026, 6, 13), entryOn(2026, 6, 13)];
		expect(computeStreak(entries, NOW)).toEqual({ current: 1, longest: 1 });
	});

	test("current streak is 0 when today has no activity, even if yesterday did", () => {
		const entries = [
			entryOn(2026, 6, 10),
			entryOn(2026, 6, 11),
			entryOn(2026, 6, 12),
		];
		expect(computeStreak(entries, NOW)).toEqual({ current: 0, longest: 3 });
	});

	test("longest run is found across gaps and ignores the current run length", () => {
		const entries = [
			// A 4-day run in the past.
			entryOn(2026, 5, 1),
			entryOn(2026, 5, 2),
			entryOn(2026, 5, 3),
			entryOn(2026, 5, 4),
			// A 2-day current run ending today.
			entryOn(2026, 6, 12),
			entryOn(2026, 6, 13),
		];
		expect(computeStreak(entries, NOW)).toEqual({ current: 2, longest: 4 });
	});

	test("runs that span a month boundary stay consecutive", () => {
		const entries = [
			entryOn(2026, 4, 29),
			entryOn(2026, 4, 30),
			entryOn(2026, 5, 1),
			entryOn(2026, 5, 2),
		];
		expect(computeStreak(entries, NOW)).toEqual({ current: 0, longest: 4 });
	});
});
