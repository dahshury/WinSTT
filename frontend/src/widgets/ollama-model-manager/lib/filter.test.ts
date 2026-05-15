import { describe, expect, test } from "bun:test";
import type { OllamaModel, RecommendedOllamaModel } from "@/shared/api/models";
import {
	filterInstalledModels,
	filterRecommendedModels,
	formatGigabytes,
	isCustomModelQuery,
	matchesQuery,
	matchesRecommended,
	normalizeQuery,
} from "./filter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInstalled(name: string, size = 0): OllamaModel {
	return { name, size };
}

function makeRecommended(overrides: Partial<RecommendedOllamaModel> = {}): RecommendedOllamaModel {
	return {
		name: "llama3.2:1b",
		displayName: "Llama 3.2 1B",
		paramSize: "1.2B",
		sizeBytes: 1_200_000_000,
		description: "A small but capable language model.",
		tags: ["fast", "tiny"],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// normalizeQuery
// ---------------------------------------------------------------------------

describe("normalizeQuery", () => {
	test("trims whitespace", () => {
		expect(normalizeQuery("  hello  ")).toBe("hello");
	});

	test("lowercases", () => {
		expect(normalizeQuery("Llama")).toBe("llama");
	});

	test("empty string stays empty", () => {
		expect(normalizeQuery("")).toBe("");
	});

	test("trims and lowercases combined", () => {
		expect(normalizeQuery("  LLAMA 3  ")).toBe("llama 3");
	});
});

// ---------------------------------------------------------------------------
// matchesQuery
// ---------------------------------------------------------------------------

describe("matchesQuery", () => {
	test("returns true when needle is empty", () => {
		expect(matchesQuery("anything", "")).toBe(true);
	});

	test("returns true for exact match (case-insensitive)", () => {
		expect(matchesQuery("Llama3", "llama3")).toBe(true);
	});

	test("returns true for partial match", () => {
		expect(matchesQuery("llama3.2:1b", "3.2")).toBe(true);
	});

	test("returns false when not contained", () => {
		expect(matchesQuery("gemma:7b", "llama")).toBe(false);
	});

	test("haystack comparison is case-insensitive", () => {
		expect(matchesQuery("LLAMA", "llama")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// filterInstalledModels
// ---------------------------------------------------------------------------

describe("filterInstalledModels", () => {
	const models: OllamaModel[] = [
		makeInstalled("llama3.2:1b"),
		makeInstalled("gemma3:4b"),
		makeInstalled("qwen3:1.7b"),
	];

	test("returns all models when query is empty", () => {
		expect(filterInstalledModels(models, "")).toHaveLength(3);
	});

	test("returns all models when query is only whitespace", () => {
		expect(filterInstalledModels(models, "   ")).toHaveLength(3);
	});

	test("filters by partial name match", () => {
		const result = filterInstalledModels(models, "llama");
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("llama3.2:1b");
	});

	test("is case-insensitive", () => {
		expect(filterInstalledModels(models, "GEMMA")).toHaveLength(1);
	});

	test("returns empty array when nothing matches", () => {
		expect(filterInstalledModels(models, "phi")).toHaveLength(0);
	});

	test("returns a new array (does not mutate)", () => {
		const result = filterInstalledModels(models, "");
		expect(result).not.toBe(models);
	});
});

// ---------------------------------------------------------------------------
// matchesRecommended
// ---------------------------------------------------------------------------

describe("matchesRecommended", () => {
	const installed = new Set(["llama3.2:1b"]);

	test("excludes model that is already installed", () => {
		const m = makeRecommended({ name: "llama3.2:1b" });
		expect(matchesRecommended(m, installed, "")).toBe(false);
	});

	test("includes model when query is empty and not installed", () => {
		const m = makeRecommended({ name: "gemma3:4b" });
		expect(matchesRecommended(m, installed, "")).toBe(true);
	});

	test("matches on name", () => {
		const m = makeRecommended({ name: "gemma3:4b", displayName: "Gemma 3 4B" });
		expect(matchesRecommended(m, new Set(), "gemma")).toBe(true);
	});

	test("matches on displayName (query is already normalized)", () => {
		const m = makeRecommended({ name: "gemma3:4b", displayName: "Gemma 3 4B" });
		// matchesRecommended receives a pre-normalized (lowercased) query
		expect(matchesRecommended(m, new Set(), "gemma 3")).toBe(true);
	});

	test("matches on description", () => {
		const m = makeRecommended({ description: "A fast model for code generation." });
		expect(matchesRecommended(m, new Set(), "code")).toBe(true);
	});

	test("matches on tags", () => {
		const m = makeRecommended({ tags: ["instruct", "fast"] });
		expect(matchesRecommended(m, new Set(), "instruct")).toBe(true);
	});

	test("returns false when no field matches the query", () => {
		const m = makeRecommended({
			name: "gemma3:4b",
			displayName: "Gemma 3 4B",
			description: "Google's compact model.",
			tags: ["compact"],
		});
		expect(matchesRecommended(m, new Set(), "llama")).toBe(false);
	});

	test("handles model with no tags (undefined)", () => {
		const m = makeRecommended({ tags: undefined, name: "gemma3:4b" });
		// With non-matching query, should only rely on name/displayName/description
		expect(matchesRecommended(m, new Set(), "xyz")).toBe(false);
		expect(matchesRecommended(m, new Set(), "gemma")).toBe(true);
	});

	test("undefined tags fall back to an EMPTY array (locks in the L28 `?? []` fallback)", () => {
		// Mutator-killer: Stryker's ArrayDeclaration mutant turns the
		// `?? []` fallback into `?? ["Stryker was here"]`. With that
		// mutant, getSearchableFields(model) acquires a phantom field
		// "Stryker was here" that the original code would never produce.
		// We craft inputs where the model deliberately does NOT match a
		// query containing "stryker" — and verify the result is `false`.
		// Under the mutant, the phantom field would match "stryker".
		const m = makeRecommended({
			name: "gemma3:4b",
			displayName: "Gemma 3 4B",
			description: "A small but capable language model.",
			tags: undefined,
		});
		expect(matchesRecommended(m, new Set(), "stryker")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// filterRecommendedModels
// ---------------------------------------------------------------------------

describe("filterRecommendedModels", () => {
	const models: RecommendedOllamaModel[] = [
		makeRecommended({ name: "llama3.2:1b", displayName: "Llama 3.2 1B", tags: ["tiny"] }),
		makeRecommended({ name: "gemma3:4b", displayName: "Gemma 3 4B", tags: ["fast"] }),
		makeRecommended({ name: "qwen3:1.7b", displayName: "Qwen 3 1.7B", tags: ["multilingual"] }),
	];

	test("returns all uninstalled models when query is empty", () => {
		const result = filterRecommendedModels(models, new Set(), "");
		expect(result).toHaveLength(3);
	});

	test("excludes models that are already installed", () => {
		const result = filterRecommendedModels(models, new Set(["llama3.2:1b"]), "");
		expect(result).toHaveLength(2);
		expect(result.some((m) => m.name === "llama3.2:1b")).toBe(false);
	});

	test("filters by display name query", () => {
		const result = filterRecommendedModels(models, new Set(), "Gemma");
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("gemma3:4b");
	});

	test("filters by tag query", () => {
		const result = filterRecommendedModels(models, new Set(), "multilingual");
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("qwen3:1.7b");
	});

	test("returns empty array when nothing matches", () => {
		expect(filterRecommendedModels(models, new Set(), "phi")).toHaveLength(0);
	});

	test("normalizes query before matching (case, trim)", () => {
		const result = filterRecommendedModels(models, new Set(), "  LLAMA  ");
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("llama3.2:1b");
	});
});

// ---------------------------------------------------------------------------
// isCustomModelQuery
// ---------------------------------------------------------------------------

describe("isCustomModelQuery", () => {
	test("returns false for empty string", () => {
		expect(isCustomModelQuery("")).toBe(false);
	});

	test("returns false for whitespace-only string", () => {
		expect(isCustomModelQuery("   ")).toBe(false);
	});

	test("returns true for valid model name with tag", () => {
		expect(isCustomModelQuery("qwen3:1.7b")).toBe(true);
	});

	test("returns true for plain model name", () => {
		expect(isCustomModelQuery("llama3")).toBe(true);
	});

	test("returns true for model with namespace/tag", () => {
		expect(isCustomModelQuery("myorg/mymodel:latest")).toBe(true);
	});

	test("returns false for names with spaces", () => {
		expect(isCustomModelQuery("my model")).toBe(false);
	});

	test("returns false for names with invalid characters", () => {
		expect(isCustomModelQuery("model@v1!")).toBe(false);
	});

	test("trims before validating", () => {
		expect(isCustomModelQuery("  qwen3:1.7b  ")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// formatGigabytes
// ---------------------------------------------------------------------------

describe("formatGigabytes", () => {
	test("formats 1 GB correctly", () => {
		expect(formatGigabytes(1_000_000_000)).toBe("1.0");
	});

	test("formats sub-GB to one decimal", () => {
		expect(formatGigabytes(500_000_000)).toBe("0.5");
	});

	test("formats 0", () => {
		expect(formatGigabytes(0)).toBe("0.0");
	});

	test("formats fractional GB", () => {
		expect(formatGigabytes(2_400_000_000)).toBe("2.4");
	});
});
