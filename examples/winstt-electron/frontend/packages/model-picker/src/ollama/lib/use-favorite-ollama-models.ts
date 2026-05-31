"use client";

import { useEffect, useState } from "react";

/** localStorage key for the user's starred Ollama model names. Namespaced
 *  under ``winstt:`` alongside the sibling ``winstt:stt-favorite-models`` and
 *  ``useFavoriteProviders`` stores so the favorites features never collide. */
const STORAGE_KEY = "winstt:ollama-favorite-models";

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

export interface FavoriteOllamaModels {
	/** Favorited model names in the order they were starred. */
	favorites: readonly string[];
	/** Whether ``modelName`` is currently starred. */
	isFavorite: (modelName: string) => boolean;
	/** Flip ``modelName``'s favorite state (star ⇄ unstar). */
	toggleFavorite: (modelName: string) => void;
}

/**
 * localStorage-backed set of "favorited" Ollama model names.
 *
 * The exact sibling of {@link import("../../stt/lib/use-favorite-stt-models").useFavoriteSttModels}
 * for the Ollama LLM picker — the favorited models are surfaced as a synthetic
 * "Favorites" group pinned to the top of the picker list. The model is repeated
 * (it keeps its normal per-publisher row AND gains a shortcut row up top). Keyed
 * by the full Ollama tag (``model.name``, e.g. ``qwen3:1.7b``) since that's the
 * picker's selection value.
 *
 * No defaults are seeded — favoriting is an explicit per-model choice, so a
 * fresh install starts empty and the Favorites group doesn't render until the
 * first star is clicked.
 */
export function useFavoriteOllamaModels(): FavoriteOllamaModels {
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
		isFavorite: (modelName: string) => favoritesSet.has(modelName),
		toggleFavorite: (modelName: string) =>
			setFavorites((prev) =>
				prev.includes(modelName) ? prev.filter((name) => name !== modelName) : [...prev, modelName]
			),
	};
}
