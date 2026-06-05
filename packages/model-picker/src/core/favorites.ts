/**
 * Shared favourites primitives used by every picker (STT, TTS, …). Two distinct
 * favourites features build on these:
 *   - per-MODEL favourites → a synthetic "Favorites" group pinned to the top of
 *     the list (the starred models, repeated not moved);
 *   - per-AUTHOR favourites → starred rail tiles that float to the top of the
 *     side rail (handled by {@link GroupRail}'s `favorites` prop).
 *
 * The persistence itself lives in {@link useFavoriteSet}; these helpers just give
 * every picker ONE definition of the synthetic group value + the dedup walk so
 * the list narrowing, the rail tile id, and the scroll-spy section all match.
 */

/**
 * Synthetic group value for the user's starred models. NOT a real
 * maker/family/engine key — the Favorites group aggregates models across makers
 * and is pinned to the top of the picker list, so list/rail code special-cases
 * it before falling back to the per-group rendering.
 */
export const FAVORITES_GROUP_VALUE = "favorites";

/** Narrowing helper — true for the synthetic favourites group value. */
export function isFavoritesGroupValue(
  value: string,
): value is typeof FAVORITES_GROUP_VALUE {
  return value === FAVORITES_GROUP_VALUE;
}

/**
 * Walk grouped models in their existing (maker-sorted) order and collect the
 * starred ones, de-duplicated by id — so the synthetic "Favorites" group reads
 * top-to-bottom the same as the rest of the list. The models are REPEATED, not
 * moved: each starred model keeps its normal group card AND gains a shortcut
 * card up top. Returns an empty array when nothing is starred (so the caller
 * only adds the Favorites group / rail tile once at least one model is starred).
 */
export function collectFavorites<M>(
  groups: ReadonlyArray<{ items: readonly M[] }>,
  isFavorite: (id: string) => boolean,
  getId: (model: M) => string,
): M[] {
  const favorites: M[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const model of group.items) {
      const id = getId(model);
      if (isFavorite(id) && !seen.has(id)) {
        seen.add(id);
        favorites.push(model);
      }
    }
  }
  return favorites;
}

/** A grouped-list entry widened to admit the synthetic Favorites bucket. */
export interface FavoriteAwareGroup<M, V extends string> {
  items: M[];
  value: V | typeof FAVORITES_GROUP_VALUE;
}

/**
 * Prepend the synthetic Favorites group to picker-specific groups. This keeps
 * the "starred models are repeated, not moved" behavior identical across STT,
 * TTS, Ollama, and OpenRouter adapters.
 */
export function withFavoritesGroup<M, V extends string>(
  groups: ReadonlyArray<{ items: M[]; value: V }>,
  isFavorite: (id: string) => boolean,
  getId: (model: M) => string,
): FavoriteAwareGroup<M, V>[] {
  const favorites = collectFavorites(groups, isFavorite, getId);
  if (favorites.length === 0) {
    return [...groups];
  }
  return [{ value: FAVORITES_GROUP_VALUE, items: favorites }, ...groups];
}
