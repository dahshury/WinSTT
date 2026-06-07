import { create } from "zustand";
import {
	fetchOllamaLibraryCatalog,
	fetchOllamaLibraryTags,
} from "@/shared/api/ipc-client";
import type {
	OllamaLibraryHit,
	OllamaLibraryTag,
	OllamaLibraryTagsResult,
} from "@/shared/api/models";

interface TagsState {
	error: string | null;
	isLoading: boolean;
	tags: readonly OllamaLibraryTag[];
}

interface OllamaLibraryStoreState {
	catalog: readonly OllamaLibraryHit[];
	error: string | null;
	fetchTags: (model: string) => Promise<void>;
	isLoaded: boolean;
	isLoading: boolean;
	loadCatalog: () => Promise<void>;
	tagsByModel: Readonly<Record<string, TagsState>>;
}

interface CatalogReadyState {
	catalog: readonly OllamaLibraryHit[];
	error: string | null;
	isLoaded: boolean;
	isLoading: boolean;
}

/** Normalize the model name into a stable cache key — empty string signals
 *  "skip the request" to the caller. */
export function tagsCacheKey(model: string): string {
	return model.trim().toLowerCase();
}

/** True when an in-flight catalog request would overlap an existing one or
 *  a previously-resolved one — used to gate `loadCatalog` against the
 *  multi-mount thundering herd. */
export function shouldSkipCatalogLoad(state: {
	isLoaded: boolean;
	isLoading: boolean;
}): boolean {
	return state.isLoaded || state.isLoading;
}

/** Gate for `fetchTags` so the picker doesn't re-hit ollama-registry. Skips when
 *  a fetch is already IN-FLIGHT (dedupes the burst of cards requesting the same
 *  base before any resolves — this was firing N concurrent scrapes per base, e.g.
 *  the same model fetched 5×) or when a non-error list is already cached. An
 *  errored entry is still allowed to retry. */
export function shouldSkipTagsFetch(existing: TagsState | undefined): boolean {
	return Boolean(
		existing?.isLoading || (existing?.tags.length && !existing.error),
	);
}

function buildCatalogReadyState(result: {
	hits: readonly OllamaLibraryHit[];
	error?: string;
}): CatalogReadyState {
	return {
		catalog: result.hits,
		isLoaded: true,
		isLoading: false,
		error: result.error ?? null,
	};
}

/** Build the optimistic in-flight tags entry for a model — preserves any
 *  previously-fetched tags so the UI doesn't flash empty during refresh. */
function buildPendingTagsEntry(existing: TagsState | undefined): TagsState {
	return {
		isLoading: true,
		error: null,
		tags: existing?.tags ?? [],
	};
}

/** Build the settled tags entry once the IPC result arrives. */
function buildSettledTagsEntry(result: OllamaLibraryTagsResult): TagsState {
	return {
		isLoading: false,
		error: result.error ?? null,
		tags: result.tags,
	};
}

/** Upsert a tags entry into the per-model map (immutable). */
function upsertTagsByModel(
	tagsByModel: Readonly<Record<string, TagsState>>,
	key: string,
	entry: TagsState,
): Readonly<Record<string, TagsState>> {
	return { ...tagsByModel, [key]: entry };
}

/**
 * Holds the full Ollama library scraped from `ollama.com/library` (currently
 * ~230 models), plus per-model tag-scrape state. The catalog is pulled once
 * per session — main-process cache holds it for an hour, renderer cache for
 * the lifetime of the window — and filtering happens client-side in the
 * picker. Mirrors how the OpenRouter store stages its catalog.
 */
export const useOllamaLibraryStore = create<OllamaLibraryStoreState>(
	(set, get) => ({
		catalog: [],
		error: null,
		isLoaded: false,
		isLoading: false,
		tagsByModel: {},

		loadCatalog: async () => {
			if (shouldSkipCatalogLoad(get())) {
				return;
			}
			set({ isLoading: true, error: null });
			const result = await fetchOllamaLibraryCatalog();
			set(buildCatalogReadyState(result));
		},

		fetchTags: async (model: string) => {
			const key = tagsCacheKey(model);
			if (!key) {
				return;
			}
			const existing = get().tagsByModel[key];
			if (shouldSkipTagsFetch(existing)) {
				return;
			}
			set((s) => ({
				tagsByModel: upsertTagsByModel(
					s.tagsByModel,
					key,
					buildPendingTagsEntry(existing),
				),
			}));
			const result: OllamaLibraryTagsResult =
				await fetchOllamaLibraryTags(model);
			set((s) => ({
				tagsByModel: upsertTagsByModel(
					s.tagsByModel,
					key,
					buildSettledTagsEntry(result),
				),
			}));
		},
	}),
);
