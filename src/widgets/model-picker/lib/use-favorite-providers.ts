"use client";

import { useEffect, useState } from "react";
import {
	readPersistedSelectorState,
	writePersistedSelectorState,
} from "@/shared/lib/persisted-selector-state";

const DEFAULT_OPENROUTER_FAVORITE_PROVIDERS_STORAGE_KEY =
	"winstt:openrouter-favorite-providers";
const DEFAULT_FAVORITES = ["openai", "google", "anthropic"];

// A stored value only overrides the defaults when it's a NON-EMPTY array;
// an empty array (or any non-array) falls back to the default providers.
function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0;
}

function getInitialFavorites(storageKey: string): string[] {
	return readPersistedSelectorState(
		storageKey,
		isNonEmptyStringArray,
		DEFAULT_FAVORITES,
	);
}

export function useFavoriteProviders(
	storageKey = DEFAULT_OPENROUTER_FAVORITE_PROVIDERS_STORAGE_KEY,
) {
	const [favorites, setFavorites] = useState<string[]>(() =>
		getInitialFavorites(storageKey),
	);

	useEffect(() => {
		// Ignore SSR / storage errors — favorites are non-critical UI state.
		writePersistedSelectorState(storageKey, favorites);
	}, [storageKey, favorites]);

	const toggleFavorite = (provider: string) => {
		setFavorites((prev) => {
			if (prev.includes(provider)) {
				return prev.filter((p) => p !== provider);
			}
			return [...prev, provider];
		});
	};

	return {
		favorites,
		toggleFavorite,
	};
}
