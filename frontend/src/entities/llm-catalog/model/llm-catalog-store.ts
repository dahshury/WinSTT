"use client";

import { create } from "zustand";
import { fetchOllamaModels, onLlmCatalog } from "@/shared/api/ipc-client";

export interface OllamaModel {
	name: string;
	size: number;
	modifiedAt: string;
}

interface LlmCatalogState {
	models: OllamaModel[];
	isLoaded: boolean;
	isScanning: boolean;
	error: string | null;
	setModels: (models: OllamaModel[]) => void;
	setScanning: (scanning: boolean) => void;
	setError: (error: string | null) => void;
	scanModels: () => Promise<void>;
}

export const useLlmCatalogStore = create<LlmCatalogState>((set, get) => ({
	models: [],
	isLoaded: false,
	isScanning: false,
	error: null,
	setModels: (models) => set({ models, isLoaded: true, error: null }),
	setScanning: (scanning) => set({ isScanning: scanning }),
	setError: (error) => set({ error, isLoaded: true }),
	scanModels: async () => {
		set({ isScanning: true, error: null });
		try {
			const models = await fetchOllamaModels();
			set({ models, isLoaded: true, isScanning: false });
		} catch (err) {
			set({ error: String(err), isScanning: false, isLoaded: true });
		}
	},
}));

if (typeof window !== "undefined" && window.electronAPI != null) {
	onLlmCatalog((models) => useLlmCatalogStore.getState().setModels(models));
}
