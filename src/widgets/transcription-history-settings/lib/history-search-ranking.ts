import {
	computeHighlightRanges,
	scoreFuzzyMatch,
	type HighlightRange,
} from "@/shared/lib/fuzzy-score";

export interface HistorySearchWorkerItem {
	backendTier: 1 | 2 | null;
	key: string;
	text: string;
	timestamp: number;
}

export interface HistorySearchWorkerMatch {
	key: string;
	ranges: HighlightRange[];
}

export function rankHistorySearchItems(
	query: string,
	items: HistorySearchWorkerItem[],
): HistorySearchWorkerMatch[] {
	return items
		.map((item) => {
			const score = scoreFuzzyMatch(item.text, query);
			if (!(score || item.backendTier)) {
				return null;
			}
			return {
				cost: score?.cost ?? Number.MAX_SAFE_INTEGER,
				key: item.key,
				ranges: computeHighlightRanges(item.text, query),
				tier: Math.min(score?.tier ?? 2, item.backendTier ?? 2),
				timestamp: item.timestamp,
			};
		})
		.filter((item): item is NonNullable<typeof item> => item !== null)
		.toSorted(
			(a, b) => a.tier - b.tier || a.cost - b.cost || b.timestamp - a.timestamp,
		)
		.map(({ key, ranges }) => ({ key, ranges }));
}
