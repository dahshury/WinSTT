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
 *   - when the settings panel / detached picker opens
 *   - while the main status bar's runtime chip is ready (light polling for the
 *     GPU/CPU fill meter)
 *   - on demand via ``refresh()`` after model-cache or swap events
 *
 * It is *not* polled — per the design decision the picker rows render
 * against the most recent snapshot and the server-authoritative call
 * fires only on the actual selection click.
 *
 * The main-window runtime chip is now the exception: it polls lightly while
 * visible so its RAM/VRAM fill stays current.
 */
export interface SystemResourcesStore {
	assessDictationFitOnServer: (
		modelId: string,
		quantization?: string,
		device?: string | null,
	) => Promise<FitAssessmentEntry | null>;
	assessOllamaFitOnServer: (
		sizeBytes: number,
	) => Promise<FitAssessmentEntry | null>;
	error: string | null;
	isLoading: boolean;
	lastFetchedAt: number | null;
	liveResources: LiveResourcesEntry | null;
	refresh: (forceRefresh?: boolean) => Promise<void>;
	reset: () => void;
}

type Setter = (
	partial:
		| Partial<SystemResourcesStore>
		| ((state: SystemResourcesStore) => Partial<SystemResourcesStore>),
) => void;

export function snapshotPatch(
	snapshot: LiveResourcesEntry | null,
): Partial<SystemResourcesStore> {
	return {
		liveResources: snapshot,
		isLoading: false,
		lastFetchedAt: Date.now(),
		error: snapshot === null ? "no-snapshot" : null,
	};
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : "unknown";
}

export function errorPatch(err: unknown): Partial<SystemResourcesStore> {
	return { isLoading: false, error: errorMessage(err) };
}

async function performRefresh(
	set: Setter,
	forceRefresh: boolean,
): Promise<void> {
	set({ isLoading: true, error: null });
	try {
		const snapshot = await fetchLiveResources(forceRefresh);
		set(snapshotPatch(snapshot));
	} catch (err) {
		set(errorPatch(err));
	}
}

export const useSystemResourcesStore = create<SystemResourcesStore>((set) => ({
	liveResources: null,
	isLoading: false,
	error: null,
	lastFetchedAt: null,

	async refresh(forceRefresh = false) {
		await performRefresh(set, forceRefresh);
	},

	async assessDictationFitOnServer(modelId, quantization = "", device = null) {
		return await assessDictationFitIpc(modelId, quantization, device);
	},

	async assessOllamaFitOnServer(sizeBytes) {
		return await assessOllamaFitOnServer(sizeBytes);
	},

	reset() {
		set({
			liveResources: null,
			isLoading: false,
			error: null,
			lastFetchedAt: null,
		});
	},
}));
