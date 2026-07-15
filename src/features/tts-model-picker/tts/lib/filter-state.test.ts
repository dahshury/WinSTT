import { describe, expect, test } from "bun:test";
import type { TtsModelInfo, TtsModelState } from "@/entities/tts-catalog";
import {
	activeTtsFilterCount,
	collectTtsLanguages,
	collectTtsQuantizations,
	EMPTY_TTS_FILTER_STATE,
	filterTtsModels,
	hasActiveTtsFilters,
	isTtsFilterState,
	normalizeTtsFilterState,
	type PersistedTtsFilterState,
} from "./filter-state";

function model(overrides: Partial<TtsModelInfo>): TtsModelInfo {
	return {
		available: true,
		availableQuantizations: ["fp16"],
		cloning: "none",
		description: "",
		displayName: "Model",
		engine: "kokoro",
		id: "model",
		languages: ["en"],
		maker: "Maker",
		numVoices: 1,
		paramCountM: 1,
		qualityScore: 0.5,
		sampleRate: 24_000,
		sizeBytesByQuantization: {},
		sizeLabel: "",
		speedScore: 0.5,
		voiceDesign: false,
		...overrides,
	};
}

const MODELS = [
	model({ id: "fixed", displayName: "Fixed English" }),
	model({
		id: "clone",
		displayName: "Clone Multilingual",
		cloning: "zero_shot_audio",
		languages: ["en", "fr"],
		availableQuantizations: ["int8"],
	}),
	model({
		id: "design",
		displayName: "Voice Design",
		voiceDesign: true,
		available: false,
	}),
];

const CACHED_STATE: TtsModelState = {
	id: "clone",
	cacheByQuantization: {
		int8: {
			downloadedBytes: 100,
			progress: 1,
			state: "cached",
			totalBytes: 100,
		},
	},
	effectiveQuantization: "int8",
	estimatedBytes: 100,
};

describe("TTS filter state", () => {
	test("filters every TTS-specific capability and catalog dimension", () => {
		expect(
			filterTtsModels(
				MODELS,
				{
					...EMPTY_TTS_FILTER_STATE,
					availableOnly: true,
					cachedOnly: true,
					cloningOnly: true,
					languages: ["fr"],
					multilingualOnly: true,
					quantizations: ["int8"],
				},
				{ clone: CACHED_STATE },
			).map((entry) => entry.id),
		).toEqual(["clone"]);

		expect(
			filterTtsModels(
				MODELS,
				{ ...EMPTY_TTS_FILTER_STATE, voiceDesignOnly: true },
				{},
			).map((entry) => entry.id),
		).toEqual(["design"]);
	});

	test("collects dynamic language and precision options", () => {
		expect(collectTtsLanguages(MODELS)).toEqual(["en", "fr"]);
		expect(collectTtsQuantizations(MODELS)).toEqual(["fp16", "int8"]);
	});

	test("counts flags and multi-select values for the trigger badge", () => {
		expect(
			activeTtsFilterCount({
				...EMPTY_TTS_FILTER_STATE,
				cachedOnly: true,
				languages: ["en", "fr"],
				quantizations: ["int8"],
			}),
		).toBe(4);
	});
});

describe("suggestedOnly filter", () => {
	test("EMPTY_TTS_FILTER_STATE defaults suggestedOnly to ON", () => {
		expect(EMPTY_TTS_FILTER_STATE.suggestedOnly).toBe(true);
	});

	test("suggestedOnly does NOT count as an active filter (default-on flag)", () => {
		expect(activeTtsFilterCount(EMPTY_TTS_FILTER_STATE)).toBe(0);
		expect(hasActiveTtsFilters(EMPTY_TTS_FILTER_STATE)).toBe(false);
	});

	test("hides models the suggested predicate rejects while ON", () => {
		const hideClone = (m: { id: string }) => m.id !== "clone";
		expect(
			filterTtsModels(MODELS, EMPTY_TTS_FILTER_STATE, {}, hideClone).map(
				(m) => m.id,
			),
		).toEqual(["fixed", "design"]);
	});

	test("explicit OFF is respected — the predicate is ignored", () => {
		const hideClone = (m: { id: string }) => m.id !== "clone";
		expect(
			filterTtsModels(
				MODELS,
				{ ...EMPTY_TTS_FILTER_STATE, suggestedOnly: false },
				{},
				hideClone,
			).map((m) => m.id),
		).toEqual(["fixed", "clone", "design"]);
	});

	test("no host verdict (predicate null/absent) leaves the flag inert", () => {
		expect(
			filterTtsModels(MODELS, EMPTY_TTS_FILTER_STATE, {}, null).length,
		).toBe(MODELS.length);
		expect(filterTtsModels(MODELS, EMPTY_TTS_FILTER_STATE, {}).length).toBe(
			MODELS.length,
		);
	});

	test("composes with the other filters", () => {
		const hideClone = (m: { id: string }) => m.id !== "clone";
		expect(
			filterTtsModels(
				MODELS,
				{ ...EMPTY_TTS_FILTER_STATE, multilingualOnly: true },
				{},
				hideClone,
			),
		).toEqual([]);
	});

	test("missing suggestedOnly defaults to true (pre-feature persisted blob)", () => {
		const persisted: PersistedTtsFilterState = {
			availableOnly: false,
			cachedOnly: true,
			cloningOnly: false,
			languages: ["en"],
			multilingualOnly: false,
			quantizations: [],
			voiceDesignOnly: false,
		};
		expect(normalizeTtsFilterState(persisted)).toEqual({
			...persisted,
			suggestedOnly: true,
		});
	});

	test("an explicit persisted false survives normalization", () => {
		const persisted: PersistedTtsFilterState = {
			...EMPTY_TTS_FILTER_STATE,
			suggestedOnly: false,
		};
		expect(normalizeTtsFilterState(persisted).suggestedOnly).toBe(false);
	});

	test("the validator accepts a missing suggestedOnly but rejects a non-boolean one", () => {
		const base = {
			availableOnly: false,
			cachedOnly: false,
			cloningOnly: false,
			languages: [],
			multilingualOnly: false,
			quantizations: [],
			voiceDesignOnly: false,
		};
		expect(isTtsFilterState(base)).toBe(true);
		expect(isTtsFilterState({ ...base, suggestedOnly: true })).toBe(true);
		expect(isTtsFilterState({ ...base, suggestedOnly: "yes" })).toBe(false);
	});
});
