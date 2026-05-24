import { create } from "zustand";
import {
	assessDictationFit as assessDictationFitIpc,
	assessOllamaFitOnServer,
	type FitAssessmentEntry,
	fetchLiveResources,
	type LiveResourcesEntry,
} from "@/shared/api/ipc-client";

/**
 * State held by the resource-aware fitness UI.
 *
 * ``liveResources`` is refreshed:
 *   - once when the settings panel opens (lazy, on first use of the store)
 *   - on demand via ``refresh()`` (manual button + after a model swap completes)
 *
 * It is *not* polled — per the design decision the picker rows render
 * against the most recent snapshot and the server-authoritative call
 * fires only on the actual selection click.
 */
export interface SystemResourcesStore {
	assessDictationFitOnServer: (
		modelId: string,
		quantization?: string,
		device?: string | null
	) => Promise<FitAssessmentEntry | null>;
	assessOllamaFitOnServer: (sizeBytes: number) => Promise<FitAssessmentEntry | null>;
	error: string | null;
	isLoading: boolean;
	lastFetchedAt: number | null;
	liveResources: LiveResourcesEntry | null;
	refresh: (forceRefresh?: boolean) => Promise<void>;
	reset: () => void;
}

export const useSystemResourcesStore = create<SystemResourcesStore>((set) => ({
	liveResources: null,
	isLoading: false,
	error: null,
	lastFetchedAt: null,

	async refresh(forceRefresh = false) {
		set({ isLoading: true, error: null });
		try {
			const snapshot = await fetchLiveResources(forceRefresh);
			set({
				liveResources: snapshot,
				isLoading: false,
				lastFetchedAt: Date.now(),
				error: snapshot === null ? "no-snapshot" : null,
			});
		} catch (err) {
			set({
				isLoading: false,
				error: err instanceof Error ? err.message : "unknown",
			});
		}
	},

	async assessDictationFitOnServer(modelId, quantization = "", device = null) {
		return await assessDictationFitIpc(modelId, quantization, device);
	},

	async assessOllamaFitOnServer(sizeBytes) {
		return await assessOllamaFitOnServer(sizeBytes);
	},

	reset() {
		set({ liveResources: null, isLoading: false, error: null, lastFetchedAt: null });
	},
}));
