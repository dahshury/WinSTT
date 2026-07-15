import { describe, expect, test } from "bun:test";
import {
	LANGUAGE_MISMATCH_FACTOR,
	type MemoryBudgets,
	TTS_RUNTIME_HEADROOM,
} from "@/entities/model-suggestion";
import type { TtsModelStateEntry } from "@/shared/api/ipc-client";
import {
	buildTtsSuggestions,
	type TtsSuggestionCatalogModel,
	ttsModelMatchesPreferredLanguages,
} from "./tts-suggestions";

const GIB = 1024 ** 3;

function model(
	overrides: Partial<TtsSuggestionCatalogModel> &
		Pick<TtsSuggestionCatalogModel, "id">,
): TtsSuggestionCatalogModel {
	return {
		displayName: overrides.id,
		qualityScore: 0.7,
		speedScore: 0.7,
		languages: ["en-us"],
		availableQuantizations: ["fp16"],
		sizeBytesByQuantization: { fp16: 1 * GIB },
		...overrides,
	};
}

function state(
	overrides: Partial<TtsModelStateEntry> = {},
): TtsModelStateEntry {
	return {
		id: "m",
		cacheByQuantization: {},
		effectiveQuantization: "fp16",
		estimatedBytes: 0,
		...overrides,
	};
}

function budgets(overrides: Partial<MemoryBudgets> = {}): MemoryBudgets {
	return { hasGpu: false, ramBytes: 8 * GIB, vramBytes: 0, ...overrides };
}

describe("buildTtsSuggestions fit", () => {
	test("bytes = catalog size × runtime headroom against the accelerator's pool", () => {
		// 7 GiB disk × 1.2 headroom = 8.4 GiB > the 8 GiB RAM budget → hidden;
		// the same model against 10 GiB fits. Pins the ×1.2 rule from Part 3.3.
		const m = model({
			id: "big",
			sizeBytesByQuantization: { fp16: 7 * GIB },
		});
		const tight = buildTtsSuggestions({
			budgets: budgets({ ramBytes: 8 * GIB }),
			device: "cpu",
			models: [m],
			preferredLanguages: [],
			statesById: {},
		});
		expect(tight("big")?.visible).toBe(false);
		const roomy = buildTtsSuggestions({
			budgets: budgets({ ramBytes: Math.ceil(7 * GIB * TTS_RUNTIME_HEADROOM) }),
			device: "cpu",
			models: [m],
			preferredLanguages: [],
			statesById: {},
		});
		expect(roomy("big")?.visible).toBe(true);
		expect(roomy("big")?.fittingQuants.has("fp16")).toBe(true);
	});

	test("device = global accelerator: a GPU-routed model is judged against VRAM", () => {
		const m = model({ id: "v", sizeBytesByQuantization: { fp16: 4 * GIB } });
		const getSuggestion = buildTtsSuggestions({
			// Plenty of RAM, tiny VRAM — GPU routing must consult the VRAM pool.
			budgets: budgets({
				hasGpu: true,
				ramBytes: 32 * GIB,
				vramBytes: 2 * GIB,
			}),
			device: "gpu",
			models: [m],
			preferredLanguages: [],
			statesById: {},
		});
		expect(getSuggestion("v")?.visible).toBe(false);
	});

	test("a quant with no catalog size falls back to the state's estimatedBytes", () => {
		const m = model({ id: "est", sizeBytesByQuantization: {} });
		const getSuggestion = buildTtsSuggestions({
			budgets: budgets({ ramBytes: 8 * GIB }),
			device: "cpu",
			models: [m],
			preferredLanguages: [],
			statesById: { est: state({ id: "est", estimatedBytes: 10 * GIB }) },
		});
		expect(getSuggestion("est")?.visible).toBe(false);
	});

	test("unknown sizes everywhere stay leniently visible", () => {
		const m = model({ id: "unsized", sizeBytesByQuantization: {} });
		const getSuggestion = buildTtsSuggestions({
			budgets: budgets({ ramBytes: 0 }),
			device: "cpu",
			models: [m],
			preferredLanguages: [],
			statesById: {},
		});
		expect(getSuggestion("unsized")?.visible).toBe(true);
	});

	test("unknown model id returns null (no verdict)", () => {
		const getSuggestion = buildTtsSuggestions({
			budgets: budgets(),
			device: "cpu",
			models: [model({ id: "known" })],
			preferredLanguages: [],
			statesById: {},
		});
		expect(getSuggestion("mystery")).toBeNull();
	});
});

describe("buildTtsSuggestions language de-rank (Part 3.5)", () => {
	test("a language mismatch is DE-RANKED by the factor, never hidden", () => {
		const en = model({ id: "en-voice", languages: ["en-us"] });
		const ja = model({ id: "ja-voice", languages: ["ja"] });
		const getSuggestion = buildTtsSuggestions({
			budgets: budgets(),
			device: "cpu",
			models: [en, ja],
			preferredLanguages: ["en"],
			statesById: {},
		});
		const match = getSuggestion("en-voice");
		const mismatch = getSuggestion("ja-voice");
		// Both stay visible — the rule is a de-rank, not an exclusion.
		expect(match?.visible).toBe(true);
		expect(mismatch?.visible).toBe(true);
		// Identical specs, so the mismatch scores exactly factor × the match.
		expect(mismatch?.score).toBeCloseTo(
			(match?.score ?? 0) * LANGUAGE_MISMATCH_FACTOR,
			10,
		);
	});

	test("unreported languages and an empty preferred set never de-rank", () => {
		expect(ttsModelMatchesPreferredLanguages([], ["en"])).toBe(true);
		expect(ttsModelMatchesPreferredLanguages(["ja"], [])).toBe(true);
	});

	test("region-tagged codes normalize to the base language before matching", () => {
		expect(ttsModelMatchesPreferredLanguages(["en-us", "en-gb"], ["en"])).toBe(
			true,
		);
		expect(ttsModelMatchesPreferredLanguages(["pt-br"], ["pt"])).toBe(true);
		expect(ttsModelMatchesPreferredLanguages(["ja"], ["en", "fr"])).toBe(false);
	});
});
