import { create } from "zustand";
import {
	fetchOpenRouterModels,
	type OpenRouterModel,
} from "@/shared/api/ipc-client";

const OPENROUTER_CATALOG_CACHE_DB = "winstt-openrouter-catalog";
const OPENROUTER_CATALOG_CACHE_STORE = "catalogs";
const OPENROUTER_CATALOG_CACHE_KEY = "llm-openrouter-v1";
const OPENROUTER_CATALOG_CACHE_VERSION = 1;
const OPENROUTER_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface PersistedOpenRouterCatalog {
	models: OpenRouterModel[];
	savedAt: number;
	version: typeof OPENROUTER_CATALOG_CACHE_VERSION;
}

interface OpenRouterCatalogState {
	error: string | null;
	isLoaded: boolean;
	isReachable: boolean;
	isScanning: boolean;
	models: OpenRouterModel[];
	scanModels: (force?: boolean) => Promise<void>;
	/**
	 * Hydrate from the persistent cache, then refresh stale/missing data in the
	 * background. This path intentionally never toggles `isScanning`, so merely
	 * visiting the settings tab or opening a selector does not replace the trigger
	 * with a loading state.
	 */
	warmModels: () => Promise<void>;
}

function makeScanErrorState(err: unknown) {
	return {
		error: String(err),
		isReachable: false as const,
		isScanning: false as const,
		isLoaded: true as const,
	};
}

function makeScanSuccessState(result: {
	models: OpenRouterModel[];
	reachable: boolean;
	error?: string;
}) {
	return {
		models: result.models,
		isReachable: result.reachable,
		error: result.error ?? null,
		isLoaded: true as const,
		isScanning: false as const,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isOpenRouterModel(value: unknown): value is OpenRouterModel {
	return (
		isRecord(value) &&
		typeof value["id"] === "string" &&
		typeof value["name"] === "string"
	);
}

function isPersistedOpenRouterCatalog(
	value: unknown,
): value is PersistedOpenRouterCatalog {
	return (
		isRecord(value) &&
		value["version"] === OPENROUTER_CATALOG_CACHE_VERSION &&
		typeof value["savedAt"] === "number" &&
		Array.isArray(value["models"]) &&
		value["models"].every(isOpenRouterModel)
	);
}

function getBrowserIndexedDb(): IDBFactory | null {
	if (typeof window === "undefined") {
		return null;
	}
	return window.indexedDB ?? null;
}

function openCacheDb(): Promise<IDBDatabase | null> {
	const indexedDb = getBrowserIndexedDb();
	if (indexedDb === null) {
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		const request = indexedDb.open(OPENROUTER_CATALOG_CACHE_DB, 1);
		request.onerror = () => resolve(null);
		request.onblocked = () => resolve(null);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(OPENROUTER_CATALOG_CACHE_STORE)) {
				db.createObjectStore(OPENROUTER_CATALOG_CACHE_STORE);
			}
		};
		request.onsuccess = () => resolve(request.result);
	});
}

async function readCachedCatalogFromIndexedDb(): Promise<PersistedOpenRouterCatalog | null> {
	const db = await openCacheDb();
	if (db === null) {
		return null;
	}
	return new Promise((resolve) => {
		const transaction = db.transaction(
			OPENROUTER_CATALOG_CACHE_STORE,
			"readonly",
		);
		const request = transaction
			.objectStore(OPENROUTER_CATALOG_CACHE_STORE)
			.get(OPENROUTER_CATALOG_CACHE_KEY);
		request.onerror = () => resolve(null);
		request.onsuccess = () => {
			const cached = request.result;
			resolve(isPersistedOpenRouterCatalog(cached) ? cached : null);
		};
		transaction.oncomplete = () => db.close();
		transaction.onerror = () => {
			db.close();
			resolve(null);
		};
	});
}

function readCachedCatalogFromLocalStorage(): PersistedOpenRouterCatalog | null {
	if (typeof window === "undefined" || !window.localStorage) {
		return null;
	}
	try {
		const raw = window.localStorage.getItem(OPENROUTER_CATALOG_CACHE_KEY);
		if (!raw) {
			return null;
		}
		const parsed: unknown = JSON.parse(raw);
		return isPersistedOpenRouterCatalog(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

async function readCachedCatalog(): Promise<PersistedOpenRouterCatalog | null> {
	return (
		(await readCachedCatalogFromIndexedDb()) ??
		readCachedCatalogFromLocalStorage()
	);
}

async function writeCachedCatalogToIndexedDb(
	catalog: PersistedOpenRouterCatalog,
): Promise<boolean> {
	const db = await openCacheDb();
	if (db === null) {
		return false;
	}
	return new Promise((resolve) => {
		const transaction = db.transaction(
			OPENROUTER_CATALOG_CACHE_STORE,
			"readwrite",
		);
		const request = transaction
			.objectStore(OPENROUTER_CATALOG_CACHE_STORE)
			.put(catalog, OPENROUTER_CATALOG_CACHE_KEY);
		request.onerror = () => resolve(false);
		transaction.oncomplete = () => {
			db.close();
			resolve(true);
		};
		transaction.onerror = () => {
			db.close();
			resolve(false);
		};
	});
}

function writeCachedCatalogToLocalStorage(
	catalog: PersistedOpenRouterCatalog,
): void {
	if (typeof window === "undefined" || !window.localStorage) {
		return;
	}
	try {
		window.localStorage.setItem(
			OPENROUTER_CATALOG_CACHE_KEY,
			JSON.stringify(catalog),
		);
	} catch {
		// Cache writes are best-effort; quota failures should never affect settings.
	}
}

async function writeCachedCatalog(
	models: readonly OpenRouterModel[],
): Promise<void> {
	const catalog: PersistedOpenRouterCatalog = {
		models: [...models],
		savedAt: Date.now(),
		version: OPENROUTER_CATALOG_CACHE_VERSION,
	};
	if (await writeCachedCatalogToIndexedDb(catalog)) {
		return;
	}
	writeCachedCatalogToLocalStorage(catalog);
}

function shouldCacheScanResult(result: {
	error?: string;
	models: OpenRouterModel[];
	reachable: boolean;
}): boolean {
	return result.reachable && !result.error && result.models.length > 0;
}

function isFreshCache(catalog: PersistedOpenRouterCatalog | null): boolean {
	return (
		catalog !== null &&
		Date.now() - catalog.savedAt < OPENROUTER_CATALOG_CACHE_TTL_MS
	);
}

type StoreSet = Partial<OpenRouterCatalogState>;
type StoreGet = () => OpenRouterCatalogState;

let cacheHydration: Promise<PersistedOpenRouterCatalog | null> | null = null;
let backgroundRefresh: Promise<void> | null = null;
let foregroundScan: Promise<void> | null = null;
let catalogMutationGeneration = 0;

function applyCachedCatalog(
	set: (partial: StoreSet) => void,
	get: StoreGet,
	catalog: PersistedOpenRouterCatalog | null,
): void {
	if (catalog === null || catalog.models.length === 0) {
		return;
	}
	const current = get();
	if (current.isLoaded || current.isScanning) {
		return;
	}
	set({
		models: catalog.models,
		isReachable: true,
		error: null,
		isLoaded: true,
	});
}

function ensureCacheHydration(
	set: (partial: StoreSet) => void,
	get: StoreGet,
): Promise<PersistedOpenRouterCatalog | null> {
	if (cacheHydration !== null) {
		return cacheHydration;
	}
	cacheHydration = readCachedCatalog()
		.then((catalog) => {
			applyCachedCatalog(set, get, catalog);
			return catalog;
		})
		.catch(() => null);
	return cacheHydration;
}

function applyBackgroundError(
	set: (partial: StoreSet) => void,
	get: StoreGet,
	err: unknown,
): void {
	if (get().models.length > 0) {
		return;
	}
	set(makeScanErrorState(err));
}

function refreshModelsInBackground(
	set: (partial: StoreSet) => void,
	get: StoreGet,
): Promise<void> {
	if (backgroundRefresh !== null) {
		return backgroundRefresh;
	}
	if (get().isScanning) {
		return Promise.resolve();
	}

	const generation = ++catalogMutationGeneration;
	const refresh = fetchOpenRouterModels()
		.then(async (result) => {
			if (generation !== catalogMutationGeneration || get().isScanning) {
				return;
			}
			if (!result.reachable && get().models.length > 0) {
				return;
			}
			set(makeScanSuccessState(result));
			if (shouldCacheScanResult(result)) {
				await writeCachedCatalog(result.models);
			}
		})
		.catch((err: unknown) => {
			if (generation === catalogMutationGeneration) {
				applyBackgroundError(set, get, err);
			}
		})
		.finally(() => {
			if (backgroundRefresh === refresh) {
				backgroundRefresh = null;
			}
		});
	backgroundRefresh = refresh;
	return refresh;
}

async function warmOpenRouterModels(
	set: (partial: StoreSet) => void,
	get: StoreGet,
): Promise<void> {
	const catalog = await ensureCacheHydration(set, get);
	if (isFreshCache(catalog)) {
		return;
	}
	await refreshModelsInBackground(set, get);
}

async function persistSuccessfulScan(result: {
	error?: string;
	models: OpenRouterModel[];
	reachable: boolean;
}): Promise<void> {
	if (shouldCacheScanResult(result)) {
		await writeCachedCatalog(result.models);
	}
}

function scanOpenRouterModelsInForeground(
	set: (partial: StoreSet) => void,
	get: StoreGet,
	force: boolean,
): Promise<void> {
	if (foregroundScan !== null) {
		return foregroundScan;
	}

	let trackedScan: Promise<void>;
	const scan = (async () => {
		if (get().isScanning || (!force && get().isLoaded)) {
			return;
		}
		if (!force) {
			if (get().isLoaded) {
				return;
			}
			const hydratedCatalog = await ensureCacheHydration(set, get);
			if (
				(hydratedCatalog !== null && hydratedCatalog.models.length > 0) ||
				get().isLoaded
			) {
				return;
			}
			if (backgroundRefresh !== null) {
				await backgroundRefresh;
				return;
			}
		}
		const generation = ++catalogMutationGeneration;
		set({ isScanning: true, error: null });
		try {
			const result = await fetchOpenRouterModels();
			if (generation === catalogMutationGeneration) {
				set(makeScanSuccessState(result));
				await persistSuccessfulScan(result);
			}
		} catch (err) {
			if (generation === catalogMutationGeneration) {
				set(makeScanErrorState(err));
			}
		}
	})();
	trackedScan = scan.finally(() => {
		if (foregroundScan === trackedScan) {
			foregroundScan = null;
		}
	});
	foregroundScan = trackedScan;
	return trackedScan;
}

export const useOpenRouterCatalogStore = create<OpenRouterCatalogState>()(
	(set, get) => ({
		models: [],
		isLoaded: false,
		isScanning: false,
		isReachable: false,
		error: null,
		scanModels: (force = false) =>
			scanOpenRouterModelsInForeground(set, get, force),
		warmModels: () => warmOpenRouterModels(set, get),
	}),
);
