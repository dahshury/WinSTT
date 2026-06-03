"use client";

import { useEffect, useState } from "react";

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Read the persisted favorites for `storageKey`, tolerating SSR (no `window`),
 *  a missing key, malformed JSON, and a non-string-array payload — any of which
 *  fall back to "no favorites yet". */
function readStored(storageKey: string): string[] {
	if (typeof window === "undefined") {
		return [];
	}
	try {
		const raw = window.localStorage.getItem(storageKey);
		if (!raw) {
			return [];
		}
		const parsed: unknown = JSON.parse(raw);
		return isStringArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export interface FavoriteSet {
	/** Favorited ids in the order they were starred. */
	favorites: readonly string[];
	/** Whether `id` is currently starred. */
	isFavorite: (id: string) => boolean;
	/** Flip `id`'s favorite state (star ⇄ unstar). */
	toggleFavorite: (id: string) => void;
}

/**
 * Generic localStorage-backed string set used by every picker's favorites
 * feature — both the per-model favorites (Favorites group in the list) and the
 * per-author favorites (starred authors float to the top of the side rail).
 * Each call namespaces under its own `storageKey` so the different favorites
 * never collide. No defaults are seeded: favoriting is an explicit choice, so a
 * fresh install starts empty.
 *
 * Model-specific hooks wrap this shared implementation with their storage key.
 */
export function useFavoriteSet(storageKey: string): FavoriteSet {
	const [favorites, setFavorites] = useState<string[]>(() => readStored(storageKey));

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		try {
			window.localStorage.setItem(storageKey, JSON.stringify(favorites));
		} catch {
			// Ignore quota / disabled-storage errors — favorites are a nice-to-have,
			// never load-bearing for selecting a model.
		}
	}, [storageKey, favorites]);

	const favoritesSet = new Set(favorites);

	return {
		favorites,
		isFavorite: (id: string) => favoritesSet.has(id),
		toggleFavorite: (id: string) =>
			setFavorites((prev) =>
				prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]
			),
	};
}
