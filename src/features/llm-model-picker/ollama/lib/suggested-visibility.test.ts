import { describe, expect, it } from "bun:test";
import type {
	OllamaLibraryTag,
	OllamaModel,
	RecommendedOllamaModel,
} from "@/shared/api/models";
import {
	anyShownQuantFits,
	installedModelSuggested,
	recommendedModelSuggested,
	sortRecommendedBySuggestedScore,
} from "./suggested-visibility";

const GB = 1024 ** 3;

/** Budget-aware fit stub: fits anything strictly under `limit` bytes. */
const fitsUnder = (limit: number) => (sizeBytes: number) =>
	sizeBytes <= 0 || sizeBytes < limit;

const gemmaTags: OllamaLibraryTag[] = [
	{ name: "gemma3:27b-fp16", parameterSize: "27b", sizeBytes: 54 * GB },
	{ name: "gemma3:27b-q8_0", parameterSize: "27b", sizeBytes: 29 * GB },
	{ name: "gemma3:27b-q4_K_M", parameterSize: "27b", sizeBytes: 17 * GB },
	// Non-canonical quant — pruned from the ladder, must not affect fit.
	{ name: "gemma3:27b-q2_K", parameterSize: "27b", sizeBytes: 10 * GB },
	{ name: "gemma3:4b-q4_K_M", parameterSize: "4b", sizeBytes: 2.5 * GB },
];

describe("anyShownQuantFits", () => {
	it("keeps a model whose big quants overflow but whose q4 fits (headline case)", () => {
		expect(
			anyShownQuantFits({
				fallbackSizeBytes: 54 * GB,
				fits: fitsUnder(20 * GB),
				paramSize: "27b",
				tags: gemmaTags,
			}),
		).toBe(true);
	});

	it("hides a model when NO canonical-ladder quant fits", () => {
		// q2_K (10 GB) would fit, but it's not on the canonical shelf ladder —
		// visibility and badge-gating must agree.
		expect(
			anyShownQuantFits({
				fallbackSizeBytes: 54 * GB,
				fits: fitsUnder(12 * GB),
				paramSize: "27b",
				tags: gemmaTags,
			}),
		).toBe(false);
	});

	it("only judges the card's own param size", () => {
		// The 4b sibling fits, but the 27b card must not ride on it.
		expect(
			anyShownQuantFits({
				fallbackSizeBytes: 54 * GB,
				fits: fitsUnder(3 * GB),
				paramSize: "27b",
				tags: gemmaTags,
			}),
		).toBe(false);
	});

	it("falls back to the single known size while tags aren't fetched", () => {
		expect(
			anyShownQuantFits({
				fallbackSizeBytes: 5 * GB,
				fits: fitsUnder(20 * GB),
				paramSize: "8b",
				tags: [],
			}),
		).toBe(true);
		expect(
			anyShownQuantFits({
				fallbackSizeBytes: 50 * GB,
				fits: fitsUnder(20 * GB),
				paramSize: "8b",
				tags: [],
			}),
		).toBe(false);
	});

	it("stays lenient on unknown sizes (fallback 0 and unsized tags)", () => {
		expect(
			anyShownQuantFits({
				fallbackSizeBytes: 0,
				fits: fitsUnder(1),
				paramSize: null,
				tags: [],
			}),
		).toBe(true);
		expect(
			anyShownQuantFits({
				fallbackSizeBytes: 99 * GB,
				fits: fitsUnder(1),
				paramSize: "27b",
				tags: [{ name: "x:27b-q4_K_M", parameterSize: "27b" }],
			}),
		).toBe(true);
	});
});

function installed(
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

describe("installedModelSuggested / recommendedModelSuggested", () => {
	it("uses the card's own size when no tag lookup is wired", () => {
		expect(
			installedModelSuggested(
				installed({ name: "big:27b", size: 50 * GB }),
				undefined,
				fitsUnder(20 * GB),
			),
		).toBe(false);
		expect(
			recommendedModelSuggested(
				recommended({ name: "small:1b", sizeBytes: GB }),
				undefined,
				fitsUnder(20 * GB),
			),
		).toBe(true);
	});

	it("rescues an oversized card once a fitting quant appears in the tag list", () => {
		expect(
			installedModelSuggested(
				installed({ name: "gemma3:27b-fp16", size: 54 * GB }),
				() => gemmaTags,
				fitsUnder(20 * GB),
			),
		).toBe(true);
	});

	it("is lenient on unknown sizes (delegates the 0-byte fallback to the fit test)", () => {
		// The leniency rule lives in the injected `fits` (engine `quantFits`:
		// `bytes <= 0` → true) — an unknown-size model must survive even the
		// tightest budget.
		expect(
			installedModelSuggested(
				installed({ name: "mystery" }),
				undefined,
				fitsUnder(1),
			),
		).toBe(true);
	});

	it("keeps the curated GPT-OSS exception visible when its MXFP4 build will not fit", () => {
		expect(
			recommendedModelSuggested(
				recommended({
					name: "gpt-oss:20b",
					paramSize: "20B",
					sizeBytes: 14 * GB,
				}),
				undefined,
				fitsUnder(10 * GB),
			),
		).toBe(true);
	});
});

describe("sortRecommendedBySuggestedScore", () => {
	it("orders best score first, name A→Z on ties", () => {
		const models = [
			recommended({ name: "c", displayName: "Charlie", sizeBytes: GB }),
			recommended({ name: "a", displayName: "alpha", sizeBytes: GB }),
			recommended({ name: "b", displayName: "Bravo", sizeBytes: GB }),
		];
		const score = (m: RecommendedOllamaModel) => (m.name === "b" ? 0.9 : 0.5);
		expect(
			sortRecommendedBySuggestedScore(models, score).map((m) => m.name),
		).toEqual(["b", "a", "c"]);
	});

	it("does not mutate the input", () => {
		const models = [
			recommended({ name: "a", sizeBytes: GB }),
			recommended({ name: "b", sizeBytes: GB }),
		];
		const snapshot = [...models];
		sortRecommendedBySuggestedScore(models, () => 1);
		expect(models).toEqual(snapshot);
	});
});
