import type { TranscriptionHistoryEntry } from "../model/history-store";
import { startOfLocalDay, toDayKey } from "./word-stats";

export interface StreakStats {
	/**
	 * Consecutive local days with at least one transcription ending today. `0`
	 * the moment today has no activity — the streak is considered broken at
	 * midnight, matching how habit trackers behave.
	 */
	current: number;
	/** Longest run of consecutive active days anywhere in the history. */
	longest: number;
}

const streakCache = new WeakMap<
	TranscriptionHistoryEntry[],
	Map<string, StreakStats>
>();

/** The local-day key `deltaDays` away from `key` (DST-safe via setDate). */
function shiftDayKey(key: string, deltaDays: number): string {
	// A date-time string with no offset parses as local time (unlike a bare
	// "YYYY-MM-DD", which is UTC), keeping the key aligned with toDayKey.
	const date = new Date(`${key}T00:00:00`);
	date.setDate(date.getDate() + deltaDays);
	return toDayKey(date.getTime());
}

/**
 * Longest run of consecutive calendar days present in `days`. Each day that has
 * no predecessor in the set starts a run; we walk forward from it counting
 * successors. Every day is the start of exactly one run, so this is linear.
 */
function longestRun(days: ReadonlySet<string>): number {
	let longest = 0;
	for (const key of days) {
		if (days.has(shiftDayKey(key, -1))) {
			continue;
		}
		let length = 1;
		let cursor = shiftDayKey(key, 1);
		while (days.has(cursor)) {
			length += 1;
			cursor = shiftDayKey(cursor, 1);
		}
		if (length > longest) {
			longest = length;
		}
	}
	return longest;
}

/** Consecutive active days counting back from today (0 if today is inactive). */
function currentRun(days: ReadonlySet<string>, now: number): number {
	const cursor = startOfLocalDay(now);
	let length = 0;
	while (days.has(toDayKey(cursor.getTime()))) {
		length += 1;
		cursor.setDate(cursor.getDate() - 1);
	}
	return length;
}

/**
 * Current + longest daily activity streak. A "day" is a local calendar day with
 * at least one transcription. Computed over the whole history (not the selected
 * date range) since a streak is an all-time habit metric.
 */
export function computeStreak(
	entries: TranscriptionHistoryEntry[],
	now: number = Date.now(),
): StreakStats {
	if (entries.length === 0) {
		return { current: 0, longest: 0 };
	}
	const todayKey = toDayKey(startOfLocalDay(now).getTime());
	const cached = streakCache.get(entries)?.get(todayKey);
	if (cached) {
		return cached;
	}
	const days = new Set<string>();
	for (const entry of entries) {
		days.add(toDayKey(entry.timestamp));
	}
	const stats = { current: currentRun(days, now), longest: longestRun(days) };
	let byDay = streakCache.get(entries);
	if (!byDay) {
		byDay = new Map();
		streakCache.set(entries, byDay);
	}
	byDay.set(todayKey, stats);
	return stats;
}
