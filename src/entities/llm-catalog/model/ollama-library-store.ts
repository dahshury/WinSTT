import { create } from "zustand";
import {
	fetchOllamaLibraryCatalog,
	fetchOllamaLibraryTags,
	fetchOllamaModelHit,
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

interface HitState {
	error: string | null;
	hit: OllamaLibraryHit | null;
	isLoading: boolean;
}

interface OllamaLibraryStoreState {
	catalog: readonly OllamaLibraryHit[];
	error: string | null;
	fetchHit: (model: string) => Promise<void>;
	fetchTags: (model: string) => Promise<void>;
	/** Per-base-slug homepage scrape (description / capabilities / pulls /
	 *  updated) for typed tags not in the recommended catalog. */
	hitsByModel: Readonly<Record<string, HitState>>;
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

/** Hit cache key is the BASE slug (tag stripped) so every tag of a model shares
 *  one homepage scrape: `gpt-oss:20b` and `gpt-oss:120b` → `gpt-oss`. */
export function hitCacheKey(model: string): string {
	const trimmed = model.trim().toLowerCase();
	const colon = trimmed.indexOf(":");
	return colon > 0 ? trimmed.slice(0, colon) : trimmed;
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

/** Gate for `fetchHit` — same semantics as {@link shouldSkipTagsFetch}: skip a
 *  duplicate in-flight scrape or a non-error cached hit, but allow retrying an
 *  errored one. */
export function shouldSkipHitFetch(existing: HitState | undefined): boolean {
	return Boolean(existing?.isLoading || (existing?.hit && !existing.error));
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

function buildPendingHitEntry(existing: HitState | undefined): HitState {
	return { isLoading: true, error: null, hit: existing?.hit ?? null };
}

function buildSettledHitEntry(hit: OllamaLibraryHit): HitState {
	// The Rust fetch never rejects — an unreachable homepage yields `{ name }`
	// with no description/capabilities, which the card renders as size-only.
	return { isLoading: false, error: null, hit };
}

function upsertHitsByModel(
	hitsByModel: Readonly<Record<string, HitState>>,
	key: string,
	entry: HitState,
): Readonly<Record<string, HitState>> {
	return { ...hitsByModel, [key]: entry };
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
		hitsByModel: {},

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

		fetchHit: async (model: string) => {
			const key = hitCacheKey(model);
			if (!key) {
				return;
			}
			const existing = get().hitsByModel[key];
			if (shouldSkipHitFetch(existing)) {
				return;
			}
			set((s) => ({
				hitsByModel: upsertHitsByModel(
					s.hitsByModel,
					key,
					buildPendingHitEntry(existing),
				),
			}));
			const hit = await fetchOllamaModelHit(model);
			set((s) => ({
				hitsByModel: upsertHitsByModel(
					s.hitsByModel,
					key,
					buildSettledHitEntry(hit),
				),
			}));
		},
	}),
);
