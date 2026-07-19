"use client";

import { useEffect, useReducer, useState } from "react";
import { isRecord } from "@/shared/lib/is-record";
import {
	readPersistedSelectorState,
	writePersistedSelectorState,
} from "@/shared/lib/persisted-selector-state";
import { ALL_AUTHORS_RAIL_ID } from "@/shared/ui/model-picker/core/group-rail-items";
import { useModelPickerCloseGuard } from "@/shared/ui/model-picker/lib/model-picker-close-guard";
import {
	EMPTY_TTS_FILTER_STATE,
	isTtsFilterState,
	normalizeTtsFilterState,
	type PersistedTtsFilterState,
	type TtsFilterState,
} from "../lib/filter-state";
import { TTS_SORT_KEYS, type TtsSortValue } from "../lib/sort-state";

const TTS_SELECTOR_UI_STORAGE_KEY = "winstt:model-picker:tts-ui";

interface TtsSelectorUiState {
	activeRailId: string | null;
	filters: TtsFilterState;
	/** Text-search query, owned here (not inside `ModelPicker`) so a query can
	 *  span ALL authors — it overrides the active rail, so e.g. "piper" finds
	 *  Piper voices even while the Kokoro rail is selected. */
	search: string;
	sort: TtsSortValue;
}

interface PersistedTtsSelectorUiState {
	activeRailId: string | null;
	/** May predate the `suggestedOnly` flag — normalized (missing key → ON). */
	filters?: PersistedTtsFilterState;
	sort?: TtsSortValue;
}

const DEFAULT_PERSISTED_TTS_SELECTOR_UI_STATE: PersistedTtsSelectorUiState = {
	activeRailId: ALL_AUTHORS_RAIL_ID,
};

function isPersistedTtsSelectorUiState(
	value: unknown,
): value is PersistedTtsSelectorUiState {
	if (!isRecord(value)) {
		return false;
	}
	const activeRailId = value["activeRailId"];
	const filters = value["filters"];
	const sort = value["sort"];
	return (
		(activeRailId === null || typeof activeRailId === "string") &&
		(filters === undefined || isTtsFilterState(filters)) &&
		(sort === undefined ||
			sort === null ||
			(typeof sort === "string" && TTS_SORT_KEYS.some((key) => key === sort)))
	);
}

export type TtsSelectorUiAction =
	| { id: string | null; type: "setActiveRailId" }
	| { filters: TtsFilterState; type: "setFilters" }
	| { search: string; type: "setSearch" }
	| { sort: TtsSortValue; type: "setSort" };

function uiReducer(
	state: TtsSelectorUiState,
	action: TtsSelectorUiAction,
): TtsSelectorUiState {
	switch (action.type) {
		case "setActiveRailId":
			return state.activeRailId === action.id
				? state
				: { ...state, activeRailId: action.id };
		case "setSearch":
			return state.search === action.search
				? state
				: { ...state, search: action.search };
		case "setFilters":
			return { ...state, filters: action.filters };
		case "setSort":
			return state.sort === action.sort
				? state
				: { ...state, sort: action.sort };
	}
}

/** Owns the selector's persisted browsing state and transient popup state.
 *  Keeping `open` in `useState` gives the close guard React's stable setter
 *  instead of recreating an adapter callback around the broader UI reducer. */
export function useTtsSelectorUi() {
	const [state, dispatch] = useReducer(uiReducer, undefined, () => {
		const persisted = readPersistedSelectorState(
			TTS_SELECTOR_UI_STORAGE_KEY,
			isPersistedTtsSelectorUiState,
			DEFAULT_PERSISTED_TTS_SELECTOR_UI_STATE,
		);
		return {
			activeRailId: persisted.activeRailId,
			filters: persisted.filters
				? normalizeTtsFilterState(persisted.filters)
				: { ...EMPTY_TTS_FILTER_STATE },
			search: "",
			sort: persisted.sort ?? null,
		};
	});
	const [open, setOpen] = useState(false);
	const { activeRailId, filters, sort } = state;

	useEffect(() => {
		writePersistedSelectorState(TTS_SELECTOR_UI_STORAGE_KEY, {
			activeRailId,
			filters,
			sort,
		});
	}, [activeRailId, filters, sort]);

	const openGuard = useModelPickerCloseGuard({ setOpen });

	return { dispatch, open, openGuard, state };
}
