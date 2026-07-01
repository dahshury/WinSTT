import { create, type UseBoundStore, type StoreApi } from "zustand";

/**
 * Shared factory for the simple OpenRouter modality catalogs (cloud STT and
 * cloud TTS pickers). Both fetch a live `output_modalities=…` listing on first
 * open and expose an identical scan/loading/reachable surface; the only
 * per-modality differences are the fetch function and the row normalization.
 *
 * The richer LLM catalog (`@/entities/llm-catalog`) has IndexedDB persistence
 * and background refresh, so it intentionally does NOT use this factory.
 */
export interface OpenRouterCatalogState<TModel> {
	error: string | null;
	isLoaded: boolean;
	isReachable: boolean;
	isScanning: boolean;
	models: TModel[];
	scanModels: (force?: boolean) => Promise<void>;
}

interface OpenRouterScanResult<TModel> {
	error?: string;
	models: TModel[];
	reachable: boolean;
}

interface CreateOpenRouterCatalogStoreConfig<TModel> {
	/** Live IPC scan for the modality (e.g. `fetchOpenRouterSttModels`). */
	fetchModels: () => Promise<OpenRouterScanResult<TModel>>;
	/** Coerce/default the raw rows (e.g. fill missing scores or voice lists). */
	normalizeModels: (models: TModel[]) => TModel[];
}

/**
 * Shared scan-state reducers for every OpenRouter / Ollama catalog store
 * (this factory plus the richer LLM stores). All catalogs land on the same
 * `error/isReachable/isScanning/isLoaded` surface, so a failed scan and a
 * successful scan map to identical partial state across the board.
 */
export function makeScanErrorState(err: unknown) {
	return {
		error: String(err),
		isReachable: false as const,
		isScanning: false as const,
		isLoaded: true as const,
	};
}

export function makeScanSuccessState<TModel>(result: {
	models: TModel[];
	reachable: boolean;
	error?: string | null;
}) {
	return {
		models: result.models,
		isReachable: result.reachable,
		error: result.error ?? null,
		isLoaded: true as const,
		isScanning: false as const,
	};
}

export function createOpenRouterCatalogStore<TModel>({
	fetchModels,
	normalizeModels,
}: CreateOpenRouterCatalogStoreConfig<TModel>): UseBoundStore<
	StoreApi<OpenRouterCatalogState<TModel>>
> {
	return create<OpenRouterCatalogState<TModel>>()((set, get) => ({
		models: [],
		isLoaded: false,
		isScanning: false,
		isReachable: false,
		error: null,
		scanModels: async (force = false) => {
			// Opening the combobox calls this with no args; `force` (e.g. right
			// after the API key is saved) refreshes the live provider list.
			if (get().isScanning || (!force && get().isLoaded)) {
				return;
			}
			set({ isScanning: true, error: null });
			try {
				const result = await fetchModels();
				set({
					models: normalizeModels(result.models),
					isReachable: result.reachable,
					error: result.error ?? null,
					isLoaded: true,
					isScanning: false,
				});
			} catch (err) {
				set(makeScanErrorState(err));
			}
		},
	}));
}
