import { create } from "zustand";
import { isRecord } from "@/shared/lib/is-record";
import {
	lookupModelsDev,
	MODELS_DEV_API_URL,
	type ModelsDevEntry,
	type ModelsDevIndex,
	parseModelsDevApi,
} from "../lib/models-dev";

const CACHE_KEY = "winstt:models-dev-index:v1";
const CACHE_VERSION = 1;
/** models.dev metadata (knowledge cutoff, release date) changes slowly. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface PersistedIndex {
	index: ModelsDevIndex;
	savedAt: number;
	version: number;
}

function readCache(): PersistedIndex | null {
	if (typeof window === "undefined" || !window.localStorage) {
		return null;
	}
	try {
		const raw = window.localStorage.getItem(CACHE_KEY);
		if (!raw) {
			return null;
		}
		const parsed: unknown = JSON.parse(raw);
		if (
			isRecord(parsed) &&
			parsed["version"] === CACHE_VERSION &&
			typeof parsed["savedAt"] === "number" &&
			isRecord(parsed["index"])
		) {
			return {
				index: parsed["index"] as ModelsDevIndex,
				savedAt: parsed["savedAt"],
				version: CACHE_VERSION,
			};
		}
	} catch {
		// Corrupt cache → treat as absent.
	}
	return null;
}

function writeCache(index: ModelsDevIndex): void {
	if (typeof window === "undefined" || !window.localStorage) {
		return;
	}
	try {
		const payload: PersistedIndex = {
			index,
			savedAt: Date.now(),
			version: CACHE_VERSION,
		};
		window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
	} catch {
		// Quota / private-mode → skip caching, enrichment still works this session.
	}
}

interface ModelsDevState {
	/** The parsed lookup index, or `null` until first load. */
	index: ModelsDevIndex | null;
	isLoading: boolean;
	error: string | null;
	/**
	 * Idempotently ensure the index is loaded: hydrate from the localStorage
	 * cache immediately, then fetch models.dev in the background when the cache is
	 * missing or stale. Never throws — offline just leaves `index` as whatever was
	 * cached (possibly `null`), and the hover card falls back to catalog data.
	 */
	ensureLoaded: () => void;
	/** Resolve one model against the loaded index (`null` when absent/unmatched). */
	lookup: (modelId: string, modelName?: string) => ModelsDevEntry | null;
}

async function fetchIndex(): Promise<ModelsDevIndex> {
	const res = await fetch(MODELS_DEV_API_URL, {
		headers: { accept: "application/json" },
	});
	if (!res.ok) {
		throw new Error(`models.dev responded ${res.status}`);
	}
	return parseModelsDevApi(await res.json());
}

export const useModelsDevStore = create<ModelsDevState>((set, get) => {
	const cached = readCache();
	let refreshStarted = false;

	async function refresh(): Promise<void> {
		if (refreshStarted) {
			return;
		}
		refreshStarted = true;
		set({ isLoading: true });
		try {
			const index = await fetchIndex();
			writeCache(index);
			set({ index, isLoading: false, error: null });
		} catch (err) {
			// Keep any stale index already hydrated from cache.
			set({
				isLoading: false,
				error: err instanceof Error ? err.message : "models.dev fetch failed",
			});
		}
	}

	return {
		index: cached?.index ?? null,
		isLoading: false,
		error: null,
		ensureLoaded: () => {
			const fresh =
				cached !== null && Date.now() - cached.savedAt < CACHE_TTL_MS;
			// Refresh when we have no cache or the cache is stale. A fresh cache is
			// already hydrated into `index`, so no network needed. `refresh()` is
			// idempotent (guarded by `refreshStarted`), so repeat calls are cheap.
			if (!fresh) {
				void refresh();
			}
		},
		lookup: (modelId, modelName) => {
			const index = get().index;
			return index ? lookupModelsDev(index, modelId, modelName) : null;
		},
	};
});
