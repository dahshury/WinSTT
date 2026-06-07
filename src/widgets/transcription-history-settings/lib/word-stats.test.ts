import { describe, expect, test } from "bun:test";
import type { TranscriptionHistoryEntry } from "../model/history-store";
import {
	aggregate,
	buildHeatmap,
	dayRangeBounds,
	filterEntriesByDateRange,
	formatDuration,
	formatWpm,
	intensityLevel,
	isEmptyIntensity,
	lookupIntensity,
	startOfLocalDay,
	sumWordsByDay,
	toDayKey,
	wordsCorrectedBetween,
	wordsPerMinute,
} from "./word-stats";

function makeEntry(
	partial: Partial<TranscriptionHistoryEntry>,
): TranscriptionHistoryEntry {
	return {
		id: partial.id ?? "id",
		timestamp: partial.timestamp ?? 0,
		text: partial.text ?? "",
		wordCount: partial.wordCount ?? 0,
		durationMs: partial.durationMs ?? 0,
		...(partial.originalText === undefined
			? {}
			: { originalText: partial.originalText }),
		...(partial.dictionaryFixes === undefined
			? {}
			: { dictionaryFixes: partial.dictionaryFixes }),
	};
}

describe("wordsPerMinute", () => {
	test("computes words * 60000 / durationMs", () => {
		expect(wordsPerMinute(100, 60_000)).toBe(100);
		expect(wordsPerMinute(50, 30_000)).toBe(100);
	});

	test("returns 0 for durations under the minimum threshold (avoids 600 WPM from one-word bursts)", () => {
		expect(wordsPerMinute(1, 100)).toBe(0);
		expect(wordsPerMinute(1, 499)).toBe(0);
	});

	test("returns 0 for zero duration (no division by zero)", () => {
		expect(wordsPerMinute(10, 0)).toBe(0);
	});

	test("uses the configured 500ms floor as the cutoff (boundary)", () => {
		// At exactly 500ms we should compute, not bail.
		expect(wordsPerMinute(5, 500)).toBe(600);
	});
});

describe("dayRangeBounds", () => {
	test("returns null when either bound is null (unbounded range)", () => {
		// Mirrors the "selection in progress" UX — picker shouldn't collapse
		// the table while the user is still clicking the second endpoint.
		expect(dayRangeBounds(null, null)).toBeNull();
		expect(dayRangeBounds(new Date(2026, 0, 1), null)).toBeNull();
		expect(dayRangeBounds(null, new Date(2026, 0, 1))).toBeNull();
	});

	test("expands `from` to local midnight and `to` to end-of-day 23:59:59.999", () => {
		const from = new Date(2026, 4, 10, 17, 0, 0); // afternoon
		const to = new Date(2026, 4, 12, 3, 0, 0); // early morning
		const bounds = dayRangeBounds(from, to);
		expect(bounds).not.toBeNull();
		// fromTs is midnight of the from-day.
		const fromTs = new Date(bounds?.fromTs ?? 0);
		expect(fromTs.getFullYear()).toBe(2026);
		expect(fromTs.getMonth()).toBe(4);
		expect(fromTs.getDate()).toBe(10);
		expect(fromTs.getHours()).toBe(0);
		expect(fromTs.getMinutes()).toBe(0);
		// toTs is the last millisecond of the to-day.
		const toTs = new Date(bounds?.toTs ?? 0);
		expect(toTs.getFullYear()).toBe(2026);
		expect(toTs.getMonth()).toBe(4);
		expect(toTs.getDate()).toBe(12);
		expect(toTs.getHours()).toBe(23);
		expect(toTs.getMinutes()).toBe(59);
		expect(toTs.getSeconds()).toBe(59);
		expect(toTs.getMilliseconds()).toBe(999);
	});
});

describe("filterEntriesByDateRange", () => {
	test("returns the input unchanged when the range is unbounded", () => {
		const entries: TranscriptionHistoryEntry[] = [
			makeEntry({ id: "a", timestamp: 1 }),
			makeEntry({ id: "b", timestamp: 2 }),
		];
		expect(filterEntriesByDateRange(entries, null, null)).toBe(entries);
		expect(filterEntriesByDateRange(entries, new Date(), null)).toBe(entries);
		expect(filterEntriesByDateRange(entries, null, new Date())).toBe(entries);
	});

	test("keeps only entries whose timestamps fall inside the inclusive day range", () => {
		const inside = new Date(2026, 4, 11, 12, 0, 0).getTime();
		const beforeStart = new Date(2026, 4, 9, 23, 59, 59).getTime();
		const afterEnd = new Date(2026, 4, 13, 0, 0, 0).getTime();
		// Boundaries: start-of-day on the `from` side, end-of-day on `to` side.
		const atStart = new Date(2026, 4, 10, 0, 0, 0).getTime();
		const atEnd = new Date(2026, 4, 12, 23, 59, 59, 999).getTime();

		const entries: TranscriptionHistoryEntry[] = [
			makeEntry({ id: "before", timestamp: beforeStart }),
			makeEntry({ id: "atStart", timestamp: atStart }),
			makeEntry({ id: "inside", timestamp: inside }),
			makeEntry({ id: "atEnd", timestamp: atEnd }),
			makeEntry({ id: "after", timestamp: afterEnd }),
		];
		const out = filterEntriesByDateRange(
			entries,
			new Date(2026, 4, 10, 12, 0, 0),
			new Date(2026, 4, 12, 12, 0, 0),
		);
		expect(out.map((e) => e.id)).toEqual(["atStart", "inside", "atEnd"]);
	});

	test("empty input stays empty under any range", () => {
		expect(
			filterEntriesByDateRange([], new Date(2026, 0, 1), new Date(2026, 0, 2)),
		).toEqual([]);
	});
});

describe("aggregate", () => {
	test("sums counts and durations across all entries", () => {
		const entries: TranscriptionHistoryEntry[] = [
			makeEntry({ wordCount: 10, durationMs: 30_000 }),
			makeEntry({ wordCount: 20, durationMs: 30_000 }),
			makeEntry({ wordCount: 30, durationMs: 60_000 }),
		];
		const stats = aggregate(entries);
		expect(stats.count).toBe(3);
		expect(stats.totalWords).toBe(60);
		expect(stats.totalDurationMs).toBe(120_000);
		expect(stats.wpm).toBeCloseTo(30, 5);
	});

	test("empty input gives all zeros", () => {
		const stats = aggregate([]);
		expect(stats).toEqual({
			aiFixes: 0,
			count: 0,
			dictionaryFixes: 0,
			totalDurationMs: 0,
			totalWords: 0,
			wordsCorrected: 0,
			wpm: 0,
		});
	});

	test("counts AI fixes and sums corrected words from the raw→final diff", () => {
		const entries: TranscriptionHistoryEntry[] = [
			// Two words rewritten ("teh quik" → "the quick") → 1 fix, 2 words.
			makeEntry({
				originalText: "teh quik brown fox",
				text: "the quick brown fox",
				wordCount: 4,
			}),
			// No originalText (AI never ran) → ignored entirely.
			makeEntry({ text: "raw only", wordCount: 2 }),
			// originalText present but identical → no diff, not counted.
			makeEntry({
				originalText: "same words",
				text: "same words",
				wordCount: 2,
			}),
		];
		const stats = aggregate(entries);
		expect(stats.aiFixes).toBe(1);
		expect(stats.wordsCorrected).toBe(2);
	});

	test("sums dictionary fixes across entries, treating missing as zero", () => {
		const stats = aggregate([
			makeEntry({ dictionaryFixes: 3 }),
			makeEntry({ dictionaryFixes: 0 }),
			makeEntry({}), // legacy row, no count → contributes 0
			makeEntry({ dictionaryFixes: 5 }),
		]);
		expect(stats.dictionaryFixes).toBe(8);
	});
});

describe("wordsCorrectedBetween", () => {
	test("returns 0 when the text is unchanged", () => {
		expect(wordsCorrectedBetween("hello world", "hello world")).toBe(0);
	});

	test("counts each changed word, using the larger side of a rewrite", () => {
		// "two words" → "one" is a 2-word→1-word change ⇒ 2.
		expect(wordsCorrectedBetween("keep two words here", "keep one here")).toBe(
			2,
		);
	});
});

describe("toDayKey", () => {
	test("uses local YYYY-MM-DD format with zero-padded month/day", () => {
		// Use a midday-local timestamp so the date is unambiguous regardless of timezone.
		const ts = new Date(2026, 0, 3, 12, 0, 0).getTime();
		expect(toDayKey(ts)).toBe("2026-01-03");
	});
});

describe("sumWordsByDay", () => {
	test("groups entries by local day key and sums their word counts", () => {
		const day1 = new Date(2026, 4, 15, 12, 0, 0).getTime();
		const day2 = new Date(2026, 4, 16, 12, 0, 0).getTime();
		const totals = sumWordsByDay([
			makeEntry({ wordCount: 5, timestamp: day1 }),
			makeEntry({ wordCount: 7, timestamp: day1 }),
			makeEntry({ wordCount: 3, timestamp: day2 }),
		]);
		expect(totals.get("2026-05-15")).toBe(12);
		expect(totals.get("2026-05-16")).toBe(3);
	});

	test("returns an empty map for no entries", () => {
		expect(sumWordsByDay([]).size).toBe(0);
	});
});

describe("startOfLocalDay", () => {
	test("returns midnight (local time) of the given timestamp", () => {
		const ts = new Date(2026, 4, 15, 17, 42, 13).getTime();
		const start = startOfLocalDay(ts);
		expect(start.getFullYear()).toBe(2026);
		expect(start.getMonth()).toBe(4);
		expect(start.getDate()).toBe(15);
		expect(start.getHours()).toBe(0);
		expect(start.getMinutes()).toBe(0);
		expect(start.getSeconds()).toBe(0);
		expect(start.getMilliseconds()).toBe(0);
	});
});

describe("buildHeatmap", () => {
	test("always returns 365 buckets (rolling window)", () => {
		const buckets = buildHeatmap([], new Date(2026, 5, 15, 12, 0, 0).getTime());
		expect(buckets).toHaveLength(365);
	});

	test("aggregates entries by local day key and zero-fills empty days", () => {
		const now = new Date(2026, 4, 15, 12, 0, 0).getTime();
		const oneDayMs = 24 * 60 * 60 * 1000;
		const entries: TranscriptionHistoryEntry[] = [
			makeEntry({ wordCount: 5, timestamp: now }),
			makeEntry({ wordCount: 7, timestamp: now }),
			makeEntry({ wordCount: 3, timestamp: now - oneDayMs }),
		];
		const buckets = buildHeatmap(entries, now);
		const today = buckets.at(-1);
		const yesterday = buckets.at(-2);
		expect(today?.wordCount).toBe(12);
		expect(yesterday?.wordCount).toBe(3);
		// A random middle bucket must be zero (zero-fill guarantee).
		expect(buckets[100]?.wordCount).toBe(0);
	});
});

describe("isEmptyIntensity", () => {
	test("treats zero word count as empty regardless of max", () => {
		expect(isEmptyIntensity(0, 100)).toBe(true);
		expect(isEmptyIntensity(0, 0)).toBe(true);
	});

	test("treats zero max as empty even when word count is positive", () => {
		// Avoids division by zero in the caller.
		expect(isEmptyIntensity(50, 0)).toBe(true);
	});

	test("is false when both word count and max are positive", () => {
		expect(isEmptyIntensity(1, 1)).toBe(false);
		expect(isEmptyIntensity(50, 100)).toBe(false);
	});
});

describe("lookupIntensity", () => {
	test("maps ratios below each quartile cutoff to 1, 2, 3", () => {
		expect(lookupIntensity(0.1)).toBe(1);
		expect(lookupIntensity(0.3)).toBe(2);
		expect(lookupIntensity(0.6)).toBe(3);
	});

	test("ratios at or above 0.75 saturate to 4 (top of ramp)", () => {
		expect(lookupIntensity(0.75)).toBe(4);
		expect(lookupIntensity(1)).toBe(4);
		expect(lookupIntensity(2)).toBe(4);
	});

	test("boundary: cutoff values themselves do not match the lower bucket (< comparison)", () => {
		// ratio === 0.25 should NOT return 1; the next row owns it.
		expect(lookupIntensity(0.25)).toBe(2);
		expect(lookupIntensity(0.5)).toBe(3);
	});
});

describe("intensityLevel", () => {
	test("returns 0 when wordCount is zero or max is zero", () => {
		expect(intensityLevel(0, 100)).toBe(0);
		expect(intensityLevel(50, 0)).toBe(0);
	});

	test("steps through 1→4 at quartile boundaries of max", () => {
		// ratio < 0.25 → 1, < 0.5 → 2, < 0.75 → 3, else → 4
		expect(intensityLevel(10, 100)).toBe(1);
		expect(intensityLevel(30, 100)).toBe(2);
		expect(intensityLevel(60, 100)).toBe(3);
		expect(intensityLevel(80, 100)).toBe(4);
		expect(intensityLevel(100, 100)).toBe(4);
	});
});

describe("formatDuration", () => {
	test("uses <1s sentinel for sub-second durations", () => {
		expect(formatDuration(0)).toBe("<1s");
		expect(formatDuration(999)).toBe("<1s");
	});

	test("formats sub-minute durations as Ns", () => {
		expect(formatDuration(45_000)).toBe("45s");
	});

	test("formats over-minute durations as Mm SSs (zero-padded seconds)", () => {
		expect(formatDuration(65_000)).toBe("1m 05s");
		expect(formatDuration(3 * 60_000 + 12_000)).toBe("3m 12s");
	});
});

describe("formatWpm", () => {
	test("uses em-dash sentinel for zero/negative WPM", () => {
		expect(formatWpm(0)).toBe("—");
		expect(formatWpm(-1)).toBe("—");
	});

	test("shows one decimal under 100 WPM, no decimals at or above", () => {
		expect(formatWpm(45.678)).toBe("45.7");
		expect(formatWpm(120.6)).toBe("121");
	});
});
