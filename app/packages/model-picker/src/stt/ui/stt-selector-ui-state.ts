import type { FamilyKey } from "../lib/family-helpers";
import { EMPTY_FILTER_STATE, type SttFilterState } from "../lib/filter-state";
import type { SttSortValue } from "../lib/sort-state";

/**
 * Consolidated UI / navigation state for `SttModelSelector`. The renderer
 * uses a single `useReducer` here so the component body stays under the
 * `react-doctor/prefer-useReducer` threshold (≤ 5 `useState` calls).
 */
export interface SttSelectorUiState {
	/** Currently expanded rail (family) — null when the selection has been
	 *  cleared and no rail tile has been clicked yet. */
	activeRailId: FamilyKey | string | null;
	/** Set of base-ids whose `SttVariantBundle` has its sibling drawer
	 *  expanded. Owned here (not in the bundle) so it survives filter/search
	 *  re-renders and so the variant card hosting the selected model is
	 *  pre-expanded for Base UI's open-time autoscroll. */
	expandedBundles: Set<string>;
	/** Per-instance filter state ("cached only" / "Spanish" / hardware-fit). */
	filters: SttFilterState;
	/** Controlled-open flag — kept so we can intercept friendly outside-press
	 *  clicks (filter Popover etc.) without collapsing the picker. */
	open: boolean;
	/** Active global sort, or ``null`` for the default maker grouping. When set,
	 *  the list flattens every maker group into one sorted column. */
	sort: SttSortValue;
}

export type SttSelectorUiAction =
	| { type: "setActiveRailId"; id: FamilyKey | string | null }
	| { type: "toggleBundle"; baseId: string }
	| { type: "ensureBundleExpanded"; baseId: string }
	| { type: "setFilters"; filters: SttFilterState }
	| { type: "setSort"; sort: SttSortValue }
	| { type: "resetFilters" }
	| { type: "setOpen"; open: boolean };

export function createInitialUiState(
	selectedFamily: FamilyKey | null,
	selectedBaseId: string | null
): SttSelectorUiState {
	const expanded = new Set<string>();
	if (selectedBaseId !== null) {
		expanded.add(selectedBaseId);
	}
	return {
		activeRailId: selectedFamily,
		expandedBundles: expanded,
		filters: EMPTY_FILTER_STATE,
		sort: null,
		open: false,
	};
}

export function sttSelectorUiReducer(
	state: SttSelectorUiState,
	action: SttSelectorUiAction
): SttSelectorUiState {
	switch (action.type) {
		case "setActiveRailId":
			if (state.activeRailId === action.id) {
				return state;
			}
			return { ...state, activeRailId: action.id };
		case "toggleBundle": {
			const next = new Set(state.expandedBundles);
			if (next.has(action.baseId)) {
				next.delete(action.baseId);
			} else {
				next.add(action.baseId);
			}
			return { ...state, expandedBundles: next };
		}
		case "ensureBundleExpanded": {
			if (state.expandedBundles.has(action.baseId)) {
				return state;
			}
			const next = new Set(state.expandedBundles);
			next.add(action.baseId);
			return { ...state, expandedBundles: next };
		}
		case "setFilters":
			return { ...state, filters: action.filters };
		case "setSort":
			if (state.sort === action.sort) {
				return state;
			}
			return { ...state, sort: action.sort };
		case "resetFilters":
			// Selecting a model resets both filters and sort so the next open
			// starts from the clean grouped view.
			return { ...state, filters: EMPTY_FILTER_STATE, sort: null };
		case "setOpen":
			if (state.open === action.open) {
				return state;
			}
			return { ...state, open: action.open };
		default:
			return state;
	}
}
