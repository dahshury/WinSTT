import { create } from "zustand";
import { fetchOpenRouterModels, type OpenRouterModel } from "@/shared/api/ipc-client";

interface OpenRouterCatalogState {
	error: string | null;
	isLoaded: boolean;
	isReachable: boolean;
	isScanning: boolean;
	models: OpenRouterModel[];
	scanModels: (force?: boolean) => Promise<void>;
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

export const useOpenRouterCatalogStore = create<OpenRouterCatalogState>()((set, get) => ({
	models: [],
	isLoaded: false,
	isScanning: false,
	isReachable: false,
	error: null,
	scanModels: async (force = false) => {
		// Opening the combobox calls this with no args — once the catalog is loaded,
		// reuse the cache instead of refetching (which spins + resets the list from
		// outside). `force` (e.g. right after the API key is saved) retries anyway.
		if (get().isScanning || (!force && get().isLoaded)) {
			return;
		}
		set({ isScanning: true, error: null });
		try {
			const result = await fetchOpenRouterModels();
			set(makeScanSuccessState(result));
		} catch (err) {
			set(makeScanErrorState(err));
		}
	},
}));
