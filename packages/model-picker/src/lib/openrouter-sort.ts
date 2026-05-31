import type { OpenRouterModel } from "@/shared/api/models";

/**
 * Sort dimensions exposed in the OpenRouter picker's "Sort by" section. ``null``
 * means no sort is active — the selector keeps its default per-maker grouping
 * (plus the maker rail) and only flattens into a single globally-sorted column
 * once a key is picked.
 *
 * Each key sorts in its single most-useful direction (no asc/desc toggle):
 * name → A–Z, context → largest window first, price → cheapest first. That
 * "fixed best order" keeps the control to one tap per dimension.
 */
export type OpenRouterSortKey = "name" | "context" | "price";

/** ``null`` = no sort active (the default grouped view). */
export type OpenRouterSortValue = OpenRouterSortKey | null;

/** Sort keys in display order — drives the menu rows + keeps logic table-driven. */
export const OPENROUTER_SORT_KEYS = ["name", "context", "price"] as const;

/**
 * Sentinel maker key for the single flattened group the selector builds while a
 * sort is active. The maker rail is hidden in that mode, so this never surfaces
 * as a visible label — it just keeps the ``[maker, models][]`` group shape valid
 * for {@link buildVirtualItems}.
 */
export const SORTED_GROUP_KEY = "__sorted__";

/** Short chip/row label per key (the filters menu). */
export const OPENROUTER_SORT_CHIP_LABEL: Record<OpenRouterSortKey, string> = {
	context: "Context",
	name: "Name",
	price: "Price",
};

/** Full label per key, including the implied direction (the flat-list header). */
export const OPENROUTER_SORT_HEADER_LABEL: Record<OpenRouterSortKey, string> = {
	context: "Context · largest first",
	name: "Name · A–Z",
	price: "Price · cheapest first",
};

/** Stable A→Z name compare — also the universal tie-breaker for every key. */
function byName(a: OpenRouterModel, b: OpenRouterModel): number {
	return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * Context window in tokens, or ``0`` when the model never reports one. Used as a
 * "largest first" descending key with a known-missing sentinel so context-less
 * models sort to the END rather than masquerading as zero-token windows.
 */
function contextLength(m: OpenRouterModel): number {
	return m.context_length ?? 0;
}

/**
 * Prompt price in USD/token. Missing or unparseable prices return ``NaN`` so the
 * comparator can push them to the END of a cheapest-first list (free models —
 * an explicit ``0`` — still sort first).
 */
function promptPrice(m: OpenRouterModel): number {
	return Number.parseFloat(m.pricing?.prompt ?? "");
}

const COMPARATORS: Record<OpenRouterSortKey, (a: OpenRouterModel, b: OpenRouterModel) => number> = {
	name: byName,
	// Larger context window first; 0/missing windows always sort last.
	context: (a, b) => {
		const av = contextLength(a);
		const bv = contextLength(b);
		const aUnknown = av <= 0;
		const bUnknown = bv <= 0;
		if (aUnknown !== bUnknown) {
			return aUnknown ? 1 : -1;
		}
		return bv - av || byName(a, b);
	},
	// Cheapest prompt price first; NaN/missing prices always sort last.
	price: (a, b) => {
		const av = promptPrice(a);
		const bv = promptPrice(b);
		const aUnknown = Number.isNaN(av);
		const bUnknown = Number.isNaN(bv);
		if (aUnknown !== bUnknown) {
			return aUnknown ? 1 : -1;
		}
		if (aUnknown && bUnknown) {
			return byName(a, b);
		}
		return av - bv || byName(a, b);
	},
};

/**
 * Return a NEW array of ``models`` ordered by ``key`` in its fixed best
 * direction. Pure — never mutates the input. The selector uses this to flatten
 * the maker groups into a single globally-sorted column while a sort is active.
 */
export function sortOpenRouterModels(
	models: readonly OpenRouterModel[],
	key: OpenRouterSortKey
): OpenRouterModel[] {
	return [...models].sort(COMPARATORS[key]);
}
