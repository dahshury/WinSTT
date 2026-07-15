import { describe, expect, test } from "bun:test";
import { ALL_AUTHORS_RAIL_ID } from "@/shared/ui/model-picker/core/group-rail-items";
import {
	createInitialUiState,
	isPersistedSttFilterState,
	isPersistedSttSelectorUiState,
	type PersistedSttSelectorUiState,
} from "./stt-selector-ui-state";

const LEGACY_FILTERS = {
	cachedOnly: false,
	fitsHardwareOnly: false,
	realtimeOnly: false,
	languages: [] as string[],
};

describe("isPersistedSttFilterState", () => {
	test("a pre-Suggested blob (missing suggestedOnly) is VALID, not rejected", () => {
		// Migration rule: rejecting old blobs would silently reset the user's
		// cached/language filters on upgrade. Missing key = valid, defaults ON.
		expect(isPersistedSttFilterState(LEGACY_FILTERS)).toBe(true);
	});

	test("a present boolean suggestedOnly is valid either way", () => {
		expect(
			isPersistedSttFilterState({ ...LEGACY_FILTERS, suggestedOnly: true }),
		).toBe(true);
		expect(
			isPersistedSttFilterState({ ...LEGACY_FILTERS, suggestedOnly: false }),
		).toBe(true);
	});

	test("a non-boolean suggestedOnly is invalid", () => {
		expect(
			isPersistedSttFilterState({ ...LEGACY_FILTERS, suggestedOnly: "yes" }),
		).toBe(false);
	});

	test("still rejects blobs missing the legacy flags", () => {
		expect(isPersistedSttFilterState({ suggestedOnly: true })).toBe(false);
		expect(isPersistedSttFilterState(null)).toBe(false);
		expect(isPersistedSttFilterState("filters")).toBe(false);
	});
});

describe("isPersistedSttSelectorUiState", () => {
	test("accepts a pre-Suggested persisted UI blob", () => {
		expect(
			isPersistedSttSelectorUiState({
				activeRailId: ALL_AUTHORS_RAIL_ID,
				filters: LEGACY_FILTERS,
				sort: null,
			}),
		).toBe(true);
	});

	test("rejects malformed sort / rail values", () => {
		expect(
			isPersistedSttSelectorUiState({
				activeRailId: 3,
				filters: LEGACY_FILTERS,
				sort: null,
			}),
		).toBe(false);
		expect(
			isPersistedSttSelectorUiState({
				activeRailId: null,
				filters: LEGACY_FILTERS,
				sort: "loudness",
			}),
		).toBe(false);
	});
});

describe("createInitialUiState suggestedOnly migration", () => {
	function persisted(
		filters: PersistedSttSelectorUiState["filters"],
	): PersistedSttSelectorUiState {
		return { activeRailId: null, filters, sort: null };
	}

	test("missing persisted key defaults the flag ON", () => {
		const state = createInitialUiState(null, null, persisted(LEGACY_FILTERS));
		expect(state.filters.suggestedOnly).toBe(true);
		// The legacy flags survive untouched.
		expect(state.filters.cachedOnly).toBe(false);
	});

	test("a persisted false stays OFF (user's explicit choice wins)", () => {
		const state = createInitialUiState(
			null,
			null,
			persisted({ ...LEGACY_FILTERS, suggestedOnly: false }),
		);
		expect(state.filters.suggestedOnly).toBe(false);
	});

	test("no persisted state at all → the ON default", () => {
		const state = createInitialUiState(null, null, undefined);
		expect(state.filters.suggestedOnly).toBe(true);
	});
});
