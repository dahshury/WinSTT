import { historyTagLabel } from "@/entities/transcription-history";
import type { TranscriptionHistoryEntry } from "../model/history-store";

export interface UsageBucket {
	/** Stable React key (a model id or history-tag id, or `__other__`). */
	key: string;
	/** Human-readable label shown next to the bar. */
	label: string;
	count: number;
	/** Share of the counted entries, `0`–`100`, rounded to a whole percent. */
	pct: number;
}

export interface UsageBreakdown {
	/** Transcription-model usage. Always available once entries record a model. */
	models: UsageBucket[];
	/** Content categories from the dictation LLM's classification (sparser). */
	categories: UsageBucket[];
}

const usageCache = new WeakMap<
	TranscriptionHistoryEntry[],
	Map<string, UsageBreakdown>
>();

/** Beyond this many bars the long tail is rolled into a single "Other" row. */
const MAX_VISIBLE = 6;

const OTHER_KEY = "__other__";

interface Tally {
	key: string;
	label: string;
	count: number;
}

function pct(count: number, total: number): number {
	return total === 0 ? 0 : Math.round((count / total) * 100);
}

/**
 * Sort tallies by count descending and, when there are more than `MAX_VISIBLE`,
 * collapse everything past the top `MAX_VISIBLE - 1` into one `otherLabel` row
 * so the bar list stays readable. Returns percentages against `total`.
 */
function toBuckets(
	tallies: Tally[],
	total: number,
	otherLabel: string,
): UsageBucket[] {
	const sorted = tallies.toSorted((a, b) => b.count - a.count);
	if (sorted.length <= MAX_VISIBLE) {
		return sorted.map((t) => ({
			key: t.key,
			label: t.label,
			count: t.count,
			pct: pct(t.count, total),
		}));
	}
	const head = sorted.slice(0, MAX_VISIBLE - 1);
	const tail = sorted.slice(MAX_VISIBLE - 1);
	const tailCount = tail.reduce((sum, t) => sum + t.count, 0);
	return [
		...head.map((t) => ({
			key: t.key,
			label: t.label,
			count: t.count,
			pct: pct(t.count, total),
		})),
		{
			key: OTHER_KEY,
			label: otherLabel,
			count: tailCount,
			pct: pct(tailCount, total),
		},
	];
}

function modelUsage(
	entries: TranscriptionHistoryEntry[],
	otherLabel: string,
): UsageBucket[] {
	const counts = new Map<string, number>();
	let total = 0;
	for (const entry of entries) {
		const model = entry.sttModel?.trim();
		if (!model) {
			continue;
		}
		counts.set(model, (counts.get(model) ?? 0) + 1);
		total += 1;
	}
	const tallies: Tally[] = [...counts].map(([model, count]) => ({
		key: model,
		label: model,
		count,
	}));
	return toBuckets(tallies, total, otherLabel);
}

function categoryUsage(
	entries: TranscriptionHistoryEntry[],
	otherLabel: string,
): UsageBucket[] {
	const counts = new Map<string, number>();
	let total = 0;
	for (const entry of entries) {
		const tag = entry.historyTag;
		if (!tag || historyTagLabel(tag) === null) {
			continue;
		}
		counts.set(tag, (counts.get(tag) ?? 0) + 1);
		total += 1;
	}
	const tallies: Tally[] = [...counts].map(([tag, count]) => ({
		key: tag,
		// Non-null: tags with no label were skipped above.
		label: historyTagLabel(tag) ?? tag,
		count,
	}));
	return toBuckets(tallies, total, otherLabel);
}

/**
 * Usage breakdowns over the (date-filtered) history: which transcription models
 * produced the entries, and which content categories the dictation LLM tagged
 * them with. Entries missing the relevant field are simply not counted, so each
 * list is empty until there's data — the UI hides empty sections.
 */
export function computeUsage(
	entries: TranscriptionHistoryEntry[],
	otherLabel: string,
): UsageBreakdown {
	let byLabel = usageCache.get(entries);
	if (!byLabel) {
		byLabel = new Map();
		usageCache.set(entries, byLabel);
	}
	const cached = byLabel.get(otherLabel);
	if (cached) {
		return cached;
	}
	const breakdown = {
		models: modelUsage(entries, otherLabel),
		categories: categoryUsage(entries, otherLabel),
	};
	byLabel.set(otherLabel, breakdown);
	return breakdown;
}
