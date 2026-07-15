import type { ModelInfo } from "@/entities/model-catalog";
import {
	ascendingOrName,
	makeNameComparator,
	makeSortState,
	type SortValue,
} from "@/shared/ui/model-picker/core/lib/sort-state";

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
export type SttSortValue = SortValue<SttSortKey>;

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
const byName = makeNameComparator((m: ModelInfo) => m.displayName);

const COMPARATORS: Record<SttSortKey, (a: ModelInfo, b: ModelInfo) => number> =
	{
		// speedScore / accuracyScore are 0..1, higher = better → descending puts the
		// best first. The 0.5 "unknown" sentinel naturally lands mid-pack.
		speed: (a, b) => b.speedScore - a.speedScore || byName(a, b),
		accuracy: (a, b) => b.accuracyScore - a.accuracyScore || byName(a, b),
		// `smallestDownloadBytes` returns ``+Infinity`` for an unsized model, so the
		// shared unknown-last compare drops it to the END of the smallest-first list.
		size: (a, b) =>
			ascendingOrName(
				smallestDownloadBytes(a),
				smallestDownloadBytes(b),
				a,
				b,
				byName,
			),
		name: byName,
	};

/**
 * Return a NEW array of ``models`` ordered by ``key`` in its fixed best
 * direction. Pure — never mutates the input. The selector uses this to flatten
 * the maker groups into a single globally-sorted column while a sort is active.
 */
export const { sortModels: sortSttModels } = makeSortState(COMPARATORS);
