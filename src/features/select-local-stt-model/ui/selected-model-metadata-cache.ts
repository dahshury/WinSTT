import type { ModelInfo } from "@/entities/model-catalog";

/**
 * Module-level metadata cache for the STT selector's currently-selected model,
 * keyed by `${kind}:${value}`. It persists across renders (and, in a
 * single-process test run, across test FILES) so a detached picker whose catalog
 * hasn't loaded yet can still render the selection's quant/footprint from the
 * last time it was resolved.
 */
const selectedModelMetadataCache = new Map<string, ModelInfo>();

/** Read the cached metadata for a `${kind}:${value}` key, or `null`. */
export function getCachedSelectedModel(key: string): ModelInfo | null {
	return selectedModelMetadataCache.get(key) ?? null;
}

/** Store the freshly-resolved metadata for a `${kind}:${value}` key. */
export function setCachedSelectedModel(key: string, model: ModelInfo): void {
	selectedModelMetadataCache.set(key, model);
}

/** Test-only: clear the module-level selected-model metadata cache. Many tests
 *  reuse `value="tiny"`, so a prior file's entry bleeds in and yields stale
 *  quant/footprint. Reset in `beforeEach`. */
export function _resetSelectedModelMetadataCacheForTests(): void {
	selectedModelMetadataCache.clear();
}
