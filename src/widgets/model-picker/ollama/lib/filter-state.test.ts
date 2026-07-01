import { describe, expect, it } from "bun:test";
import type { OllamaModel, RecommendedOllamaModel } from "@/shared/api/models";
import {
	EMPTY_OLLAMA_FILTER_STATE,
	filterInstalledOllamaModels,
	filterRecommendedOllamaModels,
	installedModelFitsHardware,
	isOllamaFilterState,
	type OllamaFilterState,
	ollamaActiveFilterCount,
	recommendedModelFitsHardware,
} from "./filter-state";

function model(
	overrides: Partial<OllamaModel> & { name: string },
): OllamaModel {
	return { size: 0, modifiedAt: "", ...overrides };
}

function recommended(
	overrides: Partial<RecommendedOllamaModel> & { name: string },
): RecommendedOllamaModel {
	return {
		displayName: overrides.name,
		paramSize: "1B",
		sizeBytes: 0,
		description: "",
		...overrides,
	};
}

const filters = (overrides: Partial<OllamaFilterState>): OllamaFilterState => ({
	...EMPTY_OLLAMA_FILTER_STATE,
	...overrides,
});

/** Fit lookup that fails any model at or above `limit` bytes. */
const fitUnder =
	(limit: number) =>
	(sizeBytes: number): { fits: boolean } => ({ fits: sizeBytes < limit });

const names = (models: readonly { name: string }[]): string[] =>
	models.map((m) => m.name);

describe("ollamaActiveFilterCount", () => {
	it("counts only the active flags", () => {
		expect(ollamaActiveFilterCount(EMPTY_OLLAMA_FILTER_STATE)).toBe(0);
		expect(ollamaActiveFilterCount(filters({ installedOnly: true }))).toBe(1);
		expect(
			ollamaActiveFilterCount(
				filters({ installedOnly: true, fitsHardwareOnly: true }),
			),
		).toBe(2);
	});

	it("restricts the count to the supplied flag subset", () => {
		// A host without system-fit data renders only `installedOnly`, so a stale
		// persisted `fitsHardwareOnly` must not inflate the badge.
		expect(
			ollamaActiveFilterCount(filters({ fitsHardwareOnly: true }), [
				"installedOnly",
			]),
		).toBe(0);
	});
});

describe("isOllamaFilterState", () => {
	it("accepts a well-formed state", () => {
		expect(isOllamaFilterState(EMPTY_OLLAMA_FILTER_STATE)).toBe(true);
	});

	it("rejects non-objects and missing/typo'd flags", () => {
		expect(isOllamaFilterState(null)).toBe(false);
		expect(isOllamaFilterState("installed")).toBe(false);
		expect(isOllamaFilterState({ installedOnly: true })).toBe(false);
		expect(
			isOllamaFilterState({ installedOnly: "yes", fitsHardwareOnly: false }),
		).toBe(false);
	});
});

describe("installedModelFitsHardware", () => {
	it("treats unknown/zero size and a missing lookup as a fit", () => {
		expect(
			installedModelFitsHardware(model({ name: "a" }), fitUnder(100)),
		).toBe(true);
		expect(
			installedModelFitsHardware(model({ name: "a", size: 999 }), undefined),
		).toBe(true);
	});

	it("defers to the lookup for known sizes", () => {
		expect(
			installedModelFitsHardware(
				model({ name: "small", size: 50 }),
				fitUnder(100),
			),
		).toBe(true);
		expect(
			installedModelFitsHardware(
				model({ name: "big", size: 200 }),
				fitUnder(100),
			),
		).toBe(false);
	});
});

describe("recommendedModelFitsHardware", () => {
	it("treats unknown size and a missing lookup as a fit", () => {
		expect(
			recommendedModelFitsHardware(recommended({ name: "a" }), fitUnder(100)),
		).toBe(true);
		expect(
			recommendedModelFitsHardware(
				recommended({ name: "a", sizeBytes: 999 }),
				undefined,
			),
		).toBe(true);
	});

	it("defers to the lookup for known sizes", () => {
		expect(
			recommendedModelFitsHardware(
				recommended({ name: "big", sizeBytes: 200 }),
				fitUnder(100),
			),
		).toBe(false);
	});
});

describe("filterInstalledOllamaModels", () => {
	const installed = [
		model({ name: "small", size: 50 }),
		model({ name: "big", size: 200 }),
		model({ name: "unknown" }),
	];

	it("returns the input reference untouched when no pruning filter is active", () => {
		expect(
			filterInstalledOllamaModels(
				installed,
				filters({ installedOnly: true }),
				fitUnder(100),
			),
		).toBe(installed);
	});

	it("prunes models that do not fit when fitsHardwareOnly is set", () => {
		expect(
			names(
				filterInstalledOllamaModels(
					installed,
					filters({ fitsHardwareOnly: true }),
					fitUnder(100),
				),
			),
		).toEqual(["small", "unknown"]);
	});
});

describe("filterRecommendedOllamaModels", () => {
	const recommendedList = [
		recommended({ name: "small", sizeBytes: 50 }),
		recommended({ name: "big", sizeBytes: 200 }),
	];

	it("empties the recommended list when installedOnly is set", () => {
		expect(
			filterRecommendedOllamaModels(
				recommendedList,
				filters({ installedOnly: true }),
				fitUnder(100),
			),
		).toEqual([]);
	});

	it("returns the input reference untouched with no active filter", () => {
		expect(
			filterRecommendedOllamaModels(
				recommendedList,
				EMPTY_OLLAMA_FILTER_STATE,
				fitUnder(100),
			),
		).toBe(recommendedList);
	});

	it("prunes oversized recommendations when fitsHardwareOnly is set", () => {
		expect(
			names(
				filterRecommendedOllamaModels(
					recommendedList,
					filters({ fitsHardwareOnly: true }),
					fitUnder(100),
				),
			),
		).toEqual(["small"]);
	});
});
