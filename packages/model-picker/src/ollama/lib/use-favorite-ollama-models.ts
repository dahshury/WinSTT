"use client";

import { type FavoriteSet, useFavoriteSet } from "../../core/use-favorite-set";

const STORAGE_KEY = "winstt:ollama-favorite-models";

export type FavoriteOllamaModels = FavoriteSet;

export function useFavoriteOllamaModels(): FavoriteOllamaModels {
	return useFavoriteSet(STORAGE_KEY);
}
