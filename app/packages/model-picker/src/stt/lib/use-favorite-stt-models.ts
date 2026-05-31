"use client";

import { useEffect, useState } from "react";

/** localStorage key for the user's starred STT model ids. Namespaced under
 *  ``winstt:`` like the sibling ``useFavoriteProviders`` store so the two
 *  favorites features don't collide. */
const STORAGE_KEY = "winstt:stt-favorite-models";

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Read the persisted favorites, tolerating SSR (no ``window``), a missing
 *  key, malformed JSON, and a non-string-array payload — any of which fall
 *  back to "no favorites yet". */
function readStoredFavorites(): string[] {
	if (typeof window === "undefined") {
		return [];
	}
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return [];
		}
		const parsed: unknown = JSON.parse(raw);
		return isStringArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export interface FavoriteSttModels {
	/** Favorited model ids in the order they were starred. */
	favorites: readonly string[];
	/** Whether ``modelId`` is currently starred. */
	isFavorite: (modelId: string) => boolean;
	/** Flip ``modelId``'s favorite state (star ⇄ unstar). */
	toggleFavorite: (modelId: string) => void;
}

/**
 * localStorage-backed set of "favorited" STT model ids.
 *
 * Mirrors the OpenRouter {@link useFavoriteProviders} persistence pattern from
 * this same package so a user's starred models survive a window reload. The
 * favorited models are surfaced as a synthetic "Favorites" group pinned to the
 * top of the picker list (see ``withFavoritesGroup`` in ``family-helpers``) —
 * the model is *repeated*: it keeps its normal per-maker card AND gains a
 * shortcut card up top.
 *
 * Unlike the provider favorites we seed NO defaults — "favorite" here is an
 * explicit per-model choice, so a fresh install starts with an empty set and
 * the Favorites group simply doesn't render until the first star is clicked.
 */
export function useFavoriteSttModels(): FavoriteSttModels {
	const [favorites, setFavorites] = useState<string[]>(readStoredFavorites);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
		} catch {
			// Ignore quota / disabled-storage errors — favorites are a
			// nice-to-have, never load-bearing for selecting a model.
		}
	}, [favorites]);

	const favoritesSet = new Set(favorites);

	return {
		favorites,
		isFavorite: (modelId: string) => favoritesSet.has(modelId),
		toggleFavorite: (modelId: string) =>
			setFavorites((prev) =>
				prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId]
			),
	};
}
