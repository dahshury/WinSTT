"use client";

import { useEffect, useState } from "react";
import {
	isStringArray,
	readPersistedSelectorState,
	writePersistedSelectorState,
} from "@/shared/lib/persisted-selector-state";

/** Read the persisted favorites for `storageKey`, tolerating SSR (no `window`),
 *  a missing key, malformed JSON, and a non-string-array payload — any of which
 *  fall back to "no favorites yet". */
function readStored(storageKey: string): string[] {
	return readPersistedSelectorState(storageKey, isStringArray, []);
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
	const [favorites, setFavorites] = useState<string[]>(() =>
		readStored(storageKey),
	);

	useEffect(() => {
		// Ignore quota / disabled-storage / SSR — favorites are a nice-to-have,
		// never load-bearing for selecting a model.
		writePersistedSelectorState(storageKey, favorites);
	}, [storageKey, favorites]);

	const favoritesSet = new Set(favorites);

	return {
		favorites,
		isFavorite: (id: string) => favoritesSet.has(id),
		toggleFavorite: (id: string) =>
			setFavorites((prev) =>
				prev.includes(id)
					? prev.filter((entry) => entry !== id)
					: [...prev, id],
			),
	};
}
