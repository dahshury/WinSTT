import { describe, expect, test } from "bun:test";
import type { TranscriptionHistoryEntry } from "../model/history-store";
import {
	aggregate,
	buildHeatmap,
	formatDuration,
	formatWpm,
	intensityLevel,
	startOfLocalDay,
	sumWordsByDay,
	toDayKey,
	wordsPerMinute,
} from "./word-stats";

function makeEntry(partial: Partial<TranscriptionHistoryEntry>): TranscriptionHistoryEntry {
	return {
		id: partial.id ?? "id",
		timestamp: partial.timestamp ?? 0,
		text: partial.text ?? "",
		wordCount: partial.wordCount ?? 0,
		durationMs: partial.durationMs ?? 0,
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
		expect(stats).toEqual({ count: 0, totalWords: 0, totalDurationMs: 0, wpm: 0 });
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
