import {
	bareCloudModelId,
	isCloudModelId,
	modelChipLogo,
} from "@/entities/cloud-stt-provider";
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
	/** Maker brand logo (resolved public URL) for a model bucket, or `null`. */
	logo?: string | null;
	/** True when the bucket's model runs on a cloud provider (badges the mark). */
	cloud?: boolean;
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
	logo?: string | null;
	cloud?: boolean;
}

function pct(count: number, total: number): number {
	return total === 0 ? 0 : Math.round((count / total) * 100);
}

/**
 * Sort tallies by count descending and roll the long tail — plus any explicit
 * `OTHER_KEY` tally (e.g. the "other" content category) — into one shared
 * `otherLabel` row at the bottom. Folding the explicit "other" into the same
 * roll-up is what stops the list from showing two competing "Other" bars.
 * Returns percentages against `total`.
 */
function toBuckets(
	tallies: Tally[],
	total: number,
	otherLabel: string,
): UsageBucket[] {
	const toBucket = (t: Tally): UsageBucket => ({
		key: t.key,
		label: t.label,
		count: t.count,
		pct: pct(t.count, total),
		logo: t.logo ?? null,
		cloud: t.cloud ?? false,
	});
	// Any pre-existing "other" tally is set aside and always merges into the
	// roll-up row, never competing with it as a separate bar.
	let otherCount = 0;
	const named: Tally[] = [];
	for (const t of tallies) {
		if (t.key === OTHER_KEY) {
			otherCount += t.count;
		} else {
			named.push(t);
		}
	}
	const sorted = named.toSorted((a, b) => b.count - a.count);
	// Reserve a slot for the roll-up whenever one will exist, so the total row
	// count still tops out at `MAX_VISIBLE`.
	const willRollUp = otherCount > 0 || sorted.length > MAX_VISIBLE;
	const headMax = willRollUp ? MAX_VISIBLE - 1 : MAX_VISIBLE;
	const head = sorted.slice(0, headMax);
	otherCount += sorted.slice(headMax).reduce((sum, t) => sum + t.count, 0);
	const buckets = head.map(toBucket);
	if (otherCount > 0) {
		buckets.push({
			key: OTHER_KEY,
			label: otherLabel,
			count: otherCount,
			pct: pct(otherCount, total),
		});
	}
	return buckets;
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
		// Strip the `openrouter:` / `elevenlabs:` cloud prefix — the maker logo +
		// cloud sign carry the provenance, not the raw prefix in the label.
		label: bareCloudModelId(model),
		count,
		logo: modelChipLogo(model),
		cloud: isCloudModelId(model),
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
		// Fold the LLM's literal "other" classification into the shared roll-up
		// row so it never shows as a second "Other" bar beside the long tail.
		key: tag === "other" ? OTHER_KEY : tag,
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
