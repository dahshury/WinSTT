import type { TranscriptionHistoryEntry } from "../model/history-store";

const MS_PER_MIN = 60 * 1000;
const MIN_DURATION_FOR_WPM_MS = 500;

export interface AggregateStats {
	count: number;
	totalDurationMs: number;
	totalWords: number;
	wpm: number;
}

/**
 * Returns the subset of entries whose timestamps fall on or between the
 * inclusive local-day bounds [from, to]. When either bound is missing the
 * range is treated as unbounded and the input is returned unchanged — this
 * keeps "selection in progress" (only `from` set) from collapsing the table
 * mid-pick.
 */
export function filterEntriesByDateRange(
	entries: TranscriptionHistoryEntry[],
	from: Date | null,
	to: Date | null
): TranscriptionHistoryEntry[] {
	if (!(from && to)) {
		return entries;
	}
	const fromTs = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
	const toTs = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999).getTime();
	return entries.filter((e) => e.timestamp >= fromTs && e.timestamp <= toTs);
}

export function aggregate(entries: TranscriptionHistoryEntry[]): AggregateStats {
	let totalWords = 0;
	let totalDurationMs = 0;
	for (const entry of entries) {
		totalWords += entry.wordCount;
		totalDurationMs += entry.durationMs;
	}
	return {
		count: entries.length,
		totalWords,
		totalDurationMs,
		wpm: wordsPerMinute(totalWords, totalDurationMs),
	};
}

export function wordsPerMinute(words: number, durationMs: number): number {
	if (durationMs < MIN_DURATION_FOR_WPM_MS) {
		return 0;
	}
	return (words * MS_PER_MIN) / durationMs;
}

/**
 * Local-time YYYY-MM-DD key. Aggregating by UTC would split sessions across
 * midnight in any non-UTC timezone, which makes the heatmap misleading.
 */
export function toDayKey(timestamp: number): string {
	const d = new Date(timestamp);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export interface DayBucket {
	date: Date;
	dayKey: string;
	wordCount: number;
}

const HEATMAP_DAYS = 365;

/**
 * Sums word counts per local day key so the heatmap can read totals in O(1).
 */
export function sumWordsByDay(entries: TranscriptionHistoryEntry[]): Map<string, number> {
	const totals = new Map<string, number>();
	for (const entry of entries) {
		const key = toDayKey(entry.timestamp);
		totals.set(key, (totals.get(key) ?? 0) + entry.wordCount);
	}
	return totals;
}

/**
 * Returns midnight (local time) of the given timestamp. Splitting this out
 * keeps `buildHeatmap` linear and easy to reason about.
 */
export function startOfLocalDay(now: number): Date {
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	return today;
}

function makeBucket(today: Date, daysAgo: number, totals: Map<string, number>): DayBucket {
	// Walk calendar days via setDate, not by subtracting 86_400_000 ms — fixed-ms
	// stepping double-counts a date around fall-back (25h day) and skips one
	// around spring-forward (23h day), producing duplicate React keys.
	const date = new Date(today);
	date.setDate(date.getDate() - daysAgo);
	const key = toDayKey(date.getTime());
	return { date, dayKey: key, wordCount: totals.get(key) ?? 0 };
}

/**
 * Rolling 365-day window ending today (local time). Every day in the window
 * appears, even with zero words — the heatmap needs the full grid.
 */
export function buildHeatmap(
	entries: TranscriptionHistoryEntry[],
	now: number = Date.now()
): DayBucket[] {
	const totals = sumWordsByDay(entries);
	const today = startOfLocalDay(now);
	return Array.from({ length: HEATMAP_DAYS }, (_, i) =>
		makeBucket(today, HEATMAP_DAYS - 1 - i, totals)
	);
}

type IntensityLevel = 0 | 1 | 2 | 3 | 4;

// Sorted ascending by ratio cutoff. The first row whose cutoff exceeds the
// ratio wins. Using a table + Array.find drops CC vs. a hand-unrolled if-chain.
const INTENSITY_THRESHOLDS: ReadonlyArray<readonly [number, IntensityLevel]> = [
	[0.25, 1],
	[0.5, 2],
	[0.75, 3],
];

/**
 * True when there's no signal to map onto the ramp. Split out so the public
 * `intensityLevel` stays trivially branchy (CC ≤ 4).
 */
export function isEmptyIntensity(wordCount: number, max: number): boolean {
	return wordCount === 0 || max === 0;
}

/**
 * Picks the first table row whose cutoff exceeds `ratio`, falling back to 4
 * (the top of the ramp) when nothing matches. Pulled out so the lookup loop
 * doesn't inflate `intensityLevel`'s complexity.
 */
export function lookupIntensity(ratio: number): IntensityLevel {
	const hit = INTENSITY_THRESHOLDS.find(([cutoff]) => ratio < cutoff);
	return hit ? hit[1] : 4;
}

/**
 * 5-step intensity ramp (0 = no activity, 4 = the most active day in the
 * window). Anchored to the window's actual max so a low-volume week doesn't
 * look identical to a high-volume one — the scale auto-adjusts.
 */
export function intensityLevel(wordCount: number, max: number): IntensityLevel {
	if (isEmptyIntensity(wordCount, max)) {
		return 0;
	}
	return lookupIntensity(wordCount / max);
}

export function formatDuration(ms: number): string {
	if (ms < 1000) {
		return "<1s";
	}
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const remSeconds = seconds % 60;
	return `${minutes}m ${String(remSeconds).padStart(2, "0")}s`;
}

export function formatWpm(value: number): string {
	if (value <= 0) {
		return "—";
	}
	return value.toFixed(value >= 100 ? 0 : 1);
}
