"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "winstt:openrouter-favorite-providers";
const DEFAULT_FAVORITES = ["openai", "google", "anthropic"];

function parseStoredFavorites(stored: string | null): string[] | null {
	if (!stored) {
		return null;
	}
	const parsed: unknown = JSON.parse(stored);
	if (Array.isArray(parsed) && parsed.length > 0) {
		return parsed as string[];
	}
	return null;
}

function readStoredFavorites(): string[] | null {
	if (typeof window === "undefined") {
		return null;
	}
	try {
		return parseStoredFavorites(window.localStorage.getItem(STORAGE_KEY));
	} catch {
		return null;
	}
}

function getInitialFavorites(): string[] {
	return readStoredFavorites() ?? DEFAULT_FAVORITES;
}

export const __use_favorite_providers_test_helpers__ = {
	parseStoredFavorites,
	readStoredFavorites,
};

export function useFavoriteProviders() {
	const [favorites, setFavorites] = useState<string[]>(getInitialFavorites);
	const [isLoaded] = useState(true);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
		} catch {
			// ignore storage errors
		}
	}, [favorites]);

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

	const isFavorite = useCallback((provider: string) => favoritesSet.has(provider), [favoritesSet]);

	return {
		favorites,
		addFavorite,
		removeFavorite,
		toggleFavorite,
		isFavorite,
		isLoaded,
	};
}
