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
	normalizeSttFilterState,
	type SttFilterState,
} from "./filter-state";

function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
	return {
		id: "m",
		displayName: "Whisper Tiny",
		family: "whisper",
		languages: ["en"],
		supportsLanguageDetection: true,
		sizeLabel: "39M",
		previewCapable: true,
		nativeStreaming: false,
		finalReuseSafe: false,
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
		cache: {
			state: "not_cached",
			downloaded_bytes: 0,
			progress: 0,
			total_bytes: 1,
		},
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

function ctx(
	overrides: Partial<FilterModelsContext> = {},
): FilterModelsContext {
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
			activeFilterCount(
				filters({
					cachedOnly: true,
					realtimeOnly: true,
					fitsHardwareOnly: true,
				}),
			),
		).toBe(3);
	});

	test("adds the number of selected languages", () => {
		expect(activeFilterCount(filters({ languages: ["en", "fr"] }))).toBe(2);
		expect(
			activeFilterCount(filters({ realtimeOnly: true, languages: ["en"] })),
		).toBe(2);
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
		expect(
			modelSupportsLanguage(model({ languages: ["en", "fr"] }), "fr"),
		).toBe(true);
		expect(
			modelSupportsLanguage(model({ languages: ["en", "fr"] }), "de"),
		).toBe(false);
	});
});

describe("collectFilterableLanguages", () => {
	test("returns sorted distinct codes from constrained-language models", () => {
		const result = collectFilterableLanguages([
			model({ languages: ["fr", "en"], supportsLanguageDetection: false }),
			model({ languages: ["en", "de"], supportsLanguageDetection: false }),
			model({ languages: [], supportsLanguageDetection: false }),
		]);
		expect(result).toEqual(["de", "en", "fr"]);
	});

	test("skips multilingual models so the chip list doesn't blow up to 99 codes", () => {
		// Pre-fix, Whisper's 99-language whitelist would dump every code
		// into the filter menu. Multilingual models still match every chip
		// at filter time via modelSupportsLanguage, so the chip list only
		// needs to surface what the constrained-language specialists offer.
		const result = collectFilterableLanguages([
			model({
				id: "whisper-large",
				languages: ["en", "de", "fr", "ar", "zh"],
				supportsLanguageDetection: true,
			}),
			model({
				id: "gigaam",
				languages: ["ru"],
				supportsLanguageDetection: false,
			}),
		]);
		expect(result).toEqual(["ru"]);
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
		expect(
			filterSttModels(models, ctx({ searchQuery: "  TINY " })).map((m) => m.id),
		).toEqual(["a"]);
		expect(
			filterSttModels(models, ctx({ searchQuery: "nemo" })).map((m) => m.id),
		).toEqual(["nemo-x"]);
		expect(filterSttModels(models, ctx({ searchQuery: "zzz" }))).toHaveLength(
			0,
		);
	});

	test("search query fuzzy-matches typo'd compact version input", () => {
		const models = [
			model({
				id: "parakeet-version-3",
				displayName: "Parakeet version 3",
				family: "nemo",
			}),
			model({ id: "whisper", displayName: "Whisper" }),
		];

		expect(
			filterSttModels(models, ctx({ searchQuery: "Parkeet v3" })).map(
				(m) => m.id,
			),
		).toEqual(["parakeet-version-3"]);
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
						cache: {
							state: "cached",
							downloaded_bytes: 1,
							progress: 1,
							total_bytes: 1,
						},
					}),
				},
			}),
		);
		expect(out.map((m) => m.id)).toEqual(["a"]);
	});

	test("cachedOnly drops models with no state entry at all", () => {
		const models = [model({ id: "a" })];
		const out = filterSttModels(
			models,
			ctx({ filters: filters({ cachedOnly: true }), statesById: {} }),
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
			}),
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
					g: entry({
						id: "g",
						comfortable_on_cpu: false,
						comfortable_on_gpu: true,
					}),
				},
				systemInfo: sys(1),
			}),
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
			}),
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
					g: entry({
						id: "g",
						comfortable_on_cpu: false,
						comfortable_on_gpu: true,
					}),
				},
				systemInfo: sys(0),
			}),
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
					c: entry({
						id: "c",
						comfortable_on_cpu: true,
						comfortable_on_gpu: false,
					}),
				},
				systemInfo: sys(0),
			}),
		);
		expect(out.map((m) => m.id)).toEqual(["c"]);
	});

	test("fitsHardwareOnly judges CPU-routed models against RAM even on GPU hosts", () => {
		// Pool-selection bug (Part 2 finding 1): a CPU-pinned engine (Cohere,
		// Kaldi transducers) consumes RAM, never VRAM. On a big-RAM /
		// small-VRAM GPU machine it fits RAM but not VRAM — mere GPU presence
		// must not judge it against the VRAM pool and hide it.
		const models = [model({ id: "cpu-pinned" })];
		const out = filterSttModels(
			models,
			ctx({
				filters: filters({ fitsHardwareOnly: true }),
				statesById: {
					"cpu-pinned": entry({
						id: "cpu-pinned",
						effective_quantization: "",
						device_by_quantization: { "": "cpu" },
						comfortable_on_cpu: true,
						comfortable_on_gpu: false,
					}),
				},
				systemInfo: sys(1),
			}),
		);
		expect(out.map((m) => m.id)).toEqual(["cpu-pinned"]);
	});

	test("fitsHardwareOnly drops CPU-routed models that only fit VRAM", () => {
		// Inverse of the above: big-VRAM / small-RAM box. A CPU-routed model
		// that would only fit the GPU pool must NOT be wrongly included.
		const models = [model({ id: "cpu-pinned" })];
		const out = filterSttModels(
			models,
			ctx({
				filters: filters({ fitsHardwareOnly: true }),
				statesById: {
					"cpu-pinned": entry({
						id: "cpu-pinned",
						effective_quantization: "",
						device_by_quantization: { "": "cpu" },
						comfortable_on_cpu: false,
						comfortable_on_gpu: true,
					}),
				},
				systemInfo: sys(1),
			}),
		);
		expect(out).toHaveLength(0);
	});

	test("fitsHardwareOnly honors a gpu routing verdict from the server", () => {
		const models = [model({ id: "gpu-routed" })];
		const out = filterSttModels(
			models,
			ctx({
				filters: filters({ fitsHardwareOnly: true }),
				statesById: {
					"gpu-routed": entry({
						id: "gpu-routed",
						effective_quantization: "fp16",
						device_by_quantization: { fp16: "gpu", int8: "cpu" },
						comfortable_on_cpu: false,
						comfortable_on_gpu: true,
					}),
				},
				systemInfo: sys(1),
			}),
		);
		expect(out.map((m) => m.id)).toEqual(["gpu-routed"]);
	});

	test("fitsHardwareOnly falls back to the quant heuristic for older servers", () => {
		// No device_by_quantization (older server): a non-fp quant (int8)
		// can't run on the GPU EP → judged against RAM even with a GPU.
		const models = [model({ id: "int8-model" }), model({ id: "fp-model" })];
		const out = filterSttModels(
			models,
			ctx({
				filters: filters({ fitsHardwareOnly: true }),
				statesById: {
					"int8-model": entry({
						id: "int8-model",
						effective_quantization: "int8",
						comfortable_on_cpu: true,
						comfortable_on_gpu: false,
					}),
					"fp-model": entry({
						id: "fp-model",
						effective_quantization: "fp16",
						comfortable_on_cpu: false,
						comfortable_on_gpu: true,
					}),
				},
				systemInfo: sys(1),
			}),
		);
		expect(out.map((m) => m.id).sort()).toEqual(["fp-model", "int8-model"]);
	});

	test("realtimeOnly keeps only native-streaming models", () => {
		const models = [
			model({ id: "fast-non-streaming", nativeStreaming: false }),
			model({
				id: "heavy-streaming",
				nativeStreaming: true,
				previewCapable: false,
				sizeLabel: "1.5B",
			}),
		];
		const out = filterSttModels(
			models,
			ctx({ filters: filters({ realtimeOnly: true }) }),
		);
		expect(out.map((m) => m.id)).toEqual(["heavy-streaming"]);
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
			}),
		);
		expect(out.map((m) => m.id)).toEqual(["fits"]);
	});

	test("language filter keeps models supporting any selected language", () => {
		const models = [
			model({ id: "en", languages: ["en"] }),
			model({ id: "de", languages: ["de"] }),
			model({ id: "multi", languages: [] }),
		];
		const out = filterSttModels(
			models,
			ctx({ filters: filters({ languages: ["en"] }) }),
		);
		expect(out.map((m) => m.id).sort()).toEqual(["en", "multi"]);
	});

	test("combines multiple active filters (all must pass)", () => {
		const models = [
			model({
				id: "good",
				sizeLabel: "39M",
				languages: ["en"],
				nativeStreaming: true,
			}),
			model({
				id: "bad-lang",
				sizeLabel: "39M",
				languages: ["de"],
				nativeStreaming: true,
			}),
		];
		const out = filterSttModels(
			models,
			ctx({
				filters: filters({ realtimeOnly: true, languages: ["en"] }),
				statesById: {
					good: entry({ id: "good" }),
					"bad-lang": entry({ id: "bad-lang" }),
				},
			}),
		);
		expect(out.map((m) => m.id)).toEqual(["good"]);
	});
});

describe("formatLanguageCoverage", () => {
	test("multilingual when there are no explicit languages", () => {
		expect(formatLanguageCoverage(model({ languages: [] }))).toBe(
			"Multilingual",
		);
	});

	test("single language is upper-cased", () => {
		expect(formatLanguageCoverage(model({ languages: ["en"] }))).toBe("EN");
	});

	test("multiple listed languages collapse to multilingual", () => {
		expect(formatLanguageCoverage(model({ languages: ["en", "fr"] }))).toBe(
			"Multilingual",
		);
		expect(
			formatLanguageCoverage(model({ languages: ["en", "fr", "de"] })),
		).toBe("Multilingual");
		expect(
			formatLanguageCoverage(model({ languages: ["en", "fr", "de", "es"] })),
		).toBe("Multilingual");
	});
});

describe("suggestedOnly filter", () => {
	const hideB = (m: ModelInfo) => m.id !== "b";

	test("EMPTY_FILTER_STATE defaults suggestedOnly to ON", () => {
		expect(EMPTY_FILTER_STATE.suggestedOnly).toBe(true);
	});

	test("suggestedOnly does NOT count as an active filter (default-on flag)", () => {
		// It has its own always-visible chip; counting it would permanently
		// badge the filter trigger in the default state.
		expect(activeFilterCount(filters({ suggestedOnly: true }))).toBe(0);
		expect(hasActiveFilters(filters({ suggestedOnly: true }))).toBe(false);
	});

	test("hides models the host predicate rejects while ON", () => {
		const models = [model({ id: "a" }), model({ id: "b" })];
		const out = filterSttModels(
			models,
			ctx({ filters: filters({ suggestedOnly: true }), suggested: hideB }),
		);
		expect(out.map((m) => m.id)).toEqual(["a"]);
	});

	test("inert when the flag is OFF even with a predicate wired", () => {
		const models = [model({ id: "a" }), model({ id: "b" })];
		const out = filterSttModels(
			models,
			ctx({ filters: filters({ suggestedOnly: false }), suggested: hideB }),
		);
		expect(out).toHaveLength(2);
	});

	test("inert when the host provides no predicate (budgets not loaded)", () => {
		const models = [model({ id: "a" }), model({ id: "b" })];
		const out = filterSttModels(
			models,
			ctx({ filters: filters({ suggestedOnly: true }), suggested: null }),
		);
		expect(out).toHaveLength(2);
	});

	test("composes with cachedOnly, language, and search (all must pass)", () => {
		const models = [
			model({ id: "good", displayName: "Tiny EN", languages: ["en"] }),
			model({ id: "unfit", displayName: "Tiny EN Big", languages: ["en"] }),
			model({ id: "uncached", displayName: "Tiny EN Two", languages: ["en"] }),
			model({ id: "wrong-lang", displayName: "Tiny DE", languages: ["de"] }),
		];
		const cachedEntry = (id: string) =>
			entry({
				id,
				cache: {
					state: "cached",
					downloaded_bytes: 1,
					progress: 1,
					total_bytes: 1,
				},
			});
		const out = filterSttModels(
			models,
			ctx({
				filters: filters({
					cachedOnly: true,
					suggestedOnly: true,
					languages: ["en"],
				}),
				searchQuery: "tiny",
				statesById: {
					good: cachedEntry("good"),
					unfit: cachedEntry("unfit"),
					"wrong-lang": cachedEntry("wrong-lang"),
				},
				suggested: (m) => m.id !== "unfit",
			}),
		);
		expect(out.map((m) => m.id)).toEqual(["good"]);
	});

	test("composes with realtimeOnly (the realtime picker's locked flag)", () => {
		const models = [
			model({ id: "stream-fit", nativeStreaming: true }),
			model({ id: "stream-unfit", nativeStreaming: true }),
			model({ id: "batch-fit", nativeStreaming: false }),
		];
		const out = filterSttModels(
			models,
			ctx({
				filters: filters({ realtimeOnly: true, suggestedOnly: true }),
				suggested: (m) => m.id !== "stream-unfit",
			}),
		);
		expect(out.map((m) => m.id)).toEqual(["stream-fit"]);
	});
});

describe("normalizeSttFilterState", () => {
	test("missing suggestedOnly defaults to true (pre-feature persisted blob)", () => {
		const persisted = {
			cachedOnly: true,
			fitsHardwareOnly: false,
			realtimeOnly: false,
			languages: ["en"],
		};
		expect(normalizeSttFilterState(persisted)).toEqual({
			...persisted,
			suggestedOnly: true,
		});
	});

	test("an explicit false survives normalization (user turned it off)", () => {
		const persisted = {
			cachedOnly: false,
			fitsHardwareOnly: false,
			realtimeOnly: false,
			languages: [],
			suggestedOnly: false,
		};
		expect(normalizeSttFilterState(persisted).suggestedOnly).toBe(false);
	});
});
