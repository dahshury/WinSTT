import { describe, expect, test } from "bun:test";
import type { OpenRouterModel } from "@/shared/api/models";
import {
	computeModelExclusionConfig,
	filterModelsForFallback,
	isAutoModel,
	isEndpointExcluded,
	isFallbackExcluded,
	OPENROUTER_AUTO_MODEL_ID,
} from "./model-exclusion";

const models: OpenRouterModel[] = [
	{ id: "openai/gpt-4o", name: "GPT-4o", endpoints: [] },
	{ id: "anthropic/claude-3", name: "Claude 3", endpoints: [] },
	{ id: OPENROUTER_AUTO_MODEL_ID, name: "Auto", endpoints: [] },
] as unknown as OpenRouterModel[];

describe("OPENROUTER_AUTO_MODEL_ID", () => {
	test("is the canonical 'openrouter/auto' identifier (mutator-killer for the string literal)", () => {
		expect(OPENROUTER_AUTO_MODEL_ID).toBe("openrouter/auto");
	});
});

describe("isAutoModel", () => {
	test.each([
		["", true],
		[null, true],
		[undefined, true],
		["   ", true],
		[OPENROUTER_AUTO_MODEL_ID, true],
		[`${OPENROUTER_AUTO_MODEL_ID}@deepinfra`, true],
		["openai/gpt-4o", false],
		["openai/gpt-4o@deepinfra", false],
	])("isAutoModel(%p) → %p", (input, expected) => {
		expect(isAutoModel(input)).toBe(expected);
	});
});

describe("computeModelExclusionConfig", () => {
	test("returns no exclusion when primary is auto / empty", () => {
		expect(computeModelExclusionConfig(null)).toEqual({
			excludedModelId: undefined,
			excludeAllProviders: false,
			excludedProviderSlug: undefined,
		});
		expect(computeModelExclusionConfig("")).toEqual({
			excludedModelId: undefined,
			excludeAllProviders: false,
			excludedProviderSlug: undefined,
		});
		expect(computeModelExclusionConfig(OPENROUTER_AUTO_MODEL_ID)).toEqual({
			excludedModelId: undefined,
			excludeAllProviders: false,
			excludedProviderSlug: undefined,
		});
	});

	test("model only → exclude all providers of that model", () => {
		expect(computeModelExclusionConfig("openai/gpt-4o")).toEqual({
			excludedModelId: "openai/gpt-4o",
			excludeAllProviders: true,
			excludedProviderSlug: undefined,
		});
	});

	test("model + provider → exclude only that combo", () => {
		expect(computeModelExclusionConfig("openai/gpt-4o@deepinfra")).toEqual({
			excludedModelId: "openai/gpt-4o",
			excludeAllProviders: false,
			excludedProviderSlug: "deepinfra",
		});
	});

	test("returns no exclusion if modelId resolves empty", () => {
		expect(computeModelExclusionConfig("@deepinfra")).toEqual({
			excludedModelId: undefined,
			excludeAllProviders: false,
			excludedProviderSlug: undefined,
		});
	});
});

describe("isFallbackExcluded", () => {
	test("returns false when exclusionConfig has no excludedModelId (mutator-killer for the early-return guard)", () => {
		const cfg = computeModelExclusionConfig("");
		// All inputs must come back false because the guard short-circuits.
		// Mutating `if (!excludedModelId) return false` to skip the early-return
		// would break this — different modelIds would fall through to the
		// modelId-equality check.
		expect(isFallbackExcluded("openai/gpt-4o", cfg)).toBe(false);
		expect(isFallbackExcluded("openai/gpt-4o@deepinfra", cfg)).toBe(false);
		expect(isFallbackExcluded("anthropic/claude-3", cfg)).toBe(false);
	});

	test("auto fallback never excluded", () => {
		const cfg = computeModelExclusionConfig("openai/gpt-4o");
		expect(isFallbackExcluded("", cfg)).toBe(false);
		expect(isFallbackExcluded(OPENROUTER_AUTO_MODEL_ID, cfg)).toBe(false);
	});

	test("returns false (not throws) for null and undefined fallbackValue (kills the empty-fallback guard mutant)", () => {
		// The `if (!fallbackValue) return false` guard prevents calling
		// parseModelSelection with a non-string. A mutant that drops the
		// guard would let null/undefined reach `value.lastIndexOf` and
		// throw TypeError. This test forces the guard to be load-bearing.
		const cfg = computeModelExclusionConfig("openai/gpt-4o");
		expect(isFallbackExcluded(null, cfg)).toBe(false);
		expect(isFallbackExcluded(undefined, cfg)).toBe(false);
	});

	test("different model from primary not excluded", () => {
		const cfg = computeModelExclusionConfig("openai/gpt-4o");
		expect(isFallbackExcluded("anthropic/claude-3", cfg)).toBe(false);
	});

	test("same model with primary 'all providers' excluded → fallback always excluded", () => {
		const cfg = computeModelExclusionConfig("openai/gpt-4o");
		expect(isFallbackExcluded("openai/gpt-4o", cfg)).toBe(true);
		expect(isFallbackExcluded("openai/gpt-4o@anthropic", cfg)).toBe(true);
	});

	test("same model + different provider not excluded when primary pinned a single provider", () => {
		const cfg = computeModelExclusionConfig("openai/gpt-4o@deepinfra");
		expect(isFallbackExcluded("openai/gpt-4o@anthropic", cfg)).toBe(false);
		expect(isFallbackExcluded("openai/gpt-4o@deepinfra", cfg)).toBe(true);
	});

	test("same model + no provider on fallback → excluded when primary pinned a single provider", () => {
		const cfg = computeModelExclusionConfig("openai/gpt-4o@deepinfra");
		expect(isFallbackExcluded("openai/gpt-4o", cfg)).toBe(true);
	});

	test("returns false when no exclusion is configured", () => {
		expect(isFallbackExcluded("openai/gpt-4o", computeModelExclusionConfig(""))).toBe(false);
	});

	test("returns false for empty fallback modelId", () => {
		const cfg = computeModelExclusionConfig("openai/gpt-4o");
		expect(isFallbackExcluded("@deepinfra", cfg)).toBe(false);
	});
});

describe("filterModelsForFallback", () => {
	test("returns models unchanged when no exclusion", () => {
		expect(filterModelsForFallback(models, computeModelExclusionConfig(""))).toEqual(models);
	});

	test("returns the SAME reference when no exclusion is configured (mutator-killer)", () => {
		// Locks in the early-return: with no excludedModelId, the function
		// must return the input array itself, not a copy. A mutator that
		// removes the early return would still return content-equal models
		// but a different reference.
		const cfg = computeModelExclusionConfig("");
		expect(filterModelsForFallback(models, cfg)).toBe(models);
	});

	test("removes ONLY the excluded model and KEEPS all others (kills 'filter → false' / 'filter → undefined' mutants)", () => {
		const cfg = computeModelExclusionConfig("openai/gpt-4o");
		const out = filterModelsForFallback(models, cfg);
		// Excluded model is gone
		expect(out.find((m) => m.id === "openai/gpt-4o")).toBeUndefined();
		// EVERY non-excluded model from the input is still present — kills
		// the mutant that filters to nothing.
		const otherIds = models.reduce<string[]>((acc, m) => {
			if (m.id !== "openai/gpt-4o") {
				acc.push(m.id);
			}
			return acc;
		}, []);
		expect(out.map((m) => m.id).toSorted()).toEqual(otherIds.toSorted());
		expect(out.length).toBe(models.length - 1);
	});

	test("returns models unchanged when primary excluded only one provider", () => {
		const cfg = computeModelExclusionConfig("openai/gpt-4o@deepinfra");
		expect(filterModelsForFallback(models, cfg)).toEqual(models);
	});
});

describe("isEndpointExcluded", () => {
	test("returns false when no exclusion is configured", () => {
		const cfg = computeModelExclusionConfig("");
		expect(isEndpointExcluded("openai/gpt-4o", "deepinfra", cfg)).toBe(false);
	});

	test("returns false for a different model", () => {
		const cfg = computeModelExclusionConfig("openai/gpt-4o");
		expect(isEndpointExcluded("anthropic/claude-3", "anthropic", cfg)).toBe(false);
	});

	test("returns true for the excluded model when primary excluded all providers", () => {
		const cfg = computeModelExclusionConfig("openai/gpt-4o");
		expect(isEndpointExcluded("openai/gpt-4o", "deepinfra", cfg)).toBe(true);
		expect(isEndpointExcluded("openai/gpt-4o", undefined, cfg)).toBe(true);
	});

	test("returns true for an undefined provider when primary pinned a single provider", () => {
		const cfg = computeModelExclusionConfig("openai/gpt-4o@deepinfra");
		expect(isEndpointExcluded("openai/gpt-4o", undefined, cfg)).toBe(true);
	});

	test("returns true only for the matching provider when primary pinned a single provider", () => {
		const cfg = computeModelExclusionConfig("openai/gpt-4o@deepinfra");
		expect(isEndpointExcluded("openai/gpt-4o", "deepinfra", cfg)).toBe(true);
		expect(isEndpointExcluded("openai/gpt-4o", "anthropic", cfg)).toBe(false);
	});
});
