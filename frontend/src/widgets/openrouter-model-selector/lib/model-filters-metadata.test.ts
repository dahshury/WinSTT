import { describe, expect, test } from "bun:test";
import type { OpenRouterModel } from "@/shared/api/models";
import {
	__model_filters_metadata_test_helpers__,
	computeModelFiltersMetadata,
} from "./model-filters-metadata";

const sample: OpenRouterModel[] = [
	{
		id: "openai/gpt-4o",
		name: "GPT-4o",
		maker: "openai",
		endpoints: [{ provider_name: "openai" } as never],
		supported_parameters: ["tools", "reasoning"],
	},
	{
		id: "openai/gpt-4o:nitro",
		name: "GPT-4o Nitro",
		maker: "openai",
		variant: "nitro",
		endpoints: [{ provider_name: "deepinfra" } as never, { provider_name: "openai" } as never],
		supported_parameters: ["tools"],
	},
	{
		id: "anthropic/claude-3-haiku",
		name: "Claude 3 Haiku",
		maker: "anthropic",
		endpoints: [{ provider_name: "anthropic" } as never],
		supported_parameters: ["tools"],
	},
] as unknown as OpenRouterModel[];

describe("computeModelFiltersMetadata", () => {
	test("counts available variants including 'none'", () => {
		const meta = computeModelFiltersMetadata(sample);
		expect(meta.availableVariants).toContain("none");
		expect(meta.availableVariants).toContain("nitro");
	});

	test("variantCounts reports the count of each variant", () => {
		const meta = computeModelFiltersMetadata(sample);
		expect(meta.variantCounts.get("nitro")).toBe(1);
		expect(meta.variantCounts.get("none")).toBe(2);
	});

	test("endpointProviders aggregates and sorts provider names alphabetically", () => {
		const meta = computeModelFiltersMetadata(sample);
		const providers = meta.endpointProviders.map(([name]) => name);
		expect(providers).toEqual(["anthropic", "deepinfra", "openai"]);
	});

	test("providerCounts counts each unique maker", () => {
		const meta = computeModelFiltersMetadata(sample);
		expect(meta.providerCounts.get("openai")).toBe(2);
		expect(meta.providerCounts.get("anthropic")).toBe(1);
	});

	test("parameterCounts counts only known FILTERABLE_PARAMETERS", () => {
		const meta = computeModelFiltersMetadata(sample);
		expect(meta.parameterCounts.get("tools")).toBe(3);
		expect(meta.parameterCounts.get("reasoning")).toBe(1);
	});

	test("empty models produces empty maps with default zeros for known params", () => {
		const meta = computeModelFiltersMetadata([]);
		expect(meta.availableVariants).toEqual([]);
		expect(meta.variantCounts.size).toBe(0);
		expect(meta.endpointProviders).toEqual([]);
		expect(meta.providerCounts.size).toBe(0);
		// known parameter keys still initialized to 0
		expect(meta.parameterCounts.get("tools")).toBe(0);
	});
});

const {
	createAccumulator,
	bumpCount,
	modelHasImplicitVariant,
	accumulateVariant,
	accumulateEndpoints,
	registerEndpointProvider,
	accumulateMaker,
	accumulateParameters,
	registerParameter,
	accumulateModel,
	buildAvailableVariants,
	compareEndpointEntries,
	buildSortedEndpointProviders,
} = __model_filters_metadata_test_helpers__;

describe("createAccumulator", () => {
	test("seeds parameterCounts with zero for every FILTERABLE_PARAMETER", () => {
		const acc = createAccumulator();
		expect(acc.parameterCounts.get("tools")).toBe(0);
		expect(acc.parameterCounts.get("reasoning")).toBe(0);
	});

	test("starts with empty maps and false hasNoVariant", () => {
		const acc = createAccumulator();
		expect(acc.variants.size).toBe(0);
		expect(acc.hasNoVariant).toBe(false);
		expect(acc.variantCounts.size).toBe(0);
		expect(acc.endpointProvidersMap.size).toBe(0);
		expect(acc.providerCounts.size).toBe(0);
	});
});

describe("bumpCount", () => {
	test("creates a new entry at 1", () => {
		const m = new Map<string, number>();
		bumpCount(m, "k");
		expect(m.get("k")).toBe(1);
	});

	test("increments an existing entry", () => {
		const m = new Map<string, number>([["k", 4]]);
		bumpCount(m, "k");
		expect(m.get("k")).toBe(5);
	});
});

describe("modelHasImplicitVariant", () => {
	test.each([
		["openai/gpt-4o:nitro", true],
		["openai/gpt-4o:free", true],
		["openai/gpt-4o", false],
		["openai/gpt-4o:unknown", false],
	])("modelHasImplicitVariant(%p) → %p", (id, expected) => {
		expect(modelHasImplicitVariant({ id } as OpenRouterModel)).toBe(expected);
	});
});

describe("accumulateVariant", () => {
	test("explicit variant adds to set and bumps count", () => {
		const acc = createAccumulator();
		accumulateVariant(acc, { id: "x/y", variant: "nitro" } as OpenRouterModel);
		expect(acc.variants.has("nitro")).toBe(true);
		expect(acc.variantCounts.get("nitro")).toBe(1);
	});

	test("model with implicit variant does not flip hasNoVariant", () => {
		const acc = createAccumulator();
		accumulateVariant(acc, { id: "x/y:nitro" } as OpenRouterModel);
		expect(acc.hasNoVariant).toBe(false);
	});

	test("model with no variant flips hasNoVariant and bumps 'none'", () => {
		const acc = createAccumulator();
		accumulateVariant(acc, { id: "x/y" } as OpenRouterModel);
		expect(acc.hasNoVariant).toBe(true);
		expect(acc.variantCounts.get("none")).toBe(1);
	});
});

describe("accumulateEndpoints / registerEndpointProvider", () => {
	test("accumulates each unique provider_name", () => {
		const acc = createAccumulator();
		accumulateEndpoints(acc, {
			id: "x",
			endpoints: [{ provider_name: "a" }, { provider_name: "b" }, { provider_name: "a" }],
		} as never);
		expect(acc.endpointProvidersMap.get("a")).toBe(1);
		expect(acc.endpointProvidersMap.get("b")).toBe(1);
	});

	test("does nothing when endpoints is undefined", () => {
		const acc = createAccumulator();
		accumulateEndpoints(acc, { id: "x" } as OpenRouterModel);
		expect(acc.endpointProvidersMap.size).toBe(0);
	});

	test("registerEndpointProvider ignores undefined name", () => {
		const acc = createAccumulator();
		registerEndpointProvider(acc, undefined, new Set());
		expect(acc.endpointProvidersMap.size).toBe(0);
	});

	test("registerEndpointProvider skips already-seen names", () => {
		const acc = createAccumulator();
		const seen = new Set<string>(["a"]);
		registerEndpointProvider(acc, "a", seen);
		expect(acc.endpointProvidersMap.size).toBe(0);
	});
});

describe("accumulateMaker", () => {
	test("bumps providerCounts when maker is set", () => {
		const acc = createAccumulator();
		accumulateMaker(acc, { id: "x", maker: "openai" } as OpenRouterModel);
		expect(acc.providerCounts.get("openai")).toBe(1);
	});

	test("does nothing when maker is missing", () => {
		const acc = createAccumulator();
		accumulateMaker(acc, { id: "x" } as OpenRouterModel);
		expect(acc.providerCounts.size).toBe(0);
	});
});

describe("accumulateParameters / registerParameter", () => {
	test("bumps known parameters only", () => {
		const acc = createAccumulator();
		accumulateParameters(acc, {
			id: "x",
			supported_parameters: ["tools", "unknown_param"],
		} as OpenRouterModel);
		expect(acc.parameterCounts.get("tools")).toBe(1);
		expect(acc.parameterCounts.has("unknown_param" as never)).toBe(false);
	});

	test("does nothing when supported_parameters is not an array", () => {
		const acc = createAccumulator();
		accumulateParameters(acc, { id: "x" } as OpenRouterModel);
		// All known params still 0
		expect(acc.parameterCounts.get("tools")).toBe(0);
	});

	test("registerParameter ignores unknown keys", () => {
		const acc = createAccumulator();
		registerParameter(acc, "not_real" as never);
		expect(acc.parameterCounts.has("not_real" as never)).toBe(false);
	});
});

describe("accumulateModel", () => {
	test("runs all 4 sub-accumulators in one call", () => {
		const acc = createAccumulator();
		accumulateModel(acc, {
			id: "openai/gpt-4o",
			maker: "openai",
			variant: "nitro",
			endpoints: [{ provider_name: "openai" }],
			supported_parameters: ["tools"],
		} as never);
		expect(acc.variantCounts.get("nitro")).toBe(1);
		expect(acc.endpointProvidersMap.get("openai")).toBe(1);
		expect(acc.providerCounts.get("openai")).toBe(1);
		expect(acc.parameterCounts.get("tools")).toBe(1);
	});
});

describe("buildAvailableVariants", () => {
	test("prepends 'none' when hasNoVariant is true", () => {
		const acc = createAccumulator();
		acc.hasNoVariant = true;
		acc.variants.add("nitro");
		expect(buildAvailableVariants(acc)).toEqual(["none", "nitro"]);
	});

	test("returns sorted variants without 'none' when hasNoVariant is false", () => {
		const acc = createAccumulator();
		acc.variants.add("nitro");
		acc.variants.add("free");
		expect(buildAvailableVariants(acc)).toEqual(["free", "nitro"]);
	});

	test("returns empty array when nothing accumulated", () => {
		expect(buildAvailableVariants(createAccumulator())).toEqual([]);
	});
});

describe("compareEndpointEntries / buildSortedEndpointProviders", () => {
	test("compareEndpointEntries sorts alphabetically by name", () => {
		expect(compareEndpointEntries(["a", 1], ["b", 1])).toBeLessThan(0);
		expect(compareEndpointEntries(["b", 1], ["a", 1])).toBeGreaterThan(0);
		expect(compareEndpointEntries(["a", 1], ["a", 5])).toBe(0);
	});

	test("buildSortedEndpointProviders returns alphabetic [name, count] pairs", () => {
		const acc = createAccumulator();
		acc.endpointProvidersMap.set("z", 2);
		acc.endpointProvidersMap.set("a", 5);
		expect(buildSortedEndpointProviders(acc)).toEqual([
			["a", 5],
			["z", 2],
		]);
	});

	test("returns empty array when no endpoints accumulated", () => {
		expect(buildSortedEndpointProviders(createAccumulator())).toEqual([]);
	});
});
