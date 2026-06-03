"use client";

import { type FavoriteSet, useFavoriteSet } from "../../core/use-favorite-set";

const STORAGE_KEY = "winstt:stt-favorite-models";

export type FavoriteSttModels = FavoriteSet;

export function useFavoriteSttModels(): FavoriteSttModels {
	return useFavoriteSet(STORAGE_KEY);
}
