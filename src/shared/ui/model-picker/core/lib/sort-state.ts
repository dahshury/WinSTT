/**
 * Generic scaffolding for the picker "Sort by" state shared by the STT and
 * Ollama selectors (the Ollama sort module was ported from STT's). Each slice
 * keeps its own domain sort keys, chip/header labels, and comparators; this core
 * owns the one piece that is byte-for-byte identical across them — turning a
 * comparator map into a pure `toSorted` sorter — plus the small comparator
 * building blocks (stable name tie-break, unknown-last ascending compare) both
 * slices otherwise re-derive by hand.
 */

/** `null` = no sort active (the default grouped view). */
export type SortValue<TKey extends string> = TKey | null;

type Comparator<TModel> = (a: TModel, b: TModel) => number;

/**
 * Stable A→Z compare on a chosen name accessor — also the universal tie-breaker
 * for every sort key. `sensitivity: "base"` matches the per-slice `byName` both
 * selectors previously inlined.
 */
export function makeNameComparator<TModel>(
	getName: (model: TModel) => string,
): Comparator<TModel> {
	return (a, b) =>
		getName(a).localeCompare(getName(b), undefined, { sensitivity: "base" });
}

/**
 * Ascending compare on two metrics where `+Infinity` means "unknown". Guards the
 * `Infinity - Infinity = NaN` trap (two unknowns) by treating equal values —
 * including two unknowns — as a `byName` tie-break rather than subtracting, so an
 * unknown metric always sorts LAST of a smallest-first list.
 */
export function ascendingOrName<TModel>(
	av: number,
	bv: number,
	a: TModel,
	b: TModel,
	byName: Comparator<TModel>,
): number {
	if (av === bv) {
		return byName(a, b);
	}
	return av - bv;
}

/**
 * Build a pure `sortModels(models, key)` from a per-slice comparator map. Never
 * mutates the input (`toSorted`). The selector uses it to flatten its grouped
 * view into a single globally-sorted column while a sort is active.
 */
export function makeSortState<TKey extends string, TModel>(
	comparators: Record<TKey, Comparator<TModel>>,
): {
	sortModels: (models: readonly TModel[], key: TKey) => TModel[];
} {
	return {
		sortModels(models: readonly TModel[], key: TKey): TModel[] {
			return models.toSorted(comparators[key]);
		},
	};
}
