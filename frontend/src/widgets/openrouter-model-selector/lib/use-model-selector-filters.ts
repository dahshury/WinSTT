"use client";

import type * as React from "react";
import { useDeferredValue, useMemo } from "react";
import type { OpenRouterModel } from "@/shared/api/models";
import { getUniqueEndpoints } from "./model-selector-display-utils";
import { filterModels, groupModelsByMaker } from "./model-selector-logic";
import type { ModelVariant } from "./model-variant-utils";
import type { FilterableParameter } from "./openrouter-provider-utils";
import { useFavoriteProviders } from "./use-favorite-providers";

interface UseModelSelectorFiltersProps {
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
	setSelectedParameters: React.Dispatch<React.SetStateAction<FilterableParameter[]>>;
	setSelectedVariant: (variant: ModelVariant | "none" | null) => void;
}

export function useModelSelectorFilters({
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
	isOpen = false,
}: UseModelSelectorFiltersProps) {
	const { favorites, toggleFavorite } = useFavoriteProviders();

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
		const sortedFavs = favs.toSorted((a, b) => favorites.indexOf(a) - favorites.indexOf(b));
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
		return groupModelsByMaker(filteredModels, hasSearch);
	}, [filteredModels, searchQuery]);

	const comboboxItems = useMemo(() => {
		if (!(isOpen || searchQuery)) {
			return [];
		}

		const items: string[] = [];
		for (const [, makerModels] of groupedModelsAll) {
			for (const model of makerModels) {
				items.push(model.id);
				if (model.endpoints && model.endpoints.length > 1) {
					const uniqueEndpoints = getUniqueEndpoints(model.endpoints);
					for (const endpoint of uniqueEndpoints) {
						items.push(`${model.id}@${endpoint.provider_name}`);
					}
				}
			}
		}
		return items;
	}, [groupedModelsAll, isOpen, searchQuery]);

	const hasActiveFilters =
		selectedMakers.length > 0 ||
		searchQuery.trim() !== "" ||
		selectedVariant !== null ||
		selectedEndpointProvider !== null ||
		selectedParameters.length > 0;

	const handleSearchChange = (query: string) => {
		setSearchQuery(query);
	};

	const handleMakerToggle = (maker: string) => {
		setSelectedMakers((prev) =>
			prev.includes(maker) ? prev.filter((m) => m !== maker) : [...prev, maker]
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
			prev.filter((p: FilterableParameter) => p !== param)
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
