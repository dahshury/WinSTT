import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import type { ModelVariant } from "./model-variant-utils";
import type { FilterableParameter } from "./openrouter-provider-utils";
import {
	appendModelEndpointItems,
	buildComboboxItems,
	computeHasActiveFilters,
	hasSelectionFilter,
	useModelSelectorFilters,
} from "./use-model-selector-filters";

beforeEach(() => {
	window.localStorage.removeItem("winstt:openrouter-favorite-providers");
});

afterEach(() => {
	window.localStorage.removeItem("winstt:openrouter-favorite-providers");
});

const sample: OpenRouterModel[] = [
	{
		id: "openai/gpt-4o",
		name: "GPT-4o",
		maker: "openai",
		endpoints: [],
	},
	{
		id: "anthropic/claude-3",
		name: "Claude 3",
		maker: "anthropic",
		endpoints: [],
	},
] as unknown as OpenRouterModel[];

const sampleWithEndpoints: OpenRouterModel[] = [
	{
		id: "openai/gpt-4o",
		name: "GPT-4o",
		maker: "openai",
		endpoints: [
			{ provider_name: "DeepInfra", tag: "deepinfra" },
			{ provider_name: "Together", tag: "together" },
		],
	},
	{
		id: "anthropic/claude-3",
		name: "Claude 3",
		maker: "anthropic",
		endpoints: [{ provider_name: "Anthropic", tag: "anthropic" }],
	},
] as unknown as OpenRouterModel[];

function useTestHarness(models: OpenRouterModel[]) {
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedMakers, setSelectedMakers] = useState<string[]>([]);
	const [selectedVariant, setSelectedVariant] = useState<ModelVariant | "none" | null>(null);
	const [selectedEndpointProvider, setSelectedEndpointProvider] = useState<string | null>(null);
	const [selectedParameters, setSelectedParameters] = useState<FilterableParameter[]>([]);
	const filters = useModelSelectorFilters({
		isOpen: true,
		models,
		searchQuery,
		selectedEndpointProvider,
		selectedMakers,
		selectedParameters,
		selectedVariant,
		setSearchQuery,
		setSelectedEndpointProvider,
		setSelectedMakers,
		setSelectedParameters,
		setSelectedVariant,
	});
	return {
		filters,
		searchQuery,
		selectedMakers,
		selectedVariant,
		selectedEndpointProvider,
		selectedParameters,
	};
}

describe("hasSelectionFilter", () => {
	test("false when all selection params are empty/null", () => {
		expect(hasSelectionFilter([], null, null, [])).toBe(false);
	});

	test("true when selectedMakers not empty", () => {
		expect(hasSelectionFilter(["openai"], null, null, [])).toBe(true);
	});

	test("true when selectedVariant set", () => {
		expect(hasSelectionFilter([], "nitro", null, [])).toBe(true);
	});

	test("true when selectedEndpointProvider set", () => {
		expect(hasSelectionFilter([], null, "deepinfra", [])).toBe(true);
	});

	test("true when selectedParameters non-empty", () => {
		expect(hasSelectionFilter([], null, null, ["tools"])).toBe(true);
	});
});

describe("computeHasActiveFilters", () => {
	test("false when all empty/null", () => {
		expect(computeHasActiveFilters([], "", null, null, [])).toBe(false);
	});

	test("true when selectedMakers not empty", () => {
		expect(computeHasActiveFilters(["openai"], "", null, null, [])).toBe(true);
	});

	test("true when searchQuery non-empty", () => {
		expect(computeHasActiveFilters([], "gpt", null, null, [])).toBe(true);
	});

	test("false when searchQuery is only whitespace", () => {
		expect(computeHasActiveFilters([], "   ", null, null, [])).toBe(false);
	});

	test("true when selectedVariant is set", () => {
		expect(computeHasActiveFilters([], "", "nitro", null, [])).toBe(true);
	});

	test("true when selectedEndpointProvider is set", () => {
		expect(computeHasActiveFilters([], "", null, "deepinfra", [])).toBe(true);
	});

	test("true when selectedParameters non-empty", () => {
		expect(computeHasActiveFilters([], "", null, null, ["tools"])).toBe(true);
	});
});

describe("appendModelEndpointItems", () => {
	const makeEndpoint = (provider_name: string) =>
		({ provider_name, tag: provider_name }) as unknown as OpenRouterEndpoint;

	test("no-op when model has no endpoints", () => {
		const m = { id: "openai/x", endpoints: [] } as unknown as OpenRouterModel;
		const items: string[] = [];
		appendModelEndpointItems(items, m);
		expect(items).toEqual([]);
	});

	test("no-op when model has exactly one endpoint", () => {
		const m = { id: "openai/x", endpoints: [makeEndpoint("P1")] } as unknown as OpenRouterModel;
		const items: string[] = [];
		appendModelEndpointItems(items, m);
		expect(items).toEqual([]);
	});

	test("appends provider items when model has multiple endpoints", () => {
		const m = {
			id: "openai/x",
			endpoints: [makeEndpoint("P1"), makeEndpoint("P2")],
		} as unknown as OpenRouterModel;
		const items: string[] = [];
		appendModelEndpointItems(items, m);
		expect(items).toContain("openai/x@P1");
		expect(items).toContain("openai/x@P2");
	});
});

describe("buildComboboxItems", () => {
	const makeEndpoint = (
		overrides: { provider_name: string; tag?: string } = { provider_name: "P1" }
	) =>
		({
			provider_name: overrides.provider_name,
			tag: overrides.tag ?? overrides.provider_name,
		}) as unknown as OpenRouterEndpoint;

	test("empty grouped models returns empty array", () => {
		expect(buildComboboxItems([])).toEqual([]);
	});

	test("model with single endpoint gets only model id (no provider entries)", () => {
		const m: OpenRouterModel = {
			id: "openai/gpt-4o",
			name: "GPT-4o",
			maker: "openai",
			endpoints: [makeEndpoint({ provider_name: "DeepInfra" })],
		} as unknown as OpenRouterModel;
		const result = buildComboboxItems([["openai", [m]]]);
		expect(result).toEqual(["openai/gpt-4o"]);
	});

	test("model with multiple endpoints gets model id plus provider-specific entries", () => {
		const m: OpenRouterModel = {
			id: "openai/gpt-4o",
			name: "GPT-4o",
			maker: "openai",
			endpoints: [
				makeEndpoint({ provider_name: "DeepInfra" }),
				makeEndpoint({ provider_name: "Together" }),
			],
		} as unknown as OpenRouterModel;
		const result = buildComboboxItems([["openai", [m]]]);
		expect(result).toContain("openai/gpt-4o");
		expect(result).toContain("openai/gpt-4o@DeepInfra");
		expect(result).toContain("openai/gpt-4o@Together");
	});

	test("model with no endpoints gets only model id", () => {
		const m: OpenRouterModel = {
			id: "openai/gpt-4o",
			name: "GPT-4o",
			maker: "openai",
			endpoints: [],
		} as unknown as OpenRouterModel;
		expect(buildComboboxItems([["openai", [m]]])).toEqual(["openai/gpt-4o"]);
	});

	test("multiple makers each contribute their models", () => {
		const m1: OpenRouterModel = {
			id: "openai/g",
			name: "G",
			maker: "openai",
			endpoints: [],
		} as unknown as OpenRouterModel;
		const m2: OpenRouterModel = {
			id: "anthropic/c",
			name: "C",
			maker: "anthropic",
			endpoints: [],
		} as unknown as OpenRouterModel;
		const result = buildComboboxItems([
			["openai", [m1]],
			["anthropic", [m2]],
		]);
		expect(result).toEqual(["openai/g", "anthropic/c"]);
	});
});

describe("useModelSelectorFilters", () => {
	test("derives allProviders from the model list (sorted)", () => {
		const { result } = renderHook(() => useTestHarness(sample));
		expect(result.current.filters.allProviders).toEqual(["anthropic", "openai"]);
	});

	test("favoriteProviders includes default favorites that exist in allProviders", () => {
		const { result } = renderHook(() => useTestHarness(sample));
		expect(result.current.filters.favoriteProviders).toEqual(["openai", "anthropic"]);
	});

	test("groupedModelsAll groups by maker (alphabetical when no search)", () => {
		const { result } = renderHook(() => useTestHarness(sample));
		const makers = result.current.filters.groupedModelsAll.map(([m]) => m);
		expect(makers).toEqual(["anthropic", "openai"]);
	});

	test("hasActiveFilters is false when nothing is selected", () => {
		const { result } = renderHook(() => useTestHarness(sample));
		expect(result.current.filters.hasActiveFilters).toBe(false);
	});

	test("handleSearchChange updates the search query", () => {
		const { result } = renderHook(() => useTestHarness(sample));
		act(() => result.current.filters.handleSearchChange("foo"));
		expect(result.current.searchQuery).toBe("foo");
	});

	test("handleMakerToggle toggles a maker on/off", () => {
		const { result } = renderHook(() => useTestHarness(sample));
		act(() => result.current.filters.handleMakerToggle("openai"));
		expect(result.current.selectedMakers).toEqual(["openai"]);
		act(() => result.current.filters.handleMakerToggle("openai"));
		expect(result.current.selectedMakers).toEqual([]);
	});

	test("handleMakersChange replaces the selection wholesale", () => {
		const { result } = renderHook(() => useTestHarness(sample));
		act(() => result.current.filters.handleMakersChange(["anthropic"]));
		expect(result.current.selectedMakers).toEqual(["anthropic"]);
	});

	test("handleVariantSelect updates selectedVariant", () => {
		const { result } = renderHook(() => useTestHarness(sample));
		act(() => result.current.filters.handleVariantSelect("nitro"));
		expect(result.current.selectedVariant).toBe("nitro");
	});

	test("handleEndpointProviderSelect updates selectedEndpointProvider", () => {
		const { result } = renderHook(() => useTestHarness(sample));
		act(() => result.current.filters.handleEndpointProviderSelect("deepinfra"));
		expect(result.current.selectedEndpointProvider).toBe("deepinfra");
	});

	test("handleParametersChange replaces the selection", () => {
		const { result } = renderHook(() => useTestHarness(sample));
		act(() => result.current.filters.handleParametersChange(["tools"]));
		expect(result.current.selectedParameters).toEqual(["tools"]);
	});

	test("handleRemoveParameter drops a single parameter from the selection", () => {
		const { result } = renderHook(() => useTestHarness(sample));
		act(() => result.current.filters.handleParametersChange(["tools", "reasoning"]));
		act(() => result.current.filters.handleRemoveParameter("tools"));
		expect(result.current.selectedParameters).toEqual(["reasoning"]);
	});

	test("comboboxItems is empty when isOpen=false and searchQuery is empty", () => {
		// Use a harness with isOpen=false
		function useClosedHarness(models: OpenRouterModel[]) {
			const [searchQuery, setSearchQuery] = useState("");
			const [selectedMakers, setSelectedMakers] = useState<string[]>([]);
			const [selectedVariant, setSelectedVariant] = useState<ModelVariant | "none" | null>(null);
			const [selectedEndpointProvider, setSelectedEndpointProvider] = useState<string | null>(null);
			const [selectedParameters, setSelectedParameters] = useState<FilterableParameter[]>([]);
			return useModelSelectorFilters({
				isOpen: false,
				models,
				searchQuery,
				selectedEndpointProvider,
				selectedMakers,
				selectedParameters,
				selectedVariant,
				setSearchQuery,
				setSelectedEndpointProvider,
				setSelectedMakers,
				setSelectedParameters,
				setSelectedVariant,
			});
		}

		const { result } = renderHook(() => useClosedHarness(sample));
		expect(result.current.comboboxItems).toEqual([]);
	});

	test("comboboxItems includes provider-specific entries for models with multiple endpoints", () => {
		const { result } = renderHook(() => useTestHarness(sampleWithEndpoints));
		// gpt-4o has 2 endpoints → 3 items (model + 2 providers)
		// claude-3 has 1 endpoint → 1 item (model only, length <= 1)
		expect(result.current.filters.comboboxItems).toContain("openai/gpt-4o");
		expect(result.current.filters.comboboxItems).toContain("openai/gpt-4o@DeepInfra");
		expect(result.current.filters.comboboxItems).toContain("openai/gpt-4o@Together");
		expect(result.current.filters.comboboxItems).toContain("anthropic/claude-3");
		// claude-3 has only 1 endpoint, so no provider-specific entries
		expect(result.current.filters.comboboxItems).not.toContain("anthropic/claude-3@Anthropic");
	});

	test("isSearchPending is false when query matches deferred value", () => {
		const { result } = renderHook(() => useTestHarness(sample));
		// Initially both are empty
		expect(result.current.filters.isSearchPending).toBe(false);
	});
});
