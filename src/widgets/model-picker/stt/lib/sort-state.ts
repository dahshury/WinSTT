import type { ModelInfo } from "@/entities/model-catalog";

/**
 * Sort dimensions exposed in the picker's "Sort by" section. ``null`` means no
 * sort is active — the selector keeps its default maker grouping and only
 * flattens the list into a single globally-sorted column once a key is picked.
 *
 * Each key sorts in its single most-useful direction (no asc/desc toggle):
 * speed → fastest first, accuracy → most accurate first, size → smallest
 * download first, name → A–Z. That "fixed best order" keeps the control to one
 * tap per dimension.
 */
export type SttSortKey = "speed" | "accuracy" | "size" | "name";

/** ``null`` = no sort active (the default grouped view). */
export type SttSortValue = SttSortKey | null;

/** Sort keys in display order — drives the menu chips + keeps logic table-driven. */
export const STT_SORT_KEYS = ["speed", "accuracy", "size", "name"] as const;

/** Short chip label per key (the popover). */
export const STT_SORT_CHIP_LABEL: Record<SttSortKey, string> = {
	speed: "Speed",
	accuracy: "Accuracy",
	size: "Size",
	name: "Name",
};

/** Full label per key, including the implied direction (the flat-list header). */
export const STT_SORT_HEADER_LABEL: Record<SttSortKey, string> = {
	speed: "Speed · fastest first",
	accuracy: "Accuracy · most accurate first",
	size: "Download size · smallest first",
	name: "Name · A–Z",
};

/**
 * Smallest published download across a model's quantizations, in bytes. Models
 * the catalog refresh hasn't sized yet (empty record / all-zero) return
 * ``+Infinity`` so they sort to the END of a smallest-first list rather than
 * masquerading as zero-byte downloads.
 */
function smallestDownloadBytes(m: ModelInfo): number {
	let min = Number.POSITIVE_INFINITY;
	for (const bytes of Object.values(m.sizeBytesByQuantization)) {
		if (bytes > 0 && bytes < min) {
			min = bytes;
		}
	}
	return min;
}

/** Stable A→Z name compare — also the universal tie-breaker for every key. */
function byName(a: ModelInfo, b: ModelInfo): number {
	return a.displayName.localeCompare(b.displayName, undefined, {
		sensitivity: "base",
	});
}

const COMPARATORS: Record<SttSortKey, (a: ModelInfo, b: ModelInfo) => number> =
	{
		// speedScore / accuracyScore are 0..1, higher = better → descending puts the
		// best first. The 0.5 "unknown" sentinel naturally lands mid-pack.
		speed: (a, b) => b.speedScore - a.speedScore || byName(a, b),
		accuracy: (a, b) => b.accuracyScore - a.accuracyScore || byName(a, b),
		size: (a, b) => {
			const av = smallestDownloadBytes(a);
			const bv = smallestDownloadBytes(b);
			const aUnknown = !Number.isFinite(av);
			const bUnknown = !Number.isFinite(bv);
			if (aUnknown !== bUnknown) {
				return aUnknown ? 1 : -1; // unknown sizes always sort last
			}
			return av - bv || byName(a, b);
		},
		name: byName,
	};

/**
 * Return a NEW array of ``models`` ordered by ``key`` in its fixed best
 * direction. Pure — never mutates the input. The selector uses this to flatten
 * the maker groups into a single globally-sorted column while a sort is active.
 */
export function sortSttModels(
	models: readonly ModelInfo[],
	key: SttSortKey,
): ModelInfo[] {
	return [...models].sort(COMPARATORS[key]);
}
