"use client";

import { create } from "zustand";
import { fetchOllamaModels, type OllamaModel, onLlmCatalog } from "@/shared/api/ipc-client";

export type { OllamaModel };

interface LlmCatalogState {
	models: OllamaModel[];
	isLoaded: boolean;
	isScanning: boolean;
	isReachable: boolean;
	error: string | null;
	setModels: (models: OllamaModel[]) => void;
	setScanning: (scanning: boolean) => void;
	setError: (error: string | null) => void;
	scanModels: () => Promise<void>;
}

export const useLlmCatalogStore = create<LlmCatalogState>()((set, get) => ({
	models: [],
	isLoaded: false,
	isScanning: false,
	isReachable: false,
	error: null,
	setModels: (models) => set({ models, isLoaded: true, error: null }),
	setScanning: (scanning) => set({ isScanning: scanning }),
	setError: (error) => set({ error, isLoaded: true }),
	scanModels: async () => {
		if (get().isScanning) {
			return;
		}
		set({ isScanning: true, error: null });
		try {
			const result = await fetchOllamaModels();
			set({
				models: result.models,
				isReachable: result.reachable,
				error: result.error ?? null,
				isLoaded: true,
				isScanning: false,
			});
		} catch (err) {
			set({
				error: String(err),
				isReachable: false,
				isScanning: false,
				isLoaded: true,
			});
		}
	},
}));

if (typeof window !== "undefined" && window.electronAPI != null) {
	onLlmCatalog((models) => useLlmCatalogStore.getState().setModels(models));
}
