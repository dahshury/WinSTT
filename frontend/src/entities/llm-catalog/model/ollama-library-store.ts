import { create } from "zustand";
import { fetchOllamaLibraryCatalog, fetchOllamaLibraryTags } from "@/shared/api/ipc-client";
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

/**
 * Holds the full Ollama library scraped from `ollama.com/library` (currently
 * ~230 models), plus per-model tag-scrape state. The catalog is pulled once
 * per session — main-process cache holds it for an hour, renderer cache for
 * the lifetime of the window — and filtering happens client-side in the
 * picker. Mirrors how the OpenRouter store stages its catalog.
 */
export const useOllamaLibraryStore = create<OllamaLibraryStoreState>((set, get) => ({
	catalog: [],
	error: null,
	isLoaded: false,
	isLoading: false,
	tagsByModel: {},

	loadCatalog: async () => {
		const state = get();
		if (state.isLoaded || state.isLoading) {
			return;
		}
		set({ isLoading: true, error: null });
		const result = await fetchOllamaLibraryCatalog();
		set({
			catalog: result.hits,
			isLoaded: true,
			isLoading: false,
			error: result.error ?? null,
		});
	},

	fetchTags: async (model: string) => {
		const key = model.trim().toLowerCase();
		if (!key) {
			return;
		}
		const existing = get().tagsByModel[key];
		if (existing?.tags.length && !existing.error) {
			return;
		}
		set((s) => ({
			tagsByModel: {
				...s.tagsByModel,
				[key]: { isLoading: true, error: null, tags: existing?.tags ?? [] },
			},
		}));
		const result: OllamaLibraryTagsResult = await fetchOllamaLibraryTags(model);
		set((s) => ({
			tagsByModel: {
				...s.tagsByModel,
				[key]: {
					isLoading: false,
					error: result.error ?? null,
					tags: result.tags,
				},
			},
		}));
	},
}));
