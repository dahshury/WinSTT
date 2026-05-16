import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import {
	activeFilterCount,
	collectFilterableLanguages,
	EMPTY_FILTER_STATE,
	type FilterModelsContext,
	filterSttModels,
	formatLanguageCoverage,
	hasActiveFilters,
	modelSupportsLanguage,
	type SttFilterState,
} from "./filter-state";

function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
	return {
		id: "m",
		displayName: "Whisper Tiny",
		family: "whisper",
		backend: "faster_whisper",
		languages: ["en"],
		supportsLanguageDetection: true,
		sizeLabel: "39M",
		supportsRealtime: true,
		onnxModelName: null,
		description: "",
		availableQuantizations: [""],
		...overrides,
	} as ModelInfo;
}

function entry(overrides: Partial<ModelStateEntry> = {}): ModelStateEntry {
	return {
		id: "m",
		estimated_bytes: 1_000_000,
		comfortable_on_cpu: true,
		comfortable_on_gpu: true,
		available_quantizations: [""],
		cache_by_quantization: {},
		cache: { state: "not_cached", downloaded_bytes: 0, progress: 0, total_bytes: 1 },
		...overrides,
	};
}

function sys(gpuCount = 0): SystemInfoEntry {
	return {
		total_ram_bytes: 16_000_000_000,
		gpus: Array.from({ length: gpuCount }, (_, i) => ({
			name: `GPU${i}`,
			total_vram_bytes: 8_000_000_000,
		})),
	};
}

function ctx(overrides: Partial<FilterModelsContext> = {}): FilterModelsContext {
	return {
		filters: { ...EMPTY_FILTER_STATE, languages: [] },
		searchQuery: "",
		statesById: {},
		systemInfo: null,
		...overrides,
	};
}

function filters(overrides: Partial<SttFilterState> = {}): SttFilterState {
	return { ...EMPTY_FILTER_STATE, languages: [], ...overrides };
}

describe("activeFilterCount", () => {
	test("zero for the empty filter state", () => {
		expect(activeFilterCount(filters())).toBe(0);
	});

	test("counts each enabled toggle", () => {
		expect(activeFilterCount(filters({ cachedOnly: true }))).toBe(1);
		expect(
			activeFilterCount(filters({ cachedOnly: true, realtimeOnly: true, fitsHardwareOnly: true }))
		).toBe(3);
	});

	test("adds the number of selected languages", () => {
		expect(activeFilterCount(filters({ languages: ["en", "fr"] }))).toBe(2);
		expect(activeFilterCount(filters({ realtimeOnly: true, languages: ["en"] }))).toBe(2);
	});
});

describe("hasActiveFilters", () => {
	test("false for the empty filter state", () => {
		expect(hasActiveFilters(filters())).toBe(false);
	});

	test("true when any toggle or language is set", () => {
		expect(hasActiveFilters(filters({ fitsHardwareOnly: true }))).toBe(true);
		expect(hasActiveFilters(filters({ languages: ["de"] }))).toBe(true);
	});
});

describe("modelSupportsLanguage", () => {
	test("multilingual models (empty list) support any language", () => {
		expect(modelSupportsLanguage(model({ languages: [] }), "zz")).toBe(true);
	});

	test("explicit lists match only listed codes", () => {
		expect(modelSupportsLanguage(model({ languages: ["en", "fr"] }), "fr")).toBe(true);
		expect(modelSupportsLanguage(model({ languages: ["en", "fr"] }), "de")).toBe(false);
	});
});

describe("collectFilterableLanguages", () => {
	test("returns sorted distinct codes", () => {
		const result = collectFilterableLanguages([
			model({ languages: ["fr", "en"] }),
			model({ languages: ["en", "de"] }),
			model({ languages: [] }),
		]);
		expect(result).toEqual(["de", "en", "fr"]);
	});

	test("empty for no models", () => {
		expect(collectFilterableLanguages([])).toEqual([]);
	});
});

describe("filterSttModels", () => {
	test("returns all models with no filters and empty query", () => {
		const models = [model({ id: "a" }), model({ id: "b" })];
		expect(filterSttModels(models, ctx())).toHaveLength(2);
	});

	test("search query matches displayName/id/family/sizeLabel, case-insensitive", () => {
		const models = [
			model({ id: "a", displayName: "Whisper Tiny" }),
			model({ id: "nemo-x", displayName: "NeMo X", family: "nemo" }),
		];
		expect(filterSttModels(models, ctx({ searchQuery: "  TINY " })).map((m) => m.id)).toEqual([
			"a",
		]);
		expect(filterSttModels(models, ctx({ searchQuery: "nemo" })).map((m) => m.id)).toEqual([
			"nemo-x",
		]);
		expect(filterSttModels(models, ctx({ searchQuery: "zzz" }))).toHaveLength(0);
	});

	test("cachedOnly keeps only cached models", () => {
		const models = [model({ id: "a" }), model({ id: "b" })];
		const out = filterSttModels(
			models,
			ctx({
				filters: filters({ cachedOnly: true }),
				statesById: {
					a: entry({
						id: "a",
						cache: { state: "cached", downloaded_bytes: 1, progress: 1, total_bytes: 1 },
					}),
				},
			})
		);
		expect(out.map((m) => m.id)).toEqual(["a"]);
	});

	test("cachedOnly drops models with no state entry at all", () => {
		const models = [model({ id: "a" })];
		const out = filterSttModels(
			models,
			ctx({ filters: filters({ cachedOnly: true }), statesById: {} })
		);
		expect(out).toHaveLength(0);
	});

	test("fitsHardwareOnly keeps models with unknown footprint", () => {
		const models = [model({ id: "u" })];
		const out = filterSttModels(
			models,
			ctx({
				filters: filters({ fitsHardwareOnly: true }),
				statesById: { u: entry({ id: "u", estimated_bytes: 0 }) },
				systemInfo: sys(1),
			})
		);
		expect(out.map((m) => m.id)).toEqual(["u"]);
	});

	test("fitsHardwareOnly keeps GPU-comfortable models when a GPU is present", () => {
		const models = [model({ id: "g" })];
		const out = filterSttModels(
			models,
			ctx({
				filters: filters({ fitsHardwareOnly: true }),
				statesById: {
					g: entry({ id: "g", comfortable_on_cpu: false, comfortable_on_gpu: true }),
				},
				systemInfo: sys(1),
			})
		);
		expect(out.map((m) => m.id)).toEqual(["g"]);
	});

	test("fitsHardwareOnly keeps models with no state entry at all", () => {
		const models = [model({ id: "n" })];
		const out = filterSttModels(
			models,
			ctx({
				filters: filters({ fitsHardwareOnly: true }),
				statesById: {},
				systemInfo: sys(1),
			})
		);
		expect(out.map((m) => m.id)).toEqual(["n"]);
	});

	test("fitsHardwareOnly drops GPU-only models when no GPU is present", () => {
		const models = [model({ id: "g" })];
		const out = filterSttModels(
			models,
			ctx({
				filters: filters({ fitsHardwareOnly: true }),
				statesById: {
					g: entry({ id: "g", comfortable_on_cpu: false, comfortable_on_gpu: true }),
				},
				systemInfo: sys(0),
			})
		);
		expect(out).toHaveLength(0);
	});

	test("fitsHardwareOnly keeps CPU-comfortable models when no GPU is present", () => {
		const models = [model({ id: "c" })];
		const out = filterSttModels(
			models,
			ctx({
				filters: filters({ fitsHardwareOnly: true }),
				statesById: {
					c: entry({ id: "c", comfortable_on_cpu: true, comfortable_on_gpu: false }),
				},
				systemInfo: sys(0),
			})
		);
		expect(out.map((m) => m.id)).toEqual(["c"]);
	});

	test("realtimeOnly drops heavy models", () => {
		const models = [
			model({ id: "tiny", sizeLabel: "39M" }),
			model({ id: "large", sizeLabel: "1.5B" }),
		];
		const out = filterSttModels(models, ctx({ filters: filters({ realtimeOnly: true }) }));
		expect(out.map((m) => m.id)).toEqual(["tiny"]);
	});

	test("fitsHardwareOnly drops models that fit nowhere", () => {
		const models = [model({ id: "fits" }), model({ id: "huge" })];
		const out = filterSttModels(
			models,
			ctx({
				filters: filters({ fitsHardwareOnly: true }),
				statesById: {
					fits: entry({ id: "fits", comfortable_on_cpu: true }),
					huge: entry({
						id: "huge",
						estimated_bytes: 9_000_000_000,
						comfortable_on_cpu: false,
						comfortable_on_gpu: false,
					}),
				},
				systemInfo: sys(0),
			})
		);
		expect(out.map((m) => m.id)).toEqual(["fits"]);
	});

	test("language filter keeps models supporting any selected language", () => {
		const models = [
			model({ id: "en", languages: ["en"] }),
			model({ id: "de", languages: ["de"] }),
			model({ id: "multi", languages: [] }),
		];
		const out = filterSttModels(models, ctx({ filters: filters({ languages: ["en"] }) }));
		expect(out.map((m) => m.id).sort()).toEqual(["en", "multi"]);
	});

	test("combines multiple active filters (all must pass)", () => {
		const models = [
			model({ id: "good", sizeLabel: "39M", languages: ["en"] }),
			model({ id: "bad-lang", sizeLabel: "39M", languages: ["de"] }),
		];
		const out = filterSttModels(
			models,
			ctx({
				filters: filters({ realtimeOnly: true, languages: ["en"] }),
				statesById: {
					good: entry({ id: "good" }),
					"bad-lang": entry({ id: "bad-lang" }),
				},
			})
		);
		expect(out.map((m) => m.id)).toEqual(["good"]);
	});
});

describe("formatLanguageCoverage", () => {
	test("multilingual when there are no explicit languages", () => {
		expect(formatLanguageCoverage(model({ languages: [] }))).toBe("Multilingual");
	});

	test("single language is upper-cased", () => {
		expect(formatLanguageCoverage(model({ languages: ["en"] }))).toBe("EN");
	});

	test("two or three languages are slash-joined", () => {
		expect(formatLanguageCoverage(model({ languages: ["en", "fr"] }))).toBe("EN/FR");
		expect(formatLanguageCoverage(model({ languages: ["en", "fr", "de"] }))).toBe("EN/FR/DE");
	});

	test("four or more languages collapse to first + count", () => {
		expect(formatLanguageCoverage(model({ languages: ["en", "fr", "de", "es"] }))).toBe("EN +3");
		expect(formatLanguageCoverage(model({ languages: ["en", "fr", "de", "es", "it"] }))).toBe(
			"EN +4"
		);
	});
});
