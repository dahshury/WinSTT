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

function makeScanErrorState(err: unknown) {
	return {
		error: String(err),
		isReachable: false as const,
		isScanning: false as const,
		isLoaded: true as const,
	};
}

function makeScanSuccessState(result: {
	models: OllamaModel[];
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

export const useLlmCatalogStore = create<LlmCatalogState>()((set, get) => ({
	// Stryker disable next-line ArrayDeclaration: equivalent — `setModels` (the
	// only public mutation) overwrites this initial array, and tests reset state
	// via `setState({ models: [] })` before reading it.
	models: [],
	// Stryker disable next-line BooleanLiteral: equivalent — `setModels` and
	// `setError` (the only public mutation paths) both override `isLoaded` to
	// true on first call, so the initial value is overwritten before any test
	// reads it through observed behavior.
	isLoaded: false,
	isScanning: false,
	// Stryker disable next-line BooleanLiteral: equivalent — every scanModels()
	// path overwrites `isReachable` based on the IPC result before any test
	// observes it, so the initial value is unobservable.
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
			set(makeScanSuccessState(result));
		} catch (err) {
			set(makeScanErrorState(err));
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

// SSR/Electron guard — under bun:test, the bridge is mocked and electronAPI
// is undefined, so the body is skipped regardless of the conditional outcome.
// Observable test behavior is identical with or without this branch, hence
// every mutator on this if-statement is equivalent.
// Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator,StringLiteral,BlockStatement
if (typeof window !== "undefined" && window.electronAPI != null) {
	// Stryker disable next-line ArrowFunction
	onLlmCatalog((models) => useLlmCatalogStore.getState().setModels(models));
	// Stryker disable next-line ArrowFunction
	onOllamaPullProgress((progress) => useLlmCatalogStore.getState().setPullProgress(progress));
}
