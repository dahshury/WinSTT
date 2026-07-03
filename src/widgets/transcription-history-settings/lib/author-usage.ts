import type { TranscriptionHistoryEntry } from "../model/history-store";

/** One pie slice: the org/maker behind a set of transcriptions. */
export interface AuthorSlice {
	/** Stable React key (the author label, or `__other__` for the roll-up). */
	key: string;
	/** Org/maker name (e.g. "OpenAI", "NVIDIA"). */
	label: string;
	/** Renderer-resolved brand-logo path, or `null` for the "Other" roll-up. */
	logoSrc: string | null;
	count: number;
	/** Share of the counted entries, `0`–`100`, rounded to a whole percent. */
	pct: number;
}

/** What a model id/name resolves to — the maker and its (optional) logo. */
export interface ResolvedAuthor {
	author: string;
	logoSrc: string | null;
}

/** Beyond this many slices the long tail rolls into a single "Other" wedge. */
const MAX_SLICES = 6;

const OTHER_KEY = "__other__";

function pct(count: number, total: number): number {
	return total === 0 ? 0 : Math.round((count / total) * 100);
}

/**
 * Group the (date-filtered) history by the maker behind each transcription's
 * model, for the pie beside the model breakdown. `resolve` maps a stored
 * `sttModel` string to its maker + logo (via the catalog); entries whose model
 * can't be resolved — plus the long tail past {@link MAX_SLICES} — collapse into
 * one logo-less "Other" slice. Entries with no model are skipped, so the list is
 * empty until there's data and the caller can hide the pie.
 */
export function computeAuthorUsage(
	entries: TranscriptionHistoryEntry[],
	resolve: (sttModel: string) => ResolvedAuthor | null,
	otherLabel: string,
): AuthorSlice[] {
	const byAuthor = new Map<string, { logoSrc: string | null; count: number }>();
	let total = 0;
	let otherCount = 0;
	for (const entry of entries) {
		const model = entry.sttModel?.trim();
		if (!model) {
			continue;
		}
		total += 1;
		const resolved = resolve(model);
		if (!resolved) {
			otherCount += 1;
			continue;
		}
		const current = byAuthor.get(resolved.author);
		if (current) {
			current.count += 1;
		} else {
			byAuthor.set(resolved.author, { logoSrc: resolved.logoSrc, count: 1 });
		}
	}
	if (total === 0) {
		return [];
	}

	const resolved = [...byAuthor]
		.map(([author, v]) => ({
			key: author,
			label: author,
			logoSrc: v.logoSrc,
			count: v.count,
		}))
		.sort((a, b) => b.count - a.count);

	// No roll-up needed: every maker is resolved and fits.
	if (otherCount === 0 && resolved.length <= MAX_SLICES) {
		return resolved.map((r) => ({ ...r, pct: pct(r.count, total) }));
	}

	const head = resolved.slice(0, MAX_SLICES - 1);
	const tailCount =
		otherCount +
		resolved.slice(MAX_SLICES - 1).reduce((sum, r) => sum + r.count, 0);
	const slices: AuthorSlice[] = head.map((r) => ({
		...r,
		pct: pct(r.count, total),
	}));
	if (tailCount > 0) {
		slices.push({
			key: OTHER_KEY,
			label: otherLabel,
			logoSrc: null,
			count: tailCount,
			pct: pct(tailCount, total),
		});
	}
	return slices;
}
