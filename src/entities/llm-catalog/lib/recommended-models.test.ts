import { describe, expect, test } from "bun:test";
import {
	findRecommendedModel,
	RECOMMENDED_OLLAMA_MODELS,
} from "./recommended-models";

// Tags the OpenAPI `RecommendedOllamaModel` schema describes as free-form, but
// the curated catalog only ever uses this closed vocabulary. A typo (e.g.
// "instuct") would silently break the UI filter chips that key off these tags,
// so we lock the allowed set here.
const ALLOWED_TAGS = new Set(["fast", "tiny", "instruct", "recommended"]);

describe("RECOMMENDED_OLLAMA_MODELS contract", () => {
	test("is a non-empty list", () => {
		expect(RECOMMENDED_OLLAMA_MODELS.length).toBeGreaterThan(0);
	});

	test("every entry has a non-empty name, displayName, paramSize and description", () => {
		for (const model of RECOMMENDED_OLLAMA_MODELS) {
			expect(model.name.length).toBeGreaterThan(0);
			expect(model.displayName.length).toBeGreaterThan(0);
			expect(model.paramSize.length).toBeGreaterThan(0);
			expect(model.description.length).toBeGreaterThan(0);
		}
	});

	test("every sizeBytes is a finite positive integer", () => {
		for (const model of RECOMMENDED_OLLAMA_MODELS) {
			expect(Number.isFinite(model.sizeBytes)).toBe(true);
			expect(Number.isInteger(model.sizeBytes)).toBe(true);
			expect(model.sizeBytes).toBeGreaterThan(0);
		}
	});

	test("sizeBytes is produced via Math.round (no fractional bytes leak through)", () => {
		// The source builds sizeBytes as Math.round(x * GB). Guard against a
		// regression that drops the round() and ships a float byte count, which
		// would render as e.g. "1300000000.0000002 bytes" in size formatters.
		for (const model of RECOMMENDED_OLLAMA_MODELS) {
			expect(model.sizeBytes).toBe(Math.round(model.sizeBytes));
		}
	});

	test("a representative sizeBytes matches the documented GB math", () => {
		// llama3.2:1b is Math.round(1.3 * 1_000_000_000).
		const llama1b = findRecommendedModel("llama3.2:1b");
		expect(llama1b?.sizeBytes).toBe(Math.round(1.3 * 1_000_000_000));
		// smollm2:135m is the smallest; ~0.27 GB.
		const smol = findRecommendedModel("smollm2:135m");
		expect(smol?.sizeBytes).toBe(Math.round(0.27 * 1_000_000_000));
	});

	test("model names are unique (catalog has no dupes)", () => {
		const names = RECOMMENDED_OLLAMA_MODELS.map((m) => m.name);
		expect(new Set(names).size).toBe(names.length);
	});

	test("displayNames are unique", () => {
		const labels = RECOMMENDED_OLLAMA_MODELS.map((m) => m.displayName);
		expect(new Set(labels).size).toBe(labels.length);
	});

	test("every model has a NON-EMPTY tag list, all from the allowed vocabulary", () => {
		for (const model of RECOMMENDED_OLLAMA_MODELS) {
			const tags = model.tags ?? [];
			// Non-empty guard: tags drive the UI filter chips, so an empty list
			// silently drops the model from every filter. (Mutation testing flagged
			// this — emptying any model's tags array `→ []` previously survived
			// because the vocabulary loop below passes vacuously on `[]`.)
			expect(tags.length).toBeGreaterThan(0);
			for (const tag of tags) {
				expect(ALLOWED_TAGS.has(tag)).toBe(true);
			}
		}
	});

	test("every entry carries a family label", () => {
		for (const model of RECOMMENDED_OLLAMA_MODELS) {
			expect(typeof model.family).toBe("string");
			expect((model.family ?? "").length).toBeGreaterThan(0);
		}
	});

	test("at least one model is tagged 'recommended' (default-pick surface)", () => {
		const recommended = RECOMMENDED_OLLAMA_MODELS.filter((m) =>
			m.tags?.includes("recommended"),
		);
		expect(recommended.length).toBeGreaterThan(0);
	});

	test("the 'tiny' tag tracks parameter count, NOT disk size", () => {
		// NOTE: "tiny" is NOT a disk-size promise. llama3.2:1b is tagged "tiny"
		// (1.2B params) yet weighs 1.3 GB on disk — more than several non-tiny
		// entries (e.g. granite4.1:3b at 2.1 GB IS larger but is the bigger model).
		// So the only invariant we can assert is that every "tiny" model is
		// small by parameter label. Anyone reading the tag as "small download"
		// would be misled — flagged as a UX wart, not asserted as a size bound.
		const tiny = RECOMMENDED_OLLAMA_MODELS.filter((m) =>
			m.tags?.includes("tiny"),
		);
		expect(tiny.length).toBeGreaterThan(0);
		// llama3.2:1b is the proof that tiny != small-on-disk.
		const llama1b = tiny.find((m) => m.name === "llama3.2:1b");
		expect(llama1b).toBeDefined();
		expect(llama1b?.sizeBytes).toBeGreaterThan(1_000_000_000);
	});

	test("offers the requested Gemma 4 local variants", () => {
		const gemmaNames = RECOMMENDED_OLLAMA_MODELS.filter(
			(m) => m.family === "gemma",
		).map((m) => m.name);
		expect(gemmaNames).toEqual(["gemma4:e2b", "gemma4:e4b", "gemma4:12b"]);
	});

	test("offers every SmolLM 2 library size (135m → 1.7b)", () => {
		const smollmNames = RECOMMENDED_OLLAMA_MODELS.filter(
			(m) => m.family === "smollm",
		).map((m) => m.name);
		expect(smollmNames).toEqual([
			"smollm2:135m",
			"smollm2:360m",
			"smollm2:1.7b",
		]);
		const smol17b = findRecommendedModel("smollm2:1.7b");
		expect(smol17b?.displayName).toBe("SmolLM 2 1.7B");
		expect(smol17b?.sizeBytes).toBe(Math.round(1.8 * 1_000_000_000));
	});

	test("carries no SmolLM v1 (smollm) entries — only smollm2", () => {
		const v1 = RECOMMENDED_OLLAMA_MODELS.filter((m) =>
			m.name.startsWith("smollm:"),
		);
		expect(v1).toEqual([]);
	});

	test("offers the requested LFM2.5 Thinking model", () => {
		const lfm = findRecommendedModel("lfm2.5-thinking:1.2b");
		expect(lfm?.displayName).toBe("LFM2.5 Thinking 1.2B");
		expect(lfm?.family).toBe("lfm");
		expect(lfm?.sizeBytes).toBe(Math.round(0.731 * 1_000_000_000));
	});
});

describe("findRecommendedModel", () => {
	test("returns the matching entry by exact name", () => {
		const found = findRecommendedModel("gemma4:12b");
		expect(found?.displayName).toBe("Gemma 4 12B");
		expect(found?.family).toBe("gemma");
	});

	test("returns the SAME object reference as the catalog entry (no clone)", () => {
		const fromCatalog = RECOMMENDED_OLLAMA_MODELS.find(
			(m) => m.name === "phi4-mini:3.8b",
		);
		expect(findRecommendedModel("phi4-mini:3.8b")).toBe(fromCatalog);
	});

	test("returns undefined for an unknown name", () => {
		expect(findRecommendedModel("does-not-exist:99b")).toBeUndefined();
	});

	test("returns undefined for the empty string", () => {
		expect(findRecommendedModel("")).toBeUndefined();
	});

	test("is case-sensitive (exact match only)", () => {
		// `.find` uses ===, so casing must match exactly.
		expect(findRecommendedModel("LLAMA3.2:1B")).toBeUndefined();
		expect(findRecommendedModel("llama3.2:1b")).toBeDefined();
	});

	test("round-trips every catalog name back to its own entry", () => {
		for (const model of RECOMMENDED_OLLAMA_MODELS) {
			expect(findRecommendedModel(model.name)).toBe(model);
		}
	});
});
