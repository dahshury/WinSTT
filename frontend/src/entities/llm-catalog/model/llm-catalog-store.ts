"use client";

import { create } from "zustand";
import {
	cancelOllamaModelPull,
	deleteOllamaModel,
	fetchOllamaModels,
	type OllamaModel,
	type OllamaPullProgress,
	onLlmCatalog,
	onOllamaPullProgress,
	pullOllamaModel,
} from "@/shared/api/ipc-client";

export type { OllamaModel };

export interface PullState {
	progress: OllamaPullProgress;
	startedAt: number;
}

interface LlmCatalogState {
	cancelPull: (model: string) => Promise<void>;
	deleteModel: (model: string) => Promise<{ success: boolean; error?: string }>;
	error: string | null;
	isLoaded: boolean;
	isReachable: boolean;
	isScanning: boolean;
	models: OllamaModel[];
	pullModel: (model: string) => Promise<{ success: boolean; error?: string }>;
	pulls: Record<string, PullState>;
	scanModels: () => Promise<void>;
	setError: (error: string | null) => void;
	setModels: (models: OllamaModel[]) => void;
	setPullProgress: (progress: OllamaPullProgress) => void;
	setScanning: (scanning: boolean) => void;
}

const isTerminalStatus = (status: OllamaPullProgress["status"]): boolean =>
	status === "success" || status === "error" || status === "cancelled";

export const useLlmCatalogStore = create<LlmCatalogState>()((set, get) => ({
	models: [],
	isLoaded: false,
	isScanning: false,
	isReachable: false,
	error: null,
	pulls: {},
	setModels: (models) => set({ models, isLoaded: true, error: null }),
	setScanning: (scanning) => set({ isScanning: scanning }),
	setError: (error) => set({ error, isLoaded: true }),
	setPullProgress: (progress) => {
		const { pulls } = get();
		if (isTerminalStatus(progress.status)) {
			const next = { ...pulls };
			delete next[progress.model];
			set({ pulls: next });
			return;
		}
		set({
			pulls: {
				...pulls,
				[progress.model]: {
					progress,
					startedAt: pulls[progress.model]?.startedAt ?? Date.now(),
				},
			},
		});
	},
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
	pullModel: async (model) => {
		const { pulls } = get();
		if (pulls[model]) {
			return { success: false, error: "Already pulling" };
		}
		set({
			pulls: {
				...pulls,
				[model]: {
					progress: { model, status: "pulling", statusText: "starting" },
					startedAt: Date.now(),
				},
			},
		});
		const result = await pullOllamaModel(model);
		if (result.success) {
			await get().scanModels();
		}
		return { success: result.success, error: result.error };
	},
	cancelPull: async (model) => {
		await cancelOllamaModelPull(model);
	},
	deleteModel: async (model) => {
		const result = await deleteOllamaModel(model);
		if (result.success) {
			await get().scanModels();
		}
		return { success: result.success, error: result.error };
	},
}));

if (typeof window !== "undefined" && window.electronAPI != null) {
	onLlmCatalog((models) => useLlmCatalogStore.getState().setModels(models));
	onOllamaPullProgress((progress) => useLlmCatalogStore.getState().setPullProgress(progress));
}
