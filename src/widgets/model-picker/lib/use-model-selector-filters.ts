"use client";

import type * as React from "react";
import { useDeferredValue, useMemo } from "react";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { getUniqueEndpoints } from "./model-selector-display-utils";
import { filterModels, groupModelsByMaker } from "./model-selector-logic";
import type { ModelVariant } from "./model-variant-utils";
import type { FilterableParameter } from "./openrouter-provider-utils";
import {
	type OpenRouterSortValue,
	SORTED_GROUP_KEY,
	sortOpenRouterModels,
} from "./openrouter-sort";
import { useFavoriteProviders } from "./use-favorite-providers";

/** Pure: appends `<modelId>@<provider>` for each endpoint into `items`. */
function pushEndpointItems(
	items: string[],
	modelId: string,
	endpoints: OpenRouterEndpoint[],
): void {
	for (const endpoint of endpoints) {
		items.push(`${modelId}@${endpoint.provider_name}`);
	}
}

/** Pure: appends provider-specific item strings for a model with multiple endpoints. */
function appendModelEndpointItems(
	items: string[],
	model: OpenRouterModel,
): void {
	if (!(model.endpoints && model.endpoints.length > 1)) {
		return;
	}
	pushEndpointItems(items, model.id, getUniqueEndpoints(model.endpoints));
}

/** Pure: builds Combobox item value strings from grouped models. */
function buildComboboxItems(
	groupedModels: [string, OpenRouterModel[]][],
): string[] {
	const items: string[] = [];
	for (const [, makerModels] of groupedModels) {
		for (const model of makerModels) {
			items.push(model.id);
			appendModelEndpointItems(items, model);
		}
	}
	return items;
}

interface UseModelSelectorFiltersProps {
	favoriteProvidersStorageKey?: string | undefined;
	isOpen?: boolean;
	models: OpenRouterModel[];
	searchQuery: string;
	selectedEndpointProvider: string | null;
	selectedMakers: string[];
	selectedParameters: FilterableParameter[];
	selectedVariant: ModelVariant | "none" | null;
	setSearchQuery: (query: string) => void;
	setSelectedEndpointProvider: (provider: string | null) => void;
	setSelectedMakers: React.Dispatch<React.SetStateAction<string[]>>;
	setSelectedParameters: React.Dispatch<
		React.SetStateAction<FilterableParameter[]>
	>;
	setSelectedVariant: (variant: ModelVariant | "none" | null) => void;
	sortKey?: OpenRouterSortValue;
}

/**
 * Pure: build the grouped model list. While a sort is active, flatten every
 * maker into one globally-sorted group (under {@link SORTED_GROUP_KEY}) so the
 * column reads as a single ordered list; otherwise keep the per-maker grouping.
 */
function buildGroupedModels(
	filteredModels: OpenRouterModel[],
	hasSearch: boolean,
	sortKey: OpenRouterSortValue,
): [string, OpenRouterModel[]][] {
	if (sortKey === null) {
		return groupModelsByMaker(filteredModels, hasSearch);
	}
	const sorted = sortOpenRouterModels(filteredModels, sortKey);
	return sorted.length > 0 ? [[SORTED_GROUP_KEY, sorted]] : [];
}

/** Pure: returns true when any list-typed filter has a selection. */
function hasListSelection(
	selectedMakers: string[],
	selectedParameters: FilterableParameter[],
): boolean {
	return selectedMakers.length > 0 || selectedParameters.length > 0;
}

/** Pure: returns true when any single-valued filter is set. */
function hasSingleValueSelection(
	selectedVariant: ModelVariant | "none" | null,
	selectedEndpointProvider: string | null,
): boolean {
	return selectedVariant !== null || selectedEndpointProvider !== null;
}

/** Pure: returns true when any selection-type filter is active. */
function hasSelectionFilter(
	selectedMakers: string[],
	selectedVariant: ModelVariant | "none" | null,
	selectedEndpointProvider: string | null,
	selectedParameters: FilterableParameter[],
): boolean {
	return (
		hasListSelection(selectedMakers, selectedParameters) ||
		hasSingleValueSelection(selectedVariant, selectedEndpointProvider)
	);
}

/** Pure: returns true when any filter is active. */
function computeHasActiveFilters(
	selectedMakers: string[],
	searchQuery: string,
	selectedVariant: ModelVariant | "none" | null,
	selectedEndpointProvider: string | null,
	selectedParameters: FilterableParameter[],
): boolean {
	return (
		searchQuery.trim() !== "" ||
		hasSelectionFilter(
			selectedMakers,
			selectedVariant,
			selectedEndpointProvider,
			selectedParameters,
		)
	);
}

export function useModelSelectorFilters({
	favoriteProvidersStorageKey,
	models,
	searchQuery,
	selectedMakers,
	selectedVariant,
	selectedEndpointProvider,
	selectedParameters,
	setSearchQuery,
	setSelectedMakers,
	setSelectedVariant,
	setSelectedEndpointProvider,
	setSelectedParameters,
	sortKey = null,
	isOpen = false,
}: UseModelSelectorFiltersProps) {
	const { favorites, toggleFavorite } = useFavoriteProviders(
		favoriteProvidersStorageKey,
	);

	const deferredSearchQuery = useDeferredValue(searchQuery);

	const allProviders = useMemo(() => {
		const providers = new Set<string>();
		for (const model of models) {
			if (model.maker) {
				providers.add(model.maker);
			}
		}
		return Array.from(providers).sort();
	}, [models]);

	const { favoriteProviders } = useMemo(() => {
		const favoritesSet = new Set(favorites);
		const favs: string[] = [];
		for (const provider of allProviders) {
			if (favoritesSet.has(provider)) {
				favs.push(provider);
			}
		}
		const sortedFavs = favs.toSorted(
			(a, b) => favorites.indexOf(a) - favorites.indexOf(b),
		);
		return { favoriteProviders: sortedFavs };
	}, [allProviders, favorites]);

	const filteredModels = useMemo(() => {
		if (!(isOpen || searchQuery)) {
			return models;
		}

		return filterModels(models, {
			searchQuery: deferredSearchQuery,
			selectedMakers,
			selectedVariant,
			selectedEndpointProvider,
			selectedParameters,
		});
	}, [
		models,
		deferredSearchQuery,
		selectedMakers,
		selectedVariant,
		selectedEndpointProvider,
		selectedParameters,
		isOpen,
		searchQuery,
	]);

	const groupedModelsAll = useMemo(() => {
		const hasSearch = searchQuery.trim() !== "";
		return buildGroupedModels(filteredModels, hasSearch, sortKey);
	}, [filteredModels, searchQuery, sortKey]);

	const comboboxItems = useMemo(() => {
		if (!(isOpen || searchQuery)) {
			return [];
		}
		return buildComboboxItems(groupedModelsAll);
	}, [groupedModelsAll, isOpen, searchQuery]);

	const hasActiveFilters = computeHasActiveFilters(
		selectedMakers,
		searchQuery,
		selectedVariant,
		selectedEndpointProvider,
		selectedParameters,
	);

	const handleSearchChange = (query: string) => {
		setSearchQuery(query);
	};

	const handleMakerToggle = (maker: string) => {
		setSelectedMakers((prev) =>
			prev.includes(maker) ? prev.filter((m) => m !== maker) : [...prev, maker],
		);
	};

	const handleMakersChange = (makers: string[]) => {
		setSelectedMakers(makers);
	};

	const handleVariantSelect = (variant: ModelVariant | "none" | null) => {
		setSelectedVariant(variant);
	};

	const handleEndpointProviderSelect = (provider: string | null) => {
		setSelectedEndpointProvider(provider);
	};

	const handleParametersChange = (params: FilterableParameter[]) => {
		setSelectedParameters(params);
	};

	const handleRemoveParameter = (param: FilterableParameter) => {
		setSelectedParameters((prev: FilterableParameter[]) =>
			prev.filter((p: FilterableParameter) => p !== param),
		);
	};

	return {
		allProviders,
		favoriteProviders,
		groupedModelsAll,
		comboboxItems,
		hasActiveFilters,
		favorites,
		toggleFavorite,
		handleSearchChange,
		handleMakerToggle,
		handleMakersChange,
		handleVariantSelect,
		handleEndpointProviderSelect,
		handleParametersChange,
		handleRemoveParameter,
		isSearchPending: searchQuery !== deferredSearchQuery,
	};
}
