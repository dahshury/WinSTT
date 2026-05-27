import {
	EMPTY_FILTER_STATE,
	type SttFilterState,
} from "../lib/filter-state";
import type { FamilyKey } from "../lib/family-helpers";

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
}

export type SttSelectorUiAction =
	| { type: "setActiveRailId"; id: FamilyKey | string | null }
	| { type: "toggleBundle"; baseId: string }
	| { type: "ensureBundleExpanded"; baseId: string }
	| { type: "setFilters"; filters: SttFilterState }
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
		case "resetFilters":
			return { ...state, filters: EMPTY_FILTER_STATE };
		case "setOpen":
			if (state.open === action.open) {
				return state;
			}
			return { ...state, open: action.open };
		default:
			return state;
	}
}
