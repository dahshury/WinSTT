import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import type { OpenRouterModel } from "@/shared/api/models";
import type { ModelVariant } from "./model-variant-utils";
import type { FilterableParameter } from "./openrouter-provider-utils";
import { useModelSelectorFilters } from "./use-model-selector-filters";

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
});
