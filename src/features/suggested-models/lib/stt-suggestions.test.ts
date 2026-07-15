import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import type { MemoryBudgets } from "@/entities/model-suggestion";
import type { ModelStateEntry } from "@/shared/api/ipc-client";
import { buildSttSuggestions } from "./stt-suggestions";

const GIB = 1024 ** 3;

function model(
	overrides: Partial<ModelInfo> & Pick<ModelInfo, "id">,
): ModelInfo {
	const { id, ...rest } = overrides;
	return {
		id,
		displayName: id,
		family: "whisper",
		languages: [],
		supportsLanguageDetection: true,
		sizeLabel: "100M",
		previewCapable: true,
		nativeStreaming: false,
		finalReuseSafe: false,
		onnxModelName: null,
		description: "",
		availableQuantizations: ["", "int8"],
		sizeBytesByQuantization: {},
		available: true,
		errorMessage: "",
		localPath: null,
		speedScore: 0.6,
		accuracyScore: 0.6,
		...rest,
	} as ModelInfo;
}

function state(overrides: Partial<ModelStateEntry> = {}): ModelStateEntry {
	return {
		id: "m",
		estimated_bytes: 0,
		comfortable_on_cpu: true,
		comfortable_on_gpu: true,
		available_quantizations: ["", "int8"],
		cache_by_quantization: {},
		cache: {
			state: "not_cached",
			downloaded_bytes: 0,
			progress: 0,
			total_bytes: 0,
		},
		...overrides,
	};
}

function budgets(overrides: Partial<MemoryBudgets> = {}): MemoryBudgets {
	return { hasGpu: false, ramBytes: 8 * GIB, vramBytes: 0, ...overrides };
}

describe("buildSttSuggestions", () => {
	test("a model too big at fp32 but fitting at int8 stays visible with int8-only badges", () => {
		// 10 GiB fp32 baseline against an 8 GiB RAM budget: fp32 (×1) misses,
		// int8 (×0.3-ish scaling via estimateForQuant) fits — the headline
		// per-quant re-check the legacy comfortable_on_* path never did.
		const m = model({ id: "big" });
		const getSuggestion = buildSttSuggestions({
			budgets: budgets(),
			models: [m],
			statesById: { big: state({ id: "big", estimated_bytes: 10 * GIB }) },
		});
		const verdict = getSuggestion("big");
		expect(verdict?.visible).toBe(true);
		expect(verdict?.fittingQuants.has("int8")).toBe(true);
		expect(verdict?.fittingQuants.has("")).toBe(false);
		expect(verdict?.bestQuant).toBe("int8");
	});

	test("a model with NO fitting quant reports visible=false", () => {
		const m = model({ id: "huge", availableQuantizations: [""] });
		const getSuggestion = buildSttSuggestions({
			budgets: budgets({ ramBytes: 1 * GIB }),
			models: [m],
			statesById: { huge: state({ id: "huge", estimated_bytes: 10 * GIB }) },
		});
		expect(getSuggestion("huge")?.visible).toBe(false);
	});

	test("unknown footprint (no state entry) stays leniently visible", () => {
		const m = model({ id: "unsized" });
		const getSuggestion = buildSttSuggestions({
			budgets: budgets({ ramBytes: 0 }),
			models: [m],
			statesById: {},
		});
		expect(getSuggestion("unsized")?.visible).toBe(true);
	});

	test("language rule: a model that can't transcribe the selected source language is excluded", () => {
		const ru = model({
			id: "ru-only",
			languages: ["ru"],
			supportsLanguageDetection: false,
		});
		const multi = model({ id: "multi", languages: [] });
		const getSuggestion = buildSttSuggestions({
			budgets: budgets(),
			models: [ru, multi],
			sourceLanguageSelection: {
				autoDetectLanguage: false,
				language: "en",
				languageCandidates: [],
			},
			statesById: {},
		});
		expect(getSuggestion("ru-only")?.visible).toBe(false);
		// Multilingual/unknown always passes.
		expect(getSuggestion("multi")?.visible).toBe(true);
		// The fit facts survive the language exclusion (badges stay meaningful
		// when the card surfaces with the filter off).
		expect(getSuggestion("ru-only")?.fittingQuants.size).toBeGreaterThan(0);
	});

	test("languageCandidates outrank the pinned language", () => {
		const ru = model({
			id: "ru-only",
			languages: ["ru"],
			supportsLanguageDetection: false,
		});
		const getSuggestion = buildSttSuggestions({
			budgets: budgets(),
			models: [ru],
			sourceLanguageSelection: {
				autoDetectLanguage: false,
				language: "en",
				languageCandidates: ["ru"],
			},
			statesById: {},
		});
		expect(getSuggestion("ru-only")?.visible).toBe(true);
	});

	test("unknown model id returns null (no verdict)", () => {
		const getSuggestion = buildSttSuggestions({
			budgets: budgets(),
			models: [model({ id: "known" })],
			statesById: {},
		});
		expect(getSuggestion("mystery")).toBeNull();
	});
});
