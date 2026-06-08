"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

export const DEFAULT_OPENROUTER_FAVORITE_PROVIDERS_STORAGE_KEY =
	"winstt:openrouter-favorite-providers";
const DEFAULT_FAVORITES = ["openai", "google", "anthropic"];

function isNonEmptyArray(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.length > 0;
}

function parseStoredFavorites(stored: string | null): string[] | null {
	if (!stored) {
		return null;
	}
	const parsed: unknown = JSON.parse(stored);
	return isNonEmptyArray(parsed) ? (parsed as string[]) : null;
}

function readStoredFavorites(storageKey: string): string[] | null {
	if (typeof window === "undefined") {
		return null;
	}
	try {
		return parseStoredFavorites(window.localStorage.getItem(storageKey));
	} catch {
		return null;
	}
}

function getInitialFavorites(storageKey: string): string[] {
	return readStoredFavorites(storageKey) ?? DEFAULT_FAVORITES;
}

export function useFavoriteProviders(
	storageKey = DEFAULT_OPENROUTER_FAVORITE_PROVIDERS_STORAGE_KEY,
) {
	const [favorites, setFavorites] = useState<string[]>(() =>
		getInitialFavorites(storageKey),
	);
	const [isLoaded] = useState(true);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		try {
			window.localStorage.setItem(storageKey, JSON.stringify(favorites));
		} catch {
			// ignore storage errors
		}
	}, [storageKey, favorites]);

	const addFavorite = useCallback((provider: string) => {
		setFavorites((prev) => {
			if (prev.includes(provider)) {
				return prev;
			}
			return [...prev, provider];
		});
	}, []);

	const removeFavorite = useCallback((provider: string) => {
		setFavorites((prev) => prev.filter((p) => p !== provider));
	}, []);

	const toggleFavorite = useCallback((provider: string) => {
		setFavorites((prev) => {
			if (prev.includes(provider)) {
				return prev.filter((p) => p !== provider);
			}
			return [...prev, provider];
		});
	}, []);

	const favoritesSet = useMemo(() => new Set(favorites), [favorites]);

	const isFavorite = useCallback(
		(provider: string) => favoritesSet.has(provider),
		[favoritesSet],
	);

	return {
		favorites,
		addFavorite,
		removeFavorite,
		toggleFavorite,
		isFavorite,
		isLoaded,
	};
}
