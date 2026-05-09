"use client";

import { create } from "zustand";
import { fetchOpenRouterModels, type OpenRouterModel } from "@/shared/api/ipc-client";

interface OpenRouterCatalogState {
	error: string | null;
	isLoaded: boolean;
	isReachable: boolean;
	isScanning: boolean;
	models: OpenRouterModel[];
	scanModels: () => Promise<void>;
}

export const useOpenRouterCatalogStore = create<OpenRouterCatalogState>()((set, get) => ({
	models: [],
	isLoaded: false,
	isScanning: false,
	isReachable: false,
	error: null,
	scanModels: async () => {
		if (get().isScanning) {
			return;
		}
		set({ isScanning: true, error: null });
		try {
			const result = await fetchOpenRouterModels();
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
